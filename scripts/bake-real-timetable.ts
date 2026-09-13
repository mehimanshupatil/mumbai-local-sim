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
  /** The Line this Service is booked on — see src/sim/types.ts LINE_*. */
  lineId: number
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

/**
 * The PTT publishes times to the minute, so two services on the same line can
 * be printed at the identical station-minute — and taking that literally puts
 * them at the same second, 0 m apart, on top of each other.
 *
 * Each service is shifted by a whole number of seconds inside its own
 * published minute, the same shift at every one of its stops so legs are
 * untouched, chosen to hold it as far as possible from services already
 * placed at the same station-minute on the same line. A service nudged to
 * 09:14:20 still *shows* 09:14: the published data has 60 s granularity and
 * this resolves an ambiguity it never expressed rather than contradicting it.
 * A headway hold *would* contradict it, which is why holds are out of scope.
 *
 * Greedy and order-dependent, so services are placed in a fixed order and the
 * whole pass is deterministic: same input, byte-identical output.
 */
const MINUTE_S = 60

function deRoundWithinMinute(services: RealService[]): void {
  /** Times already claimed, by line, station and published minute. */
  const claimed = new Map<string, number[]>()
  const key = (lineId: number, stationId: string, t: number) =>
    `${lineId}:${stationId}:${Math.floor(t / MINUTE_S)}`
  const neighbours = (lineId: number, stationId: string, t: number) => {
    const minute = Math.floor(t / MINUTE_S)
    const out: number[] = []
    for (const m of [minute - 1, minute, minute + 1]) {
      const held = claimed.get(`${lineId}:${stationId}:${m}`)
      if (held) out.push(...held)
    }
    return out
  }
  for (const svc of [...services].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let bestOffset = 0
    let bestGap = -1
    for (let offset = 0; offset < MINUTE_S; offset++) {
      let gap = Infinity
      for (const stop of svc.stops) {
        for (const other of neighbours(svc.lineId, stop.stationId, stop.t)) {
          gap = Math.min(gap, Math.abs(stop.t + offset - other))
        }
      }
      if (gap > bestGap) {
        bestGap = gap
        bestOffset = offset
      }
      if (gap === Infinity) break // nothing to avoid; the first offset will do
    }
    for (const stop of svc.stops) {
      stop.t += bestOffset
      const k = key(svc.lineId, stop.stationId, stop.t)
      const held = claimed.get(k)
      if (held) held.push(stop.t)
      else claimed.set(k, [stop.t])
    }
  }
}

/**
 * Same-line pairs that genuinely cross — one passes the other between two
 * stations they share. Separating those needs holds longer than the published
 * minute can absorb, which would move a service off its printed time, so they
 * are counted and left alone rather than resolved (see #22, #24).
 */
function countOvertakingPairs(services: RealService[]): number {
  const byLine = new Map<number, RealService[]>()
  for (const svc of services) {
    const line = byLine.get(svc.lineId)
    if (line) line.push(svc)
    else byLine.set(svc.lineId, [svc])
  }
  let overtakes = 0
  for (const line of byLine.values()) {
    for (let i = 0; i < line.length; i++) {
      const a = new Map(line[i].stops.map((s) => [s.stationId, s.t]))
      for (let j = i + 1; j < line.length; j++) {
        let sign = 0
        let crossed = false
        for (const stop of line[j].stops) {
          const t = a.get(stop.stationId)
          if (t === undefined) continue
          const next = Math.sign(t - stop.t)
          if (next === 0) continue
          if (sign !== 0 && next !== sign) {
            crossed = true
            break
          }
          sign = next
        }
        if (crossed) overtakes++
      }
    }
  }
  return overtakes
}

/**
 * A leg no train could have run: long enough to be a real gap, yet implying a
 * crawl. The 989xx short-workings carry 75-80 minute legs over 4-8 km, which
 * is the grid extraction picking a time out of an adjacent train's column
 * where the source cell is blank or dashed.
 *
 * Dropped rather than repaired — repairing means inventing a departure time
 * the PDF does not contain, and the same file already drops runs it cannot
 * read (see runsDroppedTooShort).
 */
const IMPOSSIBLE_LEG_S = 900
const IMPOSSIBLE_LEG_KMH = 15
/** Committed count. A new PTT that pushes it up should break the bake rather
 * than quietly ship trains crawling the corridor for over an hour. */
const IMPOSSIBLE_SERVICES_EXPECTED = 66

function hasImpossibleLeg(run: RawStop[]): boolean {
  for (let i = 1; i < run.length; i++) {
    const secs = run[i].timeSeconds - run[i - 1].timeSeconds
    if (secs <= IMPOSSIBLE_LEG_S) continue
    const distM = Math.abs(chainageOf(run[i].stationId) - chainageOf(run[i - 1].stationId))
    if ((distM / secs) * 3.6 < IMPOSSIBLE_LEG_KMH) return true
  }
  return false
}

/** Skips enough intermediate stations to be running as a fast. */
function isFastPattern(run: RawStop[]): boolean {
  return countSkippedStations(run) > FAST_SKIP_THRESHOLD
}

function classifyServiceType(run: RawStop[], isAc: boolean): ServiceType {
  if (isAc) return 'ac' // a livery, not a calling pattern — see lineFor
  return isFastPattern(run) ? 'fast' : 'slow'
}

