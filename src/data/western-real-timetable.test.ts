import { describe, expect, it } from 'vitest'
import type { NetworkData } from './network-types'
import westernJson from './western.json'
import realTimetableJson from './western-real-timetable.json'

const network = westernJson as NetworkData
const timetable = realTimetableJson as {
  source: string
  bakedAt: string
  services: {
    id: string
    serviceType: string
    direction: string
    lineId: number
    cars: number | null
    stops: { stationId: string; t: number }[]
  }[]
}

const stationIds = new Set(network.stations.map((s) => s.id))
const chainageOf = new Map(network.stations.map((s) => [s.id, s.chainageM]))
/** Stations a service runs through without stopping — the fast/slow tell. */
const skippedStations = (stops: { stationId: string }[]) => {
  const chains = network.stations.map((s) => s.chainageM)
  let skipped = 0
  for (let i = 1; i < stops.length; i++) {
    const a = chainageOf.get(stops[i - 1].stationId)!
    const b = chainageOf.get(stops[i].stationId)!
    const [lo, hi] = a < b ? [a, b] : [b, a]
    skipped += chains.filter((c) => c > lo && c < hi).length
  }
  return skipped
}
/** Same threshold the bake classifies on (scripts/bake-real-timetable.ts). */
const FAST_SKIP_THRESHOLD = 7

