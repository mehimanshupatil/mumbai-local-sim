/**
 * Bake real Western Railway timetable data from the raw PDF extraction
 * (scripts/extract-timetable-pdfs.py) into committed JSON.
 *
 * Pipeline: run the Python extractor whenever WR publishes a new PTT (drop
 * the new PDFs in data/timetable/, re-run both scripts) to refresh
 * scripts/.cache/timetable-raw.json, then `pnpm bake:realtimetable` maps
 * station names to network ids, repairs known extraction noise, splits
 * round-trip diagrams (the Dahanu PTT prints a down leg then its immediate
 * return as one column), classifies each run, and validates against known
 * reality before committing.
 *
 * Usage: pnpm bake:realtimetable
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import westernJson from '../src/data/western.json'
import type { NetworkData } from '../src/data/network-types'
import type { Direction, ServiceType } from '../src/sim/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW_PATH = join(ROOT, 'scripts', '.cache', 'timetable-raw.json')
const OUT_PATH = join(ROOT, 'src', 'data', 'western-real-timetable.json')

const network = westernJson as NetworkData

interface RawStop {
  stationId: string // display name from the Python extractor, e.g. "Mumbai Central"
  timeSeconds: number
}
interface RawTrain {
  source: string
  page: number
  direction: 'down' | 'up'
  trainNumber: string
  route: string | null
  cars: number | null
  serviceHint: 'ac' | null
  stops: RawStop[]
  notes: string[]
}

export interface RealStop {
  stationId: string
  /** Seconds since midnight; departure (arrival for the final stop). */
  t: number
}
export interface RealService {
  id: string
  serviceType: ServiceType
  direction: Direction
  track: number
  cars: number | null
  stops: RealStop[]
}

const stationByName = new Map(network.stations.map((s) => [s.name, s]))
const stationOf = (name: string) => {
  const s = stationByName.get(name)
  if (!s) throw new Error(`unknown station in extracted data: "${name}"`)
  return s
}
const chainageOf = (name: string): number => stationOf(name).chainageM
/**
 * Split a raw stop list into maximal chainage-monotonic runs. Almost every
 * train is one run; the Dahanu PTT prints a down leg immediately followed
 * by its return leg in the same column, which shows up as one clean
 * direction reversal at the far end.
 */
interface SplitResult {
  runs: RawStop[][]
  /** Fragments too short to be a real service (e.g. a trailing reversal
   * anchor with nothing after it) — tracked so the caller can gate on an
   * unexpectedly high drop rate instead of losing them silently. */
  tooShortDropped: number
}

function splitIntoRuns(stops: RawStop[]): SplitResult {
  const runs: RawStop[][] = []
  let current: RawStop[] = []
  let dir: 1 | -1 | 0 = 0
  for (const stop of stops) {
    if (current.length === 0) {
      current.push(stop)
      continue
    }
    const prevChain = chainageOf(current[current.length - 1].stationId)
    const chain = chainageOf(stop.stationId)
    const step = chain === prevChain ? 0 : chain > prevChain ? 1 : -1
    if (step === 0) continue // duplicate row, ignore
    if (dir === 0) dir = step
    if (step !== dir) {
      runs.push(current)
      current = [current[current.length - 1], stop] // the reversal point anchors both legs
      dir = 0
      continue
    }
    current.push(stop)
  }
  if (current.length > 0) runs.push(current)
  const kept = runs.filter((r) => r.length >= 2)
  return { runs: kept, tooShortDropped: runs.length - kept.length }
}

/**
 * Repair a run into strictly increasing SimTime seconds. Two distinct
 * things happen here:
 *  - Genuine midnight crossings (a service running e.g. 23:38 -> 00:04):
 *    the PDF prints wall-clock HH:MM, which wraps to a small number: we
 *    accumulate a running +86400 offset so the stored sequence keeps
 *    increasing past 24h, matching how SimTime is used everywhere else.
 *  - Single-cell misreads from tight column spacing (~1 in 1,468 trains in
 *    the source data): a stop that still doesn't increase after the wrap
 *    correction is noise, not a schedule feature — drop it.
 * Real multi-leg reversals (the Dahanu round-trip diagrams) are already
 * split out by splitIntoRuns before this runs, so every remaining backward
 * jump here is one of the two cases above.
 */
function repairMonotonic(stops: RawStop[]): RawStop[] {
  const out: RawStop[] = [{ ...stops[0] }]
  let offset = 0
  for (let i = 1; i < stops.length; i++) {
    const last = out[out.length - 1]
    let t = stops[i].timeSeconds + offset
    if (t - last.timeSeconds < -20 * 3600) {
      offset += 86400
      t += 86400
    }
    if (t > last.timeSeconds) out.push({ stationId: stops[i].stationId, timeSeconds: t })
  }
  return out
}

/**
 * Real WR services split into two clear regimes, not a spectrum: locals
 * with a handful of incidental skips (an express Churchgate hop, the
 * frequently-skipped Ram Mandir halt — 1-8 skipped stations in the baked
 * data) and genuine fast-pattern trains (9-20 skips). "Any skip = fast"
 * would lump the former in with the latter; this counts total skipped
 * stations across the run and only calls it fast past the gap between
 * those two clusters.
 */
const FAST_SKIP_THRESHOLD = 7

function countSkippedStations(run: RawStop[]): number {
  const chains = network.stations.map((s) => s.chainageM)
  let skipped = 0
  for (let i = 1; i < run.length; i++) {
    const a = chainageOf(run[i - 1].stationId)
    const b = chainageOf(run[i].stationId)
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    skipped += chains.filter((c) => c > lo && c < hi).length
  }
  return skipped
}

