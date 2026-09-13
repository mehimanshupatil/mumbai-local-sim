/**
 * Which Tracks a Station has a Platform Face beside.
 *
 * Derived, never baked: real per-Station platform counts are not obtainable
 * from any source — the PTT PDFs contain no occurrence of "platform" at all,
 * OSM leaves ten Stations without a `ref`, and the aggregator sites fold
 * Harbour and mainline Faces into a single total. See
 * docs/adr/0001-platform-faces-derived-not-baked.md; do not add a baked field
 * without reading it.
 *
 * The rule is the one thing the repo can actually assert: a Station has a
 * Face beside a Track when some Service booked on a Line that runs on that
 * Track there has a booked Halt at that Station. Churchgate's four Tracks all
 * take Halts, so it reads four Faces; Prabhadevi is a Slow-only Halt on a
 * five-Track Section, so it reads two; north of Virar there are two Tracks
 * and so two Faces.
 *
 * Face *numbering* is deliberately absent — real numbering includes lettered
 * Faces (1A, 3A, 5A), so if it is ever added it must be string, never number.
 */
import type { NetworkData } from '../data/network-types'
import { sectionAtChainage, trackForLine } from './lines'

/**
 * The Face a Service Halts at: the one beside the Track its Line runs on at
 * that Station. A pure function of (Line, Station) — direction is carried in
 * the Line, every *_UP constant being odd — so it is the same answer every
 * time it is asked, and asking it costs nothing.
 *
 * Identified by Track index rather than a number, because Face *numbering* is
 * out of scope and could not be a number anyway: real WR numbering has
 * lettered Faces (1A, 3A, 5A). See ADR 0001.
 */
export function faceForHalt(
  network: NetworkData,
  lineId: number,
  stationChainageM: number,
): number {
  return trackForLine(lineId, sectionAtChainage(network.sections, stationChainageM).tracks)
}

/** A Service as this needs to see it: the Line it runs on, and where it stops. */
export interface HaltingService {
  lineId: number
  stopIds: string[]
}

/**
 * Track indices with a Face, per Station id, ascending.
 *
 * Self-correcting by construction: the Track a Line runs on comes from the
 * Section's own Track count, so re-baking a Section wider or narrower moves
 * the Faces with it rather than leaving a stale count behind.
 */
export function faceTracksByStation(
  network: NetworkData,
  services: HaltingService[],
): Map<string, number[]> {
  const chainageOf = new Map(network.stations.map((s) => [s.id, s.chainageM]))
  const faces = new Map<string, Set<number>>()
  for (const service of services) {
    for (const stationId of service.stopIds) {
      const chainageM = chainageOf.get(stationId)
      if (chainageM === undefined) continue
      const track = faceForHalt(network, service.lineId, chainageM)
      const set = faces.get(stationId)
      if (set) set.add(track)
      else faces.set(stationId, new Set([track]))
    }
  }
  return new Map(
    network.stations.map((s) => [s.id, [...(faces.get(s.id) ?? [])].sort((a, b) => a - b)]),
  )
}

/**
 * The platforms those Faces sit on. Two Faces beside neighbouring Tracks are
 * one island between them — which is how WR builds them, a single slab with a
 * Face either side — and a Face with no neighbour is a side platform outside
 * the Track it serves.
 */
export interface PlatformSlab {
  /** Tracks this slab has a Face against: two for an island, one for a side. */
  tracks: [number] | [number, number]
  /** Which way a side platform faces its Track; unused for an island. */
  side: 1 | -1
}

export function platformSlabs(faceTracks: number[], sectionTracks: number): PlatformSlab[] {
  const slabs: PlatformSlab[] = []
  for (let i = 0; i < faceTracks.length; ) {
    const track = faceTracks[i]
    if (faceTracks[i + 1] === track + 1) {
      slabs.push({ tracks: [track, track + 1], side: 1 })
      i += 2
      continue
    }
    // A lone Face takes a side platform, put on whichever side of its Track
    // faces out of the fan.
    slabs.push({ tracks: [track], side: track * 2 >= sectionTracks - 1 ? 1 : -1 })
    i += 1
  }
  return slabs
}
