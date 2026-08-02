/**
 * Derives renderable per-track polylines from the baked network: each track
 * section yields `tracks` parallel offset copies of the corridor centerline.
 * Pure geometry — no three.js or React.
 */
import type { NetworkData, TrackSection, YardRecord } from '../data/network-types'
import type { Projection } from './projection'

export interface TrackPolyline {
  /** Scene-space [x, z] vertices. */
  points: [number, number][]
}

// The polyline helpers below mirror scripts/bake-network.ts, but in planar
// scene metres rather than WGS84 haversine — a fix to one likely applies to
// the other.

/** Cumulative planar length of a scene-space polyline, per vertex. */
export function cumulativeLength(points: [number, number][]): number[] {
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

/**
 * A yard siding as a posable track (ticket #17) — same TrainTrack shape as
 * the corridor so poseAt works unmodified, but "chainage" here is just
 * metres from the junction (siding[0]), not baked corridor chainage, so
 * scale is 1. Only two points in the baked data (junction + far end), but
 * poseAt already extrapolates past a track's ends along its tangent, so a
 * rake parked further in than the drawn siding still renders in a straight
 * line rather than breaking.
 */
export function buildYardTrack(yard: YardRecord, projection: Projection): TrainTrack {
  const points = yard.siding.map(projection.toScene)
  return { points, lengths: cumulativeLength(points), scale: 1 }
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

/** A track's lateral offset when a section fans `tracks`-many parallel copies of the centerline. */
function centeredOffset(t: number, tracks: number, spacingM: number): number {
  return (t - (tracks - 1) / 2) * spacingM
}

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

interface BoundaryMatch {
  matched: { prevIdx: number; nextIdx: number }[]
  prevOnly: number[]
  nextOnly: number[]
  /**
   * For each prevOnly track, the offset it should taper *toward* at the
   * boundary — not the raw centreline (that walks a surplus track straight
   * through any matched track sitting at a nonzero offset in between: a
   * real self-crossing of two track polylines, rendered as a pinched,
   * jagged gap torn into the ballast — seen in-browser at Virar's 4→2), and
   * not the nearest surviving neighbour's own *static* offset either (that
   * still crosses whenever the neighbour itself is easing across the same
   * boundary and its own value there differs from its static offset — seen
   * in-browser at Mahim Junction's 5→4 after the first fix, a smaller but
   * real residual crossing). It has to be the neighbour's actual position
   * *at this exact boundary point*: for a matched pair the two sides'
   * blend formulas are provably equal there and land exactly halfway
   * between the pair's two static offsets (see buildTrackPolylines), so
   * that midpoint is what every surplus track outward of it converges to.
   */
  prevConverge: Map<number, number>
  /** Same idea for nextOnly tracks — same shared boundary value, since it's
   * the same physical point on the same matched pair. */
  nextConverge: Map<number, number>
}

/**
 * How a section boundary's tracks correspond to the next section's, by
 * position relative to the centerline rather than raw index — matching by
 * index would let e.g. a 4-track section's outermost track (index 3) land
 * on a 6-track section's near-centre slot (also some index 3), which reads
 * as one rail jumping clean across its neighbours. Grouped by side (an odd
 * section's single centre track folds into the left group by convention,
 * so parity changes shift by at most half a spacing, never crossing) and
 * matched nearest-to-centre-first within a side: the tracks common to both
 * sections carry through, any surplus is always the outermost one(s).
 */
function matchBoundary(prevTracks: number, nextTracks: number, spacingM: number): BoundaryMatch {
  const rank = (t: number, n: number) => t - (n - 1) / 2
  const group = (n: number): { left: number[]; right: number[] } => {
    const left: number[] = []
    const right: number[] = []
    for (let t = 0; t < n; t++) (rank(t, n) <= 0 ? left : right).push(t)
    const byAbsRank = (a: number, b: number) => Math.abs(rank(a, n)) - Math.abs(rank(b, n))
    left.sort(byAbsRank)
    right.sort(byAbsRank)
    return { left, right }
  }
  const prevG = group(prevTracks)
  const nextG = group(nextTracks)
  const matched: { prevIdx: number; nextIdx: number }[] = []
  const prevOnly: number[] = []
  const nextOnly: number[] = []
  const prevConverge = new Map<number, number>()
  const nextConverge = new Map<number, number>()
  for (const side of ['left', 'right'] as const) {
    const p = prevG[side]
    const q = nextG[side]
    const n = Math.min(p.length, q.length)
    // p/q are sorted nearest-to-centre-first, so at most one of the two
    // surplus loops below ever runs. Walking the matched pairs in order and
    // remembering the last one's shared boundary value gives exactly the
    // nearest surviving neighbour's actual position at this boundary for
    // every surplus track after it (see prevConverge's doc comment for why
    // it has to be that value, not either track's own static offset).
    let boundaryInward = 0
    for (let i = 0; i < n; i++) {
      matched.push({ prevIdx: p[i], nextIdx: q[i] })
      boundaryInward =
        (centeredOffset(p[i], prevTracks, spacingM) + centeredOffset(q[i], nextTracks, spacingM)) / 2
    }
    for (let i = n; i < p.length; i++) {
      prevOnly.push(p[i])
      prevConverge.set(p[i], boundaryInward)
    }
    for (let i = n; i < q.length; i++) {
      nextOnly.push(q[i])
      nextConverge.set(q[i], boundaryInward)
    }
  }
  return { matched, prevOnly, nextOnly, prevConverge, nextConverge }
}

/** Half-length (each side of a boundary) of a turnout's diverging-curve throat. */
const TURNOUT_HALF_WINDOW_M = 500
/** Sample spacing inside a turnout window — dense enough to read as a curve
 * rather than a handful of straight kinks, reusing the same fixed-cumulative-
 * length sampling `pointAt` already does for platforms/ballast elsewhere. */
const TURNOUT_SAMPLE_STEP_M = 20

/**
 * One polyline per running track. Section chainages index the corridor by
 * its own planar length — scene length and baked chainage agree within the
 * projection's distortion (<0.1% over this corridor).
 *
 * At a section boundary where the track count changes, tracks don't just
 * snap to the new lane offset (see matchBoundary above): a track carried
 * through from the neighbouring section eases from its old offset to its
 * new one over a symmetric window straddling the boundary, and a track that
 * only exists on one side tapers to/from the centreline within that
 * section's own half of the window — a diverging-curve turnout throat, at
 * the same "curved geometry, no moving parts" tier as the textured ballast
 * bed (#15) and the Churchgate terminus fan above (ticket #18).
 */
export function buildTrackPolylines(
  network: NetworkData,
  projection: Projection,
  spacingM: number,
): TrackPolyline[] {
  const { points: centerline, lengths, scale } = buildTrainTrack(network, projection, 0)
  const sections = network.sections
  const out: TrackPolyline[] = []
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]
    const fromScene = section.fromM * scale
    const toScene = section.toM * scale
    const totalLen = toScene - fromScene
    if (totalLen <= 0) continue
    const half = Math.min(TURNOUT_HALF_WINDOW_M, totalLen / 2)
    const prevSection = s > 0 ? sections[s - 1] : null
    const nextSection = s < sections.length - 1 ? sections[s + 1] : null
    const startMatch = prevSection ? matchBoundary(prevSection.tracks, section.tracks, spacingM) : null
    const endMatch = nextSection ? matchBoundary(section.tracks, nextSection.tracks, spacingM) : null

    // Base vertices: densely resampled inside each turnout window (so the
    // eased offset actually renders as a curve, not a straight chord between
    // whatever OSM vertices happen to fall nearby), native vertices between.
    const base: [number, number][] = []
    if (startMatch) {
      for (let m = fromScene; m < fromScene + half; m += TURNOUT_SAMPLE_STEP_M) {
        base.push(pointAt(centerline, lengths, m))
      }
    }
    const midFrom = startMatch ? fromScene + half : fromScene
    const midTo = endMatch ? toScene - half : toScene
    if (midTo > midFrom) base.push(...slice(centerline, lengths, midFrom, midTo))
    else base.push(pointAt(centerline, lengths, (midFrom + midTo) / 2))
    if (endMatch) {
      for (let m = toScene - half + TURNOUT_SAMPLE_STEP_M; m < toScene; m += TURNOUT_SAMPLE_STEP_M) {
        base.push(pointAt(centerline, lengths, m))
      }
      base.push(pointAt(centerline, lengths, toScene))
    }
    if (base.length < 2) continue
    const baseLengths = cumulativeLength(base)
    const baseTotal = baseLengths[baseLengths.length - 1]

    for (let t = 0; t < section.tracks; t++) {
      const staticOffset = centeredOffset(t, section.tracks, spacingM)
      const startEntry = startMatch?.nextOnly.includes(t) ?? false
      const startPair = startMatch?.matched.find((m) => m.nextIdx === t)
      const endExit = endMatch?.prevOnly.includes(t) ?? false
      const endPair = endMatch?.matched.find((m) => m.prevIdx === t)

      const points = base.map((p, i) => {
        const cumLen = baseLengths[i]
        const dFromStart = cumLen
        const dFromEnd = baseTotal - cumLen
        let offset = staticOffset
        if (startEntry && dFromStart < half) {
          const convergeOffset = startMatch!.nextConverge.get(t) ?? 0
          offset = convergeOffset + smoothstep(dFromStart / half) * (staticOffset - convergeOffset)
        } else if (startPair && dFromStart < half) {
          const prevOffset = centeredOffset(startPair.prevIdx, prevSection!.tracks, spacingM)
          const u = (half + dFromStart) / (2 * half)
          offset = prevOffset + smoothstep(u) * (staticOffset - prevOffset)
        } else if (endExit && dFromEnd < half) {
          const convergeOffset = endMatch!.prevConverge.get(t) ?? 0
          offset = convergeOffset + smoothstep(dFromEnd / half) * (staticOffset - convergeOffset)
        } else if (endPair && dFromEnd < half) {
          const nextOffset = centeredOffset(endPair.nextIdx, nextSection!.tracks, spacingM)
          const u = (half - dFromEnd) / (2 * half)
          offset = staticOffset + smoothstep(u) * (nextOffset - staticOffset)
        }
        const prev = base[Math.max(0, i - 1)]
        const next = base[Math.min(base.length - 1, i + 1)]
        const dx = next[0] - prev[0]
        const dy = next[1] - prev[1]
        const len = Math.hypot(dx, dy) || 1
        return [p[0] + (-dy / len) * offset, p[1] + (dx / len) * offset] as [number, number]
      })
      out.push({ points })
    }
  }
  return out
}
