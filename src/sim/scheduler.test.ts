import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import { syntheticScheduler } from './scheduler'
import { buildTimetable, trainStates } from './simulate'
import {
  TRACK_FAST_DOWN,
  TRACK_FAST_UP,
  TRACK_SLOW_DOWN,
  TRACK_SLOW_UP,
  type ServiceDef,
} from './types'

const network = westernJson as NetworkData
const defs = syntheticScheduler(network)
const byId = new Map(network.stations.map((s) => [s.id, s]))

const timetableOf = (def: ServiceDef) => buildTimetable(network, def)

/** Dwell-start times of the given services at a station, sorted. */
function dwellStartsAt(stationId: string, services: ServiceDef[], fromT: number, toT: number): number[] {
  const timetables = services.map(timetableOf)
  const starts: number[] = []
  for (const tt of timetables) {
    const stop = tt.stops.find((s) => s.id === stationId)
    if (stop && stop.arriveT >= fromT && stop.arriveT < toT) starts.push(stop.arriveT)
  }
  return starts.sort((a, b) => a - b)
}

const slowDown = defs.filter(
  (d) => (d.serviceType === 'slow' || d.serviceType === 'ac') && d.direction === 'down',
)
const fastDown = defs.filter((d) => d.serviceType === 'fast' && d.direction === 'down')
const expresses = defs.filter((d) => d.serviceType === 'express')

describe('synthetic scheduler', () => {
  it('runs slow locals ~4 min apart in the 08:30 peak and ~8 min apart at 14:00', () => {
    const dadar = network.stations.find((s) => s.name === 'Dadar')!.id
    for (const [fromH, toH, expected] of [
      [8.5, 9.5, 240],
      [14, 15, 480],
    ] as const) {
      const starts = dwellStartsAt(dadar, slowDown, fromH * 3600, toH * 3600)
      expect(starts.length).toBeGreaterThan(2)
      for (let i = 1; i < starts.length; i++) {
        expect(Math.abs(starts[i] - starts[i - 1] - expected), `headway @${fromH}h`).toBeLessThan(60)
      }
    }
  })

  it('gives fast locals the published skip pattern: 6 fast halts, then all stops', () => {
    const fast = fastDown[0]
    const names = fast.stopIds.map((id) => byId.get(id)!.name)
    expect(names.slice(0, 6)).toEqual([
      'Churchgate',
      'Mumbai Central',
      'Dadar',
      'Bandra',
      'Andheri',
      'Borivali',
    ])
    const borivaliIdx = network.stations.findIndex((s) => s.name === 'Borivali')
    const virarIdx = network.stations.findIndex((s) => s.name === 'Virar')
    expect(names.slice(5)).toEqual(
      network.stations.slice(borivaliIdx, virarIdx + 1).map((s) => s.name),
    )
  })

  it('lets a fast local overtake the slow local it departs behind, before Borivali', () => {
    const slow = slowDown.find((d) => d.departureTime >= 8.5 * 3600)!
    const fast = fastDown.find((d) => d.departureTime > slow.departureTime)!
    expect(fast.departureTime - slow.departureTime).toBeLessThan(600)
    const timetables = [timetableOf(slow), timetableOf(fast)]
    const borivaliM = network.stations.find((s) => s.name === 'Borivali')!.chainageM
    let overtakeM: number | null = null
    for (let t = fast.departureTime; t < fast.departureTime + 3600; t += 10) {
      const [a, b] = trainStates(timetables, t)
      if (!a || !b) break
      const slowState = a.id === slow.id ? a : b
      const fastState = a.id === fast.id ? a : b
      if (fastState.chainageM > slowState.chainageM) {
        overtakeM = fastState.chainageM
        break
      }
    }
    expect(overtakeM).not.toBeNull()
    expect(overtakeM!).toBeLessThan(borivaliM)
  })

  it('keeps slow and fast services on disjoint tracks', () => {
    const slowTracks = new Set(slowDown.map((d) => d.track))
    for (const d of defs.filter((x) => x.serviceType === 'slow' || x.serviceType === 'ac')) {
      expect([TRACK_SLOW_DOWN, TRACK_SLOW_UP]).toContain(d.track)
    }
    for (const d of defs.filter((x) => x.serviceType === 'fast')) {
      expect([TRACK_FAST_DOWN, TRACK_FAST_UP]).toContain(d.track)
      expect(slowTracks.has(d.track)).toBe(false)
    }
  })

  it('never dwells an express: nonstop, always moving mid-run', () => {
    expect(expresses.length).toBeGreaterThan(0)
    const tt = timetableOf(expresses[0])
    for (let t = expresses[0].departureTime; ; t += 30) {
      const state = trainStates([tt], t)[0]
      if (!state) break
      expect(state.dwelling).toBe(false)
      if (t > expresses[0].departureTime) expect(state.speedMps).toBeGreaterThan(0)
    }
  })

  it('mixes in the AC variant occasionally on the slow lines', () => {
    const ac = defs.filter((d) => d.serviceType === 'ac')
    expect(ac.length).toBeGreaterThan(0)
    expect(ac.length / (slowDown.length * 2)).toBeLessThan(0.5)
  })

  it('is deterministic end to end: same clock, same TrainState[]', () => {
    const t = 8.75 * 3600
    const build = () => syntheticScheduler(network).map((d) => buildTimetable(network, d))
    const a = trainStates(build(), t)
    const b = trainStates(build(), t)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(15) // corridor is alive at peak
  })

  it('keeps the corridor north of Virar served', () => {
    const virarM = network.stations.find((s) => s.name === 'Virar')!.chainageM
    const north = defs.filter((d) =>
      d.stopIds.some((id) => byId.get(id)!.chainageM > virarM + 1000),
    )
    expect(north.length).toBeGreaterThan(0)
  })
})
