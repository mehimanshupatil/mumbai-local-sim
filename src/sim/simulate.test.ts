import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import type { ServiceDef, TrainState } from './types'
import { buildTimetable, PARK_DURATION_S, trainStates } from './simulate'

const network = westernJson as NetworkData

const virarIndex = network.stations.findIndex((s) => s.name === 'Virar')
const stopIds = network.stations.slice(0, virarIndex + 1).map((s) => s.id)

const DEPART = 8.5 * 3600 // 08:30

const slowLocal: ServiceDef = {
  id: 'CCG-VR-1',
  serviceType: 'slow',
  direction: 'down',
  track: 0,
  departureTime: DEPART,
  stopIds,
}

const timetable = buildTimetable(network, slowLocal)

/** The single train's state at time t, or null if not running. */
function at(t: number): TrainState | null {
  const states = trainStates([timetable], t)
  expect(states.length).toBeLessThanOrEqual(1)
  return states[0] ?? null
}

/** Sample the whole run once per second (origin dwell starts before departure). */
function fullRun(): { t: number; state: TrainState }[] {
  const out: { t: number; state: TrainState }[] = []
  for (let t = DEPART - 30; t < DEPART + 3 * 3600; t += 1) {
    const state = at(t)
    if (state) out.push({ t, state })
  }
  return out
}

describe('one slow local Churchgate → Virar', () => {
  it('does not exist before the origin yard-park window or after it', () => {
    // DEPART - 60 now falls inside the bounded pre-departure yard park
    // (ticket #17) — see the 'yard origination' tests below for that window.
    expect(at(DEPART - 30 - PARK_DURATION_S - 60)).toBeNull()
    expect(at(DEPART + 3 * 3600)).toBeNull()
  })

  it('departs the origin at exactly departureTime', () => {
    expect(at(DEPART - 1)!.dwelling).toBe(true)
    expect(at(DEPART - 1)!.chainageM).toBe(0)
    expect(at(DEPART + 5)!.speedMps).toBeGreaterThan(0)
  })

  it('dwells at every station in order, Churchgate through Virar', () => {
    const dwelt: string[] = []
    for (const { state } of fullRun()) {
      if (state.dwelling && dwelt[dwelt.length - 1] !== state.nextStopId) {
        dwelt.push(state.nextStopId!)
      }
    }
    expect(dwelt).toEqual(stopIds)
  })

  it('dwells ~30 s at an intermediate station', () => {
    const dadar = network.stations.find((s) => s.name === 'Dadar')!
    const dwellSeconds = fullRun().filter(
      ({ state }) => state.dwelling && state.nextStopId === dadar.id,
    ).length
    expect(dwellSeconds).toBeGreaterThanOrEqual(28)
    expect(dwellSeconds).toBeLessThanOrEqual(32)
  })

  it('is stationary at the station chainage while dwelling', () => {
    const bandra = network.stations.find((s) => s.name === 'Bandra')!
    for (const { state } of fullRun()) {
      if (state.dwelling && state.nextStopId === bandra.id) {
        expect(Math.abs(state.chainageM - bandra.chainageM)).toBeLessThan(1)
        expect(state.speedMps).toBe(0)
      }
    }
  })

  it('resets legDistanceM to 0 at every dwell and grows it while running a leg', () => {
    let prevStopId: string | null = null
    let originChainageM = 0
    for (const { state } of fullRun()) {
      if (state.dwelling) {
        expect(state.legDistanceM).toBe(0)
        prevStopId = state.nextStopId
        originChainageM = state.chainageM
        continue
      }
      // Just left prevStopId's chainage — legDistanceM is how far past it.
      if (prevStopId) {
        expect(state.legDistanceM).toBeCloseTo(Math.abs(state.chainageM - originChainageM), 1)
      }
    }
  })

  it('moves down-line monotonically and within speed limits', () => {
    let prev = -1
    for (const { state } of fullRun()) {
      expect(state.chainageM).toBeGreaterThanOrEqual(prev)
      prev = state.chainageM
      expect(state.speedMps).toBeGreaterThanOrEqual(0)
      expect(state.speedMps).toBeLessThanOrEqual(23)
    }
  })

  it('reaches Virar in the real-world 90–110 minutes', () => {
    // Published WR slow-local time Churchgate→Virar is ~95-100 min; the
    // kinematics are calibrated against real per-leg runtimes.
    // fullRun() now runs past arrival into the post-#17 yard-parking tail,
    // so measure arrival at Virar (not the last non-null sample).
    const run = fullRun()
    const arrival = run.find(
      ({ state }) => state.dwelling && state.nextStopId === stopIds[stopIds.length - 1],
    )
    const durationMin = (arrival!.t - DEPART) / 60
    expect(durationMin).toBeGreaterThan(90)
    expect(durationMin).toBeLessThan(110)
  })

  it('carries service metadata on every state', () => {
    const mid = at(DEPART + 30 * 60)!
    expect(mid.id).toBe('CCG-VR-1')
    expect(mid.serviceType).toBe('slow')
    expect(mid.direction).toBe('down')
    expect(mid.track).toBe(0)
  })

  it('replays deterministically — same time, same state', () => {
    const t = DEPART + 47 * 60 + 13
    const a = trainStates([buildTimetable(network, slowLocal)], t)
    const b = trainStates([buildTimetable(network, slowLocal)], t)
    expect(a).toEqual(b)
  })
})

describe('yard origination (#17)', () => {
  it('parks at the origin yard before departure, not teleports in', () => {
    const state = at(DEPART - 30 - 10 * 60)! // 10 min before the pre-departure dwell opens
    expect(state).not.toBeNull()
    expect(state.parkedYardId).not.toBeNull()
    expect(state.nextStopId).toBe(stopIds[0])
    expect(state.speedMps).toBe(0)
  })

  it('vanishes before the bounded origin-park window opens', () => {
    expect(at(DEPART - 30 - PARK_DURATION_S - 60)).toBeNull()
  })

  it('hands off from parked to the normal origin dwell at the same yard', () => {
    const parked = at(DEPART - 30 - 1)!
    const dwelling = at(DEPART - 30)!
    expect(parked.parkedYardId).not.toBeNull()
    expect(dwelling.parkedYardId).toBeNull()
    expect(dwelling.dwelling).toBe(true) // simTime === stop.arriveT: pre-departure dwell begins
    expect(dwelling.chainageM).toBe(parked.chainageM)
  })
})