// The Lines, matching src/sim/types.ts (kept independent — this bake script
// must stay decoupled from the synthetic scheduler module).
const LINE_SLOW_DOWN = 0
const LINE_SLOW_UP = 1
const LINE_FAST_DOWN = 2
const LINE_FAST_UP = 3

/**
 * Which pair of lines a service runs on. Taken from the calling pattern, not
 * from the service type: 'ac' is a livery, and a real WR AC local runs both
 * fast and slow workings. Keyed off serviceType alone, every AC service went
 * on the slow pair — including the half of them that skip as many stations as
 * a classified fast, which then sat on the same rails as the stopping trains
 * they are timetabled to overtake.
 */
function lineFor(serviceType: ServiceType, direction: Direction, run: RawStop[]): number {
  const fast = serviceType === 'fast' || isFastPattern(run)
  if (direction === 'down') return fast ? LINE_FAST_DOWN : LINE_SLOW_DOWN
  return fast ? LINE_FAST_UP : LINE_SLOW_UP
}

/**
 * A handful of AC services are printed twice: once inline in the main
 * DN/UP PTT for context, again in full in the dedicated DN-AC/UP-AC PTT.
 * Both copies carry identical stop times, so de-duplicate by train number +
 * direction + the exact stop sequence rather than dropping anything a
 * genuinely distinct working might share a train number with.
 */
function dedupeRawTrains(raw: RawTrain[]): RawTrain[] {
  const seen = new Set<string>()
  const out: RawTrain[] = []
  for (const train of raw) {
    const signature = `${train.trainNumber}|${train.direction}|${train.stops
      .map((s) => `${s.stationId}@${s.timeSeconds}`)
      .join(',')}`
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push(train)
  }
  return out
}

function main() {
  const rawAll: RawTrain[] = JSON.parse(readFileSync(RAW_PATH, 'utf8'))
  const raw = dedupeRawTrains(rawAll)
  const services: RealService[] = []
  let runsFromReversal = 0
  let stopsRepaired = 0
  let totalRawStops = 0
  let runsDroppedTooShort = 0
  let runsDroppedImpossible = 0

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
      if (hasImpossibleLeg(repaired)) {
        runsDroppedImpossible++
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
        lineId: lineFor(serviceType, direction, repaired),
        cars: train.cars,
        // Sub-minute offsets are applied once every service is in (see
        // deRoundWithinMinute) — it needs to see them all to place them apart.
        stops: repaired.map((s) => ({
          stationId: stationOf(s.stationId).id,
          t: s.timeSeconds,
        })),
      })
    })
  }

  // A rare few train numbers cover two genuinely different real workings on
  // the same PTT (e.g. 92218 is both a 12:13 Virar-origin and a 14:47
  // Borivali-origin) — not an extraction artifact, WR really printed it
  // that way. Disambiguate rather than merge or drop either; the count is
  // logged and gated below so a sudden jump still fails loudly.
  const seenIds = new Map<string, number>()
  let idsDisambiguated = 0
  for (const svc of services) {
    const n = (seenIds.get(svc.id) ?? 0) + 1
    seenIds.set(svc.id, n)
    if (n > 1) {
      svc.id = `${svc.id}-${n}`
      idsDisambiguated++
    }
  }

  deRoundWithinMinute(services)
  const overtakingPairs = countOvertakingPairs(services)

  // --- validate against known reality before committing ---
  const problems: string[] = []
  if (services.length < 1000) problems.push(`only ${services.length} services — extraction likely regressed`)
  if (idsDisambiguated > 5) {
    problems.push(`${idsDisambiguated} duplicate train numbers — expected at most a handful, check for a regression`)
  }
  const finalIdCounts = new Map<string, number>()
  for (const svc of services) finalIdCounts.set(svc.id, (finalIdCounts.get(svc.id) ?? 0) + 1)
  if ([...finalIdCounts.values()].some((n) => n > 1)) {
    problems.push('service ids still not unique after disambiguation — this is a bug in the disambiguation step')
  }
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
  if (runsDroppedImpossible > IMPOSSIBLE_SERVICES_EXPECTED) {
    problems.push(
      `dropped ${runsDroppedImpossible} runs with an impossible leg, over the committed ${IMPOSSIBLE_SERVICES_EXPECTED} — ` +
        `this PTT reads worse than the last one, check the extraction before raising the threshold`,
    )
  }
  if (problems.length > 0) {
    throw new Error(`real timetable failed validation:\n  ${problems.join('\n  ')}`)
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        source: 'Western Railway Public Time Tables, PTT 79, W.E.F. 01.09.2026',
        bakedAt: new Date().toISOString().slice(0, 10),
        services,
      },
      null,
      0,
    ),
  )
  console.log(`${services.length} services (${runsFromReversal} split from round-trip diagrams)`)
  console.log(`repaired ${stopsRepaired}/${totalRawStops} noise stops, dropped ${runsDroppedTooShort} too-short runs`)
  console.log(
    `dropped ${runsDroppedImpossible} runs with a leg over ${IMPOSSIBLE_LEG_S}s implying under ${IMPOSSIBLE_LEG_KMH} km/h`,
  )
  console.log(
    `${overtakingPairs} same-line pairs genuinely cross — left as published, they need holds longer than a minute`,
  )
  console.log(`AC: ${acCount}, down turnbacks:`, Object.fromEntries(downSlowTermini))
  console.log(`wrote ${OUT_PATH}`)
}

main()