function classifyServiceType(run: RawStop[], isAc: boolean): ServiceType {
  if (isAc) return 'ac'
  return countSkippedStations(run) > FAST_SKIP_THRESHOLD ? 'fast' : 'slow'
}

// Semantic track lanes, matching src/sim/types.ts (kept independent — this
// bake script must stay decoupled from the synthetic scheduler module).
const TRACK_SLOW_DOWN = 0
const TRACK_SLOW_UP = 1
const TRACK_FAST_DOWN = 2
const TRACK_FAST_UP = 3

function trackFor(serviceType: ServiceType, direction: Direction): number {
  const fast = serviceType === 'fast'
  if (direction === 'down') return fast ? TRACK_FAST_DOWN : TRACK_SLOW_DOWN
  return fast ? TRACK_FAST_UP : TRACK_SLOW_UP
}

function main() {
  const raw: RawTrain[] = JSON.parse(readFileSync(RAW_PATH, 'utf8'))
  const services: RealService[] = []
  let runsFromReversal = 0
  let stopsRepaired = 0
  let totalRawStops = 0
  let runsDroppedTooShort = 0

  for (const train of raw) {
    totalRawStops += train.stops.length
    const isAc =
      train.serviceHint === 'ac' ||
      train.trainNumber.startsWith('94') ||
      train.notes.some((n) => /AIR|CONDITION/i.test(n))

    const { runs: rawRuns, tooShortDropped } = splitIntoRuns(train.stops)
    runsDroppedTooShort += tooShortDropped
    if (rawRuns.length > 1) runsFromReversal += rawRuns.length - 1

    rawRuns.forEach((run, i) => {
      const before = run.length
      const repaired = repairMonotonic(run)
      stopsRepaired += before - repaired.length
      if (repaired.length < 2) {
        runsDroppedTooShort++
        return
      }

      const firstChain = chainageOf(repaired[0].stationId)
      const lastChain = chainageOf(repaired[repaired.length - 1].stationId)
      const direction: Direction = lastChain >= firstChain ? 'down' : 'up'
      const serviceType = classifyServiceType(repaired, isAc)

      services.push({
        id: rawRuns.length > 1 ? `${train.trainNumber}-${i}` : train.trainNumber,
        serviceType,
        direction,
        track: trackFor(serviceType, direction),
        cars: train.cars,
        stops: repaired.map((s) => ({
          stationId: stationOf(s.stationId).id,
          t: s.timeSeconds,
        })),
      })
    })
  }

  // --- validate against known reality before committing ---
  const problems: string[] = []
  if (services.length < 1000) problems.push(`only ${services.length} services — extraction likely regressed`)
  for (const svc of services) {
    for (let i = 1; i < svc.stops.length; i++) {
      if (svc.stops[i].t <= svc.stops[i - 1].t) {
        problems.push(`${svc.id}: non-increasing time at stop ${i}`)
        break
      }
    }
  }
  const acCount = services.filter((s) => s.serviceType === 'ac').length
  if (acCount < 50) problems.push(`only ${acCount} AC services — expected 100+`)
  const stationById = new Map(network.stations.map((s) => [s.id, s]))
  const downSlowTermini = new Map<string, number>()
  for (const s of services) {
    // 'express' is unreachable from this dataset — real suburban PTTs carry
    // only EMU locals/ACs, never mainline mail/express timings — but the
    // filter stays defensive against that classification ever changing.
    if (s.direction !== 'down' || s.serviceType === 'express') continue
    const lastId = s.stops[s.stops.length - 1].stationId
    const last = stationById.get(lastId)
    if (!last) throw new Error(`service ${s.id}: unknown terminus station id "${lastId}"`)
    downSlowTermini.set(last.name, (downSlowTermini.get(last.name) ?? 0) + 1)
  }
  if ((downSlowTermini.get('Borivali') ?? 0) < (downSlowTermini.get('Andheri') ?? 0)) {
    problems.push('Borivali is not the dominant down turnback terminus — check against real WR pattern')
  }
  // Repairs and drops are expected (tight-column misreads, reversal
  // anchors) but should stay rare; a spike means the extraction or the
  // repair heuristics broke on this run of the PDFs, not the data itself.
  if (stopsRepaired / totalRawStops > 0.02) {
    problems.push(
      `repaired ${stopsRepaired}/${totalRawStops} stops (${((stopsRepaired / totalRawStops) * 100).toFixed(1)}%) — expected <2%, extraction may have regressed`,
    )
  }
  if (runsDroppedTooShort > raw.length * 0.05) {
    problems.push(`dropped ${runsDroppedTooShort} runs as too-short out of ${raw.length} trains — expected <5%`)
  }
  if (problems.length > 0) {
    throw new Error(`real timetable failed validation:\n  ${problems.join('\n  ')}`)
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        source: 'Western Railway Public Time Tables, W.E.F. 01.05.2026',
        bakedAt: new Date().toISOString().slice(0, 10),
        services,
      },
      null,
      0,
    ),
  )
  console.log(`${services.length} services (${runsFromReversal} split from round-trip diagrams)`)
  console.log(`repaired ${stopsRepaired}/${totalRawStops} noise stops, dropped ${runsDroppedTooShort} too-short runs`)
  console.log(`AC: ${acCount}, down turnbacks:`, Object.fromEntries(downSlowTermini))
  console.log(`wrote ${OUT_PATH}`)
}

main()
