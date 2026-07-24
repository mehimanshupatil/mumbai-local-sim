/**
 * Derives renderable per-track polylines from the baked network: each track
 * section yields `tracks` parallel offset copies of the corridor centerline.
 * Pure geometry — no three.js or React.
 */
import type { NetworkData, TrackSection } from '../data/network-types'
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
  // Binary search — called per coach per frame at fleet scale.
  let lo = 1
  let hi = lengths.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lengths[mid] < m) lo = mid + 1
    else hi = mid
  }
  const i = lo
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

/** The track section containing a baked chainage. */
export function sectionAtChainage(sections: TrackSection[], chainageM: number): TrackSection {
  for (const s of sections) if (chainageM < s.toM) return s
  return sections[sections.length - 1]
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
 * Decorative rail convergence south of Churchgate (chainage 0, the line's
 * southern terminus), where the running lines would taper into a real
 * terminus throat/buffer-stop concourse instead of just stopping. Purely
 * visual: the taper only starts SAFE_ZONE_M past chainage 0, clear of where
 * a dwelling rake's overshot nose renders (see Fleet.tsx's refOffset), so it
 * never crosses a train.
 */
export function terminusFanStub(
  network: NetworkData,
  projection: Projection,
  spacingM: number,
  sectionTracks: number,
): [number, number][][] {
  const centerline = network.corridor.map(projection.toScene)
  const [ox, oz] = centerline[0]
  const [nx, nz] = centerline[1]
  const dx = nx - ox
  const dz = nz - oz
  const len = Math.hypot(dx, dz) || 1
  const dirX = dx / len
  const dirZ = dz / len
  const normX = -dz / len
  const normZ = dx / len
  // Clear of the deepest a dwelling rake's cab nose overshoots south of
  // Churchgate (~PLATFORM_NOSE_OFFSET_M + NOSE_L, see Fleet.tsx), plus margin.
  const SAFE_ZONE_M = 340
  const TAPER_LEN_M = 350
  const TAPER_STEPS = 4
  const stubs: [number, number][][] = []
  for (let t = 0; t < sectionTracks; t++) {
    const off = (t - (sectionTracks - 1) / 2) * spacingM
    const stub: [number, number][] = []
    for (let step = 0; step <= TAPER_STEPS; step++) {
      // 0 at the deep (fully converged) end, 1 at the safe-zone boundary
      // (still full spacing) — eased so the convergence reads as a curve
      // rather than one hard-kinked straight segment.
      const u = step / TAPER_STEPS
      const eased = u * u * (3 - 2 * u)
      const s = SAFE_ZONE_M + TAPER_LEN_M * (1 - u)
      stub.push([ox - dirX * s + normX * off * eased, oz - dirZ * s + normZ * off * eased])
    }
    stubs.push(stub)
  }
  return stubs
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
