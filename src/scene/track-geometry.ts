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

/** Segment index and clamped interpolation factor at cumulative length m. */
function segmentAt(lengths: number[], m: number): { i: number; t: number } {
  let i = 1
  while (i < lengths.length - 1 && lengths[i] < m) i++
  return { i, t: Math.max(0, Math.min(1, (m - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1))) }
}

/** Point interpolated at cumulative length m. */
function pointAt(points: [number, number][], lengths: number[], m: number): [number, number] {
  const { i, t } = segmentAt(lengths, m)
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

/** A polyline a train can be posed on by baked chainage. */
export interface TrainTrack {
  points: [number, number][]
  lengths: number[]
  /** Scene metres per baked chainage metre (projection distortion, ~1). */
  scale: number
}

/** The corridor centerline offset sideways, measured for chainage lookup. */
export function buildTrainTrack(
  network: NetworkData,
  projection: Projection,
  offsetM: number,
): TrainTrack {
  const centerline = network.corridor.map(projection.toScene)
  const points = offsetM === 0 ? centerline : offsetPolyline(centerline, offsetM)
  const lengths = cumulativeLength(points)
  return { points, lengths, scale: lengths[lengths.length - 1] / network.lengthM }
}

export interface TrackPose {
  x: number
  z: number
  /** Heading for a mesh whose long axis is local +z. */
  angleRad: number
}

/**
 * Position + heading at a baked chainage, shifted alongOffsetSceneM scene
 * metres along the track (e.g. trailing coaches of a rake). Beyond either
 * terminus the pose extrapolates along the end tangent, so a rake berthed
 * at a terminus lines up instead of piling onto the clamped endpoint.
 */
export function poseAt(track: TrainTrack, chainageM: number, alongOffsetSceneM = 0): TrackPose {
  const { points, lengths } = track
  const m = chainageM * track.scale + alongOffsetSceneM
  const { i, t } = segmentAt(lengths, m)
  const [ax, az] = points[i - 1]
  const [bx, bz] = points[i]
  const segLen = lengths[i] - lengths[i - 1] || 1
  // Signed overshoot past the polyline ends, in segment-fraction units.
  const overshoot = m < 0 ? m / segLen : m > lengths[lengths.length - 1] ? (m - lengths[lengths.length - 1]) / segLen : 0
  const f = t + overshoot
  return {
    x: ax + f * (bx - ax),
    z: az + f * (bz - az),
    angleRad: Math.atan2(bx - ax, bz - az),
  }
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
  const { points: centerline, lengths, scale } = buildTrainTrack(network, projection, 0)
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
