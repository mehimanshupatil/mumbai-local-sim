import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import type { ServiceDef, TrainState } from './types'
import { buildTimetable, trainStates } from './simulate'

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
  it('does not exist before the origin dwell or after the run ends', () => {
    expect(at(DEPART - 60)).toBeNull()
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

  it('moves down-line monotonically and within speed limits', () => {
    let prev = -1
    for (const { state } of fullRun()) {
      expect(state.chainageM).toBeGreaterThanOrEqual(prev)
      prev = state.chainageM
      expect(state.speedMps).toBeGreaterThanOrEqual(0)
      expect(state.speedMps).toBeLessThanOrEqual(23)
    }
  })

  it('reaches Virar in a plausible 70–110 minutes', () => {
    const run = fullRun()
    const durationMin = (run[run.length - 1].t - DEPART) / 60
    expect(durationMin).toBeGreaterThan(70)
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
