import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import { nextArrivals } from './arrivals'
import { syntheticScheduler } from './scheduler'
import { buildTimetable, trainStates } from './simulate'

const network = westernJson as NetworkData
const timetables = syntheticScheduler(network).map((d) => buildTimetable(network, d))
const dadar = network.stations.find((s) => s.name === 'Dadar')!.id

describe('nextArrivals', () => {
  it('returns upcoming arrivals sorted by time', () => {
    const t = 9 * 3600
    const arrivals = nextArrivals(timetables, dadar, t, 5)
    expect(arrivals.length).toBe(5)
    // Not yet departed (a train still dwelling counts as an arrival on the board).
    for (const a of arrivals) expect(a.departT).toBeGreaterThan(t)
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i].arriveT).toBeGreaterThanOrEqual(arrivals[i - 1].arriveT)
    }
  })

  it('matches scheduler behaviour: the predicted train really dwells there then', () => {
    const t = 9 * 3600
    const [first] = nextArrivals(timetables, dadar, t, 1)
    const tt = timetables.find((x) => x.def.id === first.serviceId)!
    const state = trainStates([tt], first.arriveT + 5)[0]
    expect(state.dwelling).toBe(true)
    expect(state.nextStopId).toBe(dadar)
  })

  it('carries service type, direction, and terminus for the card', () => {
    const arrivals = nextArrivals(timetables, dadar, 9 * 3600, 8)
    for (const a of arrivals) {
      expect(['slow', 'fast', 'ac', 'express']).toContain(a.serviceType)
      expect(['up', 'down']).toContain(a.direction)
      expect(network.stations.some((s) => s.id === a.terminusId)).toBe(true)
    }
    // Peak Dadar sees both directions within a handful of arrivals.
    expect(new Set(arrivals.map((a) => a.direction)).size).toBe(2)
  })

  it('filters to one direction when asked, independent of how busy the other is', () => {
    const t = 9 * 3600
    const down = nextArrivals(timetables, dadar, t, 4, 'down')
    const up = nextArrivals(timetables, dadar, t, 4, 'up')
    expect(down.length).toBe(4)
    expect(up.length).toBe(4)
    expect(down.every((a) => a.direction === 'down')).toBe(true)
    expect(up.every((a) => a.direction === 'up')).toBe(true)
  })

  it('never lists expresses at a local station they pass through', () => {
    // Expresses run nonstop Mumbai Central → Dahanu; Dadar is passed, not served.
    const arrivals = nextArrivals(timetables, dadar, 9 * 3600, 20)
    expect(arrivals.every((a) => a.serviceType !== 'express')).toBe(true)
  })

  it('excludes trains already departed and includes one currently dwelling', () => {
    const tt = timetables.find((x) => x.def.id.startsWith('S-DN'))!
    const stop = tt.stops.find((s) => s.id === dadar)!
    // While dwelling, the service still shows (arriveT in the past but not departed).
    const during = nextArrivals([tt], dadar, stop.arriveT + 10, 1)
    expect(during.length).toBe(1)
    // After departure it is gone.
    const after = nextArrivals([tt], dadar, stop.departT + 1, 1)
    expect(after.length).toBe(0)
  })
})
