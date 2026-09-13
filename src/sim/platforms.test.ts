import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import realTimetableJson from '../data/western-real-timetable.json'
import type { NetworkData } from '../data/network-types'
import { sectionAtChainage } from './lines'
import { faceTracksByStation, platformSlabs, type HaltingService } from './platforms'

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