describe('baked real timetable (WR Public Time Tables)', () => {
  it('has provenance and a substantial number of services', () => {
    expect(timetable.source).toMatch(/Western Railway/)
    expect(timetable.bakedAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(timetable.services.length).toBeGreaterThan(1000)
  })

  it('references only known network stations', () => {
    for (const svc of timetable.services) {
      for (const stop of svc.stops) {
        expect(stationIds.has(stop.stationId), `${svc.id}: ${stop.stationId}`).toBe(true)
      }
    }
  })

  it('has at least two stops per service, strictly increasing in time', () => {
    for (const svc of timetable.services) {
      expect(svc.stops.length, svc.id).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < svc.stops.length; i++) {
        expect(svc.stops[i].t, `${svc.id} stop ${i}`).toBeGreaterThan(svc.stops[i - 1].t)
      }
    }
  })

  // The PTT prints times to the minute, so two services on the same line can
  // be published at the identical station-minute — 396 stop events were, and
  // taking that literally put them at the same second, 0 m apart. The bake
  // shifts each service within its own published minute (#22): the same whole
  // number of seconds at every one of its stops, so legs are untouched and the
  // minute it displays is unchanged.
  it('shifts each service by one offset inside its own published minute', () => {
    for (const svc of timetable.services) {
      const offsets = new Set(svc.stops.map((s) => ((s.t % 60) + 60) % 60))
      expect(offsets.size, `${svc.id} has stops shifted by different amounts`).toBe(1)
      const [offset] = [...offsets]
      expect(offset, svc.id).toBeGreaterThanOrEqual(0)
      expect(offset, svc.id).toBeLessThan(60)
    }
  })

  it('leaves no two same-line services arriving within 10 s of each other', () => {
    const events = new Map<string, { id: string; t: number }[]>()
    for (const svc of timetable.services) {
      for (const stop of svc.stops) {
        const key = `${svc.lineId}:${stop.stationId}`
        const list = events.get(key)
        if (list) list.push({ id: svc.id, t: stop.t })
        else events.set(key, [{ id: svc.id, t: stop.t }])
      }
    }
    const tooClose: string[] = []
    for (const list of events.values()) {
      list.sort((a, b) => a.t - b.t)
      for (let i = 1; i < list.length; i++) {
        if (list[i].t - list[i - 1].t < 10) tooClose.push(`${list[i - 1].id}/${list[i].id}`)
      }
    }
    expect(tooClose, tooClose.slice(0, 5).join(', ')).toHaveLength(0)
  })

  // A leg long enough to be a real gap yet implying a crawl is the grid
  // extraction reading a time out of an adjacent train's column. 66 such
  // services were shipping before #21, one of them covering 1.5 km in twelve
  // hours, and they were the largest single source of same-line overlap.
  it('has no service crawling the corridor on an impossible leg', () => {
    const offenders: string[] = []
    for (const svc of timetable.services) {
      for (let i = 1; i < svc.stops.length; i++) {
        const secs = svc.stops[i].t - svc.stops[i - 1].t
        if (secs <= 900) continue
        const distM = Math.abs(
          chainageOf.get(svc.stops[i].stationId)! - chainageOf.get(svc.stops[i - 1].stationId)!,
        )
        const kmh = (distM / secs) * 3.6
        if (kmh < 15) {
          offenders.push(`${svc.id} ${svc.stops[i - 1].stationId}->${svc.stops[i].stationId} ${secs}s ${kmh.toFixed(1)} km/h`)
        }
      }
    }
    expect(offenders, offenders.slice(0, 5).join('; ')).toHaveLength(0)
  })

  it('has stop chainage strictly monotonic in the direction of travel', () => {
    for (const svc of timetable.services) {
      const chains = svc.stops.map((s) => chainageOf.get(s.stationId)!)
      for (let i = 1; i < chains.length; i++) {
        if (svc.direction === 'down') {
          expect(chains[i], `${svc.id} stop ${i}`).toBeGreaterThan(chains[i - 1])
        } else {
          expect(chains[i], `${svc.id} stop ${i}`).toBeLessThan(chains[i - 1])
        }
      }
    }
  })

  it('has a plausible mix of service types', () => {
    const counts = { slow: 0, fast: 0, ac: 0, express: 0 }
    for (const svc of timetable.services) counts[svc.serviceType as keyof typeof counts]++
    expect(counts.slow).toBeGreaterThan(500)
    expect(counts.fast).toBeGreaterThan(50)
    expect(counts.ac).toBeGreaterThan(100)
  })

  // West to east the corridor runs slow-down, slow-up, fast-down, fast-up,
  // then the express pair (see src/sim/types.ts and trackForLine). Which pair a
  // service belongs on follows its calling pattern, not its livery: 'ac' is a
  // livery, and a real WR AC local runs both fast and slow workings.
  it('puts every service on the pair of lines its calling pattern belongs to', () => {
    for (const svc of timetable.services) {
      if (svc.serviceType === 'express') {
        expect([4, 5], svc.id).toContain(svc.lineId)
        continue
      }
      const skipped = skippedStations(svc.stops)
      const onFastPair = svc.lineId === 2 || svc.lineId === 3
      expect(onFastPair, `${svc.id} (${svc.serviceType}, skips ${skipped})`).toBe(
        skipped > FAST_SKIP_THRESHOLD,
      )
    }
  })

  it('matches the down direction to its Line', () => {
    for (const svc of timetable.services) {
      const downTrack = svc.lineId % 2 === 0
      expect(downTrack, svc.id).toBe(svc.direction === 'down')
    }
  })

  it('turns back down services at a realistic mix of termini, not all the same station', () => {
    const termini = new Map<string, number>()
    for (const svc of timetable.services) {
      if (svc.direction !== 'down' || svc.serviceType === 'express') continue
      const last = svc.stops[svc.stops.length - 1].stationId
      termini.set(last, (termini.get(last) ?? 0) + 1)
    }
    expect(termini.get('borivali')).toBeGreaterThan(50)
    expect(termini.get('virar')).toBeGreaterThan(50)
    expect(termini.size).toBeGreaterThan(5)
  })

  it('has fast services call at every major interchange within their own span', () => {
    // Real WR runs several distinct fast-calling patterns (not the one
    // idealized skip-list the v1 spec assumed — confirmed by baking this
    // data: only ~37% of classified fasts match that exact pattern south of
    // Borivali). What holds across all of them is that the major
    // interchanges are never skipped, only the minor stations between.
    const majors = ['churchgate', 'mumbaicentral', 'dadar', 'bandra', 'andheri', 'borivali']
    const fastServices = timetable.services.filter(
      (s) => s.serviceType === 'fast' && s.direction === 'down',
    )
    expect(fastServices.length).toBeGreaterThan(0)
    const compliant = fastServices.filter((svc) => {
      const stopSet = new Set(svc.stops.map((s) => s.stationId))
      const firstChain = chainageOf.get(svc.stops[0].stationId)!
      const lastChain = chainageOf.get(svc.stops[svc.stops.length - 1].stationId)!
      return majors
        .filter((m) => chainageOf.get(m)! >= firstChain && chainageOf.get(m)! <= lastChain)
        .every((m) => stopSet.has(m))
    })
    expect(compliant.length / fastServices.length).toBeGreaterThan(0.9)
  })

  it('serves every Station in both directions', () => {
    // A railway that only ever carries people away from a Station is not a
    // railway. Kelve Road and Vangaon each had zero Up Halts (#27), because
    // the Dahanu sheet stacks its Up grid below its Down grid on one page and
    // the extractor only ever read the first — so all 21 Up services were
    // swallowed into the Down grid. Two Stations read as one-way, and nothing
    // else noticed.
    const halts = new Map<string, { up: number; down: number }>()
    for (const svc of timetable.services) {
      for (const stop of svc.stops) {
        const entry = halts.get(stop.stationId) ?? { up: 0, down: 0 }
        if (svc.direction === 'up') entry.up += 1
        else entry.down += 1
        halts.set(stop.stationId, entry)
      }
    }
    for (const [stationId, counts] of halts) {
      const name = network.stations.find((s) => s.id === stationId)?.name ?? stationId
      expect(counts.up, `${name} has no Up Halts`).toBeGreaterThan(0)
      expect(counts.down, `${name} has no Down Halts`).toBeGreaterThan(0)
    }
  })

  it('works the Dahanu stretch evenly in both directions', () => {
    // North of Virar there is one sheet and one shuttle service, so the two
    // directions should match almost exactly; a split here means a grid was
    // half-read again.
    for (const id of ['vaitarna', 'saphale', 'kelveroad', 'palghar', 'umroli', 'boisar', 'vangaon']) {
      const up = timetable.services.filter(
        (s) => s.direction === 'up' && s.stops.some((x) => x.stationId === id),
      ).length
      const down = timetable.services.filter(
        (s) => s.direction === 'down' && s.stops.some((x) => x.stationId === id),
      ).length
      expect(up, id).toBeGreaterThan(10)
      expect(Math.abs(up - down), `${id}: ${up} up vs ${down} down`).toBeLessThanOrEqual(3)
    }
  })

  it('runs AC services as both fast and slow workings, as the real ones do', () => {
    const ac = timetable.services.filter((s) => s.serviceType === 'ac')
    const onFast = ac.filter((s) => s.lineId === 2 || s.lineId === 3)
    const onSlow = ac.filter((s) => s.lineId === 0 || s.lineId === 1)
    expect(ac.length).toBeGreaterThan(100)
    expect(onFast.length).toBeGreaterThan(20)
    expect(onSlow.length).toBeGreaterThan(20)
    expect(onFast.length + onSlow.length).toBe(ac.length)
  })
})
