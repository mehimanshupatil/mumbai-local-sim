/**
 * Derives renderable per-track polylines from the baked network: each track
 * section yields `tracks` parallel offset copies of the corridor centerline.
 * Pure geometry — no three.js or React.
 */
import type { NetworkData } from '../data/network-types'
import type { Projection } from './projection'

export interface TrackPolyline {
  /** Scene-space [x, z] vertices. */
  points: [number, number][]
}

// The polyline helpers below mirror scripts/bake-network.ts, but in planar
// scene metres rather than WGS84 haversine — a fix to one likely applies to
// the other.

/** Cumulative planar length of a scene-space polyline, per vertex. */
function cumulativeLength(points: [number, number][]): number[] {
  const out = [0]
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))
  }
  return out
}

/** Point interpolated at cumulative length m. */
function pointAt(points: [number, number][], lengths: number[], m: number): [number, number] {
  let i = 1
  while (i < lengths.length - 1 && lengths[i] < m) i++
  const t = Math.max(0, Math.min(1, (m - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1)))
  return [
    points[i - 1][0] + t * (points[i][0] - points[i - 1][0]),
    points[i - 1][1] + t * (points[i][1] - points[i - 1][1]),
  ]
}

/**
 * The polyline between two cumulative lengths, with the exact cut points
 * interpolated at both ends so adjacent slices meet without a gap.
 */
function slice(points: [number, number][], lengths: number[], fromM: number, toM: number): [number, number][] {
  const out: [number, number][] = [pointAt(points, lengths, fromM)]
  for (let i = 0; i < points.length; i++) {
    if (lengths[i] > fromM && lengths[i] < toM) out.push(points[i])
  }
  out.push(pointAt(points, lengths, toM))
  return out
}

/** Parallel copy of the polyline, offset by d metres to its left. */
export function offsetPolyline(points: [number, number][], d: number): [number, number][] {
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dx = next[0] - prev[0]
    const dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy) || 1
    return [p[0] + (-dy / len) * d, p[1] + (dx / len) * d]
  })
}

/**
 * One polyline per running track. Section chainages index the corridor by
 * its own planar length — scene length and baked chainage agree within the
 * projection's distortion (<0.1% over this corridor).
 */
export function buildTrackPolylines(
  network: NetworkData,
  projection: Projection,
  spacingM: number,
): TrackPolyline[] {
  const centerline = network.corridor.map(projection.toScene)
  const lengths = cumulativeLength(centerline)
  const scale = lengths[lengths.length - 1] / network.lengthM
  const out: TrackPolyline[] = []
  for (const section of network.sections) {
    const base = slice(centerline, lengths, section.fromM * scale, section.toM * scale)
    if (base.length < 2) continue
    for (let t = 0; t < section.tracks; t++) {
      const offset = (t - (section.tracks - 1) / 2) * spacingM
      out.push({ points: offsetPolyline(base, offset) })
    }
  }
  return out
}
