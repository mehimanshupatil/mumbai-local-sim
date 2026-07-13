/**
 * Line-agnostic baked network data. One JSON file per line (western.json,
 * central.json, ...), produced offline by scripts/bake-network.ts — never
 * fetched at runtime.
 *
 * Coordinates are true-scale WGS84; chainage is metres along the corridor
 * centerline from the origin terminus. Visual exaggeration happens only at
 * render time.
 */
import type { LonLat } from './geo'

export interface StationRecord {
  id: string
  name: string
  nameMr: string
  lat: number
  lon: number
  /** Distance along the corridor centerline from the origin terminus. */
  chainageM: number
  /** True if fast services halt here. */
  fastHalt: boolean
}

/** Contiguous stretch of corridor with a constant number of running tracks. */
export interface TrackSection {
  fromM: number
  toM: number
  tracks: number
}

export interface NetworkData {
  line: string
  name: string
  /** Total corridor centerline length in metres. */
  lengthM: number
  /** Ordered origin → far terminus. */
  stations: StationRecord[]
  /** Corridor centerline as [lon, lat] pairs, ordered origin → far terminus. */
  corridor: LonLat[]
  /** Ordered, contiguous, covering [0, lengthM]. */
  sections: TrackSection[]
  /** ISO date of the bake, for provenance only. */
  bakedAt: string
  source: string
}
