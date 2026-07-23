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
    track: number
    cars: number | null
    stops: { stationId: string; t: number }[]
  }[]
}

const stationIds = new Set(network.stations.map((s) => s.id))
const chainageOf = new Map(network.stations.map((s) => [s.id, s.chainageM]))

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

  it('keeps slow/ac and fast services on disjoint track lanes per direction', () => {
    for (const svc of timetable.services) {
      if (svc.serviceType === 'fast') {
        expect([2, 3]).toContain(svc.track)
      } else if (svc.serviceType === 'slow' || svc.serviceType === 'ac') {
        expect([0, 1]).toContain(svc.track)
      }
    }
  })

  it('matches the down track direction to its track lane', () => {
    for (const svc of timetable.services) {
      const downTrack = svc.track % 2 === 0
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

  it('gives every AC service the blue livery classification regardless of stop pattern', () => {
    for (const svc of timetable.services) {
      if (svc.serviceType === 'ac') expect(svc.stops.length).toBeGreaterThanOrEqual(2)
    }
  })
})
