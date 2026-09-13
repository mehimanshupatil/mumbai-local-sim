import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import realTimetableJson from '../data/western-real-timetable.json'
import type { NetworkData } from '../data/network-types'
import { sectionAtChainage } from './lines'
import { LINE_FAST_UP, LINE_SLOW_DOWN, LINE_SLOW_UP } from './types'
import { faceForHalt, faceTracksByStation, platformSlabs, type HaltingService } from './platforms'

const network = westernJson as NetworkData
const services: HaltingService[] = (
  realTimetableJson as { services: { lineId: number; stops: { stationId: string }[] }[] }
).services.map((svc) => ({ lineId: svc.lineId, stopIds: svc.stops.map((s) => s.stationId) }))

const faces = faceTracksByStation(network, services)
const facesAt = (id: string) => faces.get(id) ?? []
const tracksAt = (id: string) =>
  sectionAtChainage(network.sections, network.stations.find((s) => s.id === id)!.chainageM).tracks

describe('platform faces', () => {
  it('gives Churchgate a face beside all four of its tracks', () => {
    expect(tracksAt('churchgate')).toBe(4)
    expect(facesAt('churchgate')).toEqual([0, 1, 2, 3])
  })

  it('gives a slow-only halt fewer faces than its section has tracks', () => {
    for (const id of ['prabhadevi', 'matungaroad']) {
      expect(facesAt(id).length, id).toBeLessThan(tracksAt(id))
      // Slow Up and Slow Down are Tracks 0 and 1 wherever the section is wide
      // enough to keep them apart, which is everywhere south of Virar.
      expect(facesAt(id), id).toEqual([0, 1])
    }
  })

  it('gives a two-track halt north of Virar a face on each track', () => {
    for (const id of ['vaitarna', 'saphale', 'palghar', 'boisar']) {
      expect(tracksAt(id), id).toBe(2)
      expect(facesAt(id), id).toEqual([0, 1])
    }
  })

  it('gives every station that takes a halt at least one face', () => {
    const halting = new Set(services.flatMap((s) => s.stopIds))
    for (const station of network.stations) {
      if (!halting.has(station.id)) continue
      expect(facesAt(station.id).length, station.name).toBeGreaterThan(0)
    }
  })

  // The face follows the track the line runs on, and that comes from the
  // section's own track count — so a re-bake that widens or narrows a section
  // moves the faces with it rather than leaving a stale count behind.
  it('self-corrects when a section changes its track count', () => {
    const narrowed: NetworkData = {
      ...network,
      sections: network.sections.map((s) => ({ ...s, tracks: 2 })),
    }
    const before = faceTracksByStation(network, services)
    const after = faceTracksByStation(narrowed, services)
    // Churchgate's four faces collapse onto the two tracks it now has.
    expect(before.get('churchgate')).toEqual([0, 1, 2, 3])
    expect(after.get('churchgate')).toEqual([0, 1])
    for (const [, tracks] of after) {
      for (const track of tracks) expect(track).toBeLessThan(2)
    }
  })
})

describe('halting at a face', () => {
  const chainageOf = (id: string) => network.stations.find((s) => s.id === id)!.chainageM

  it('halts an up slow service at the up slow face', () => {
    // Slow Down and Slow Up are Tracks 0 and 1 on every section wide enough
    // to keep them apart, which is everywhere south of Virar.
    expect(faceForHalt(network, LINE_SLOW_UP, chainageOf('dadar'))).toBe(1)
    expect(faceForHalt(network, LINE_SLOW_DOWN, chainageOf('dadar'))).toBe(0)
  })

  it('halts a fast service at a different face from a slow one, same direction', () => {
    const fast = faceForHalt(network, LINE_FAST_UP, chainageOf('borivali'))
    const slow = faceForHalt(network, LINE_SLOW_UP, chainageOf('borivali'))
    expect(fast).not.toBe(slow)
  })

  it('puts a fast and a slow service on one face where the route is two tracks', () => {
    // North of Virar there are two Tracks, so a Fast and a Slow Up service
    // are on the same rails and so at the same Face. That is the railway,
    // not a modelling shortcut.
    const chainage = chainageOf('palghar')
    expect(faceForHalt(network, LINE_FAST_UP, chainage)).toBe(
      faceForHalt(network, LINE_SLOW_UP, chainage),
    )
  })

  it('answers the same way every time it is asked', () => {
    for (const station of network.stations) {
      for (const lineId of [0, 1, 2, 3, 4, 5]) {
        const once = faceForHalt(network, lineId, station.chainageM)
        const twice = faceForHalt(network, lineId, station.chainageM)
        expect(twice, `${station.name} line ${lineId}`).toBe(once)
      }
    }
  })

  it('never sends an up service to a down face', () => {
    for (const station of network.stations) {
      const tracks = sectionAtChainage(network.sections, station.chainageM).tracks
      for (const lineId of [LINE_SLOW_UP, LINE_FAST_UP]) {
        const face = faceForHalt(network, lineId, station.chainageM)
        // Up Lines are odd, and fold onto odd Tracks — except on the
        // two-Track stretch, where Track 1 is the single Up road.
        expect(face % 2, `${station.name} line ${lineId} (${tracks} tracks)`).toBe(1)
      }
    }
  })
})

describe('platform slabs', () => {
  it('puts one island between each pair of neighbouring faces', () => {
    expect(platformSlabs([0, 1, 2, 3], 4)).toEqual([
      { tracks: [0, 1], side: 1 },
      { tracks: [2, 3], side: 1 },
    ])
  })

  it('gives a lone face a side platform, facing out of the fan', () => {
    expect(platformSlabs([0], 2)).toEqual([{ tracks: [0], side: -1 }])
    expect(platformSlabs([3], 4)).toEqual([{ tracks: [3], side: 1 }])
  })

  it('covers every face exactly once, at every station', () => {
    for (const station of network.stations) {
      const tracks = facesAt(station.id)
      const covered = platformSlabs(tracks, tracksAt(station.id)).flatMap((s) => s.tracks)
      expect([...covered].sort((a, b) => a - b), station.name).toEqual(tracks)
    }
  })
})
