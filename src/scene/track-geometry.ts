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
 * Unit normal (left of travel) of the corridor at cumulative length m,
 * averaged over +/-NORMAL_WINDOW_M.
 *
 * Taken from the corridor rather than from a finite difference over whatever
 * vertex list a caller happens to hold: a section's own list is clipped at
 * its boundaries, so the two sides of a boundary derived *different* normals
 * from the same point, and lanes that are supposed to meet there missed each
 * other by up to 4 m on a curve. Averaging also keeps a lane from inheriting
 * the full kink of every native corridor vertex.
 */
const NORMAL_WINDOW_M = 25

function normalAt(points: [number, number][], lengths: number[], m: number): [number, number] {
  const total = lengths[lengths.length - 1]
  const [ax, az] = pointAt(points, lengths, Math.max(0, m - NORMAL_WINDOW_M))
  const [bx, bz] = pointAt(points, lengths, Math.min(total, m + NORMAL_WINDOW_M))
  const dx = bx - ax
  const dz = bz - az
  const len = Math.hypot(dx, dz) || 1
  return [-dz / len, dx / len]
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

/** Where a scene-space point lands on a track: distance along, offset across. */
export function projectOnTrack(
  track: TrainTrack,
  x: number,
  z: number,
): { alongM: number; lateralM: number } {
  const { points, lengths } = track
  let bestD2 = Infinity
  let alongM = 0
  let lateralM = 0
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]
    const [bx, bz] = points[i]
    const dx = bx - ax
    const dz = bz - az
    const len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2))
    const px = ax + t * dx
    const pz = az + t * dz
    const d2 = (x - px) ** 2 + (z - pz) ** 2
    if (d2 >= bestD2) continue
    const len = Math.sqrt(len2)
    bestD2 = d2
    alongM = lengths[i - 1] + t * len
    // Same normal convention as offsetPolyline: left of travel = (-dz, dx).
    lateralM = ((x - px) * -dz + (z - pz) * dx) / len
  }
  return { alongM, lateralM }
}

export interface YardRoadOptions {
  /** Parallel stabling roads to lay out, one rake each. */
  roads: number
  /** Centre-to-centre gap between roads — the running lines' own spacing. */
  spacingM: number
  /** Clear strip between the outermost running lane and the first road. */
  clearanceM: number
  /** Length of the throat each road peels off the running lines along. */
  throatM: number
  /** Straight stabling length past the throat. */
  roadM: number
  /** Sampling step; the roads follow the corridor's curve, so this has to be
   * fine enough to read as a curve rather than a chord. */
  stepM?: number
}

/**
 * A yard's stabling roads (ticket #17): a fan of parallel sidings peeling off
 * the running lines on whichever side the shed actually sits, one rake to a
 * road, each a posable TrainTrack whose "chainage" is metres from its own
 * start rather than baked corridor chainage (hence scale 1).
 *
 * The baked record holds only the shed's near and far points, and drawing the
 * straight line between them put the siding *through* the running lines: the
 * corridor curves away from that chord (by 44 m over Mumbai Central's siding,
 * 90 m over Bhayandar's), and the running fan is laterally exaggerated 5x (see
 * config.ts) while a baked shed offset is true-scale, so a real 50 m clearance
 * renders as none at all. Both are fixed by deriving the roads from the
 * corridor itself — offset along its own normals, and pushed out far enough to
 * clear the exaggerated fan — instead of from the two baked points, which now
 * only say which side of the line the shed is on and which way it runs.
 */
export function buildYardRoads(
  yard: YardRecord,
  projection: Projection,
  corridor: TrainTrack,
  sections: TrackSection[],
  opts: YardRoadOptions,
): TrainTrack[] {
  const [nearX, nearZ] = projection.toScene(yard.siding[0])
  const [farX, farZ] = projection.toScene(yard.siding[1])
  const near = projectOnTrack(corridor, nearX, nearZ)
  const far = projectOnTrack(corridor, farX, farZ)
  const dirSign = far.alongM >= near.alongM ? 1 : -1
  const side = near.lateralM >= 0 ? 1 : -1
  const tracksHere = sectionAtChainage(sections, near.alongM / corridor.scale).tracks
  const outerLaneM = ((tracksHere - 1) / 2) * opts.spacingM
  const firstRoadM = Math.max(Math.abs(near.lateralM), outerLaneM + opts.clearanceM)
  const totalM = opts.throatM + opts.roadM
  const step = opts.stepM ?? 25
  const roads: TrainTrack[] = []
  for (let r = 0; r < opts.roads; r++) {
    const targetM = firstRoadM + r * opts.spacingM
    const points: [number, number][] = []
    for (let s = 0; ; s = Math.min(totalM, s + step)) {
      const pose = poseAt(corridor, (near.alongM + dirSign * s) / corridor.scale)
      const nx = -Math.cos(pose.angleRad)
      const nz = Math.sin(pose.angleRad)
      // Eased across the throat so a road diverges as a curve off the
      // running lines, the same shape as a section boundary's turnout.
      const lateral = side * (outerLaneM + smoothstep(s / opts.throatM) * (targetM - outerLaneM))
      points.push([pose.x + nx * lateral, pose.z + nz * lateral])
      if (s >= totalM) break
    }
    roads.push({ points, lengths: cumulativeLength(points), scale: 1 })
  }
  return roads
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
 * How far the platform roads run past Churchgate (chainage 0) before the
 * buffer stops. Has to clear the deepest a dwelling rake's cab nose reaches
 * south of the station (~PLATFORM_NOSE_OFFSET_M + NOSE_L, see rake-geometry),
 * or a berthed train renders through its own buffers.
 */
export const TERMINUS_STUB_M = 360

/**
 * The stub of track south of Churchgate, the line's southern terminus, where
 * the corridor data stops but the platforms carry on.
 *
 * Parallel, and square-ended at the buffers. It used to taper: the roads
 * converged to a single point ~690 m out, on the theory that a terminus is a
 * throat. It is the opposite — a throat is where roads *gather* on the
 * approach from the country end, while past the platforms they simply stop,
 * each at its own buffer stop. Drawn as a taper it read as the four tracks
 * being bunched into a knot beyond the station.
 */
export function terminusStub(
  network: NetworkData,
  projection: Projection,
  spacingM: number,
  sectionTracks: number,
): { points: [number, number][]; buffer: [number, number]; angleRad: number }[] {
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
  const angleRad = Math.atan2(dirX, dirZ)
  const stubs: { points: [number, number][]; buffer: [number, number]; angleRad: number }[] = []
  for (let t = 0; t < sectionTracks; t++) {
    const off = centeredOffset(t, sectionTracks, spacingM)
    const at = (s: number): [number, number] => [
      ox - dirX * s + normX * off,
      oz - dirZ * s + normZ * off,
    ]
    // Sampled at the same stations the ballast bed uses out here (see
    // corridorSampleStations), not as one 360 m chord. Both take their height
    // from the terrain, so a track that chords a span the bed follows sinks
    // straight through it — which is exactly what a single-segment stub did,
    // by up to 4.2 scene-m, burying the rails at the terminus.
    const points: [number, number][] = []
    for (let s = TERMINUS_STUB_M; s > 0; s -= TURNOUT_SAMPLE_STEP_M) points.push(at(s))
    stubs.push({ points, buffer: at(TERMINUS_STUB_M), angleRad })
  }
  return stubs
}

/** A track's lateral offset when a section fans `tracks`-many parallel copies of the centerline. */
function centeredOffset(t: number, tracks: number, spacingM: number): number {
  return (t - (tracks - 1) / 2) * spacingM
}

export function smoothstep(x: number): number {
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
 * The cumulative scene lengths one section's track polylines are sampled at:
 * native centreline vertices through the middle, densified to
 * TURNOUT_SAMPLE_STEP_M inside each turnout window (so the eased offset
 * renders as a curve, not a straight chord between whatever OSM vertices
 * happen to fall nearby).
 */
function sectionSampleStations(
  sections: TrackSection[],
  s: number,
  lengths: number[],
  scale: number,
): number[] {
  const section = sections[s]
  const fromScene = section.fromM * scale
  const toScene = section.toM * scale
  const totalLen = toScene - fromScene
  if (totalLen <= 0) return []
  const half = Math.min(TURNOUT_HALF_WINDOW_M, totalLen / 2)
  const hasStart = s > 0
  const hasEnd = s < sections.length - 1
  const out: number[] = []
  if (hasStart) {
    for (let m = fromScene; m < fromScene + half; m += TURNOUT_SAMPLE_STEP_M) out.push(m)
  }
  const midFrom = hasStart ? fromScene + half : fromScene
  const midTo = hasEnd ? toScene - half : toScene
  if (midTo > midFrom) {
    out.push(midFrom)
    for (const l of lengths) if (l > midFrom && l < midTo) out.push(l)
    out.push(midTo)
  } else {
    out.push((midFrom + midTo) / 2)
  }
  if (hasEnd) {
    for (let m = toScene - half + TURNOUT_SAMPLE_STEP_M; m < toScene; m += TURNOUT_SAMPLE_STEP_M) {
      out.push(m)
    }
    out.push(toScene)
  }
  return out
}

/**
 * Every station the corridor is sampled at, across all sections, ascending
 * and deduplicated. Anything drawn *under* the rails — the ballast bed —
 * has to use exactly these, not the raw centreline vertices: both surfaces
 * take their height from the terrain, so wherever one chords a longer span
 * than the other, the two part company. Sampling the bed on the sparser
 * native vertices alone let it ride straight over dips the denser track
 * polylines follow down into, and the rails vanished under their own
 * ballast (worst case ~3 scene-m, in the turnout windows where the tracks
 * densify to 20 m and the bed still stepped 77 m).
 */
export function corridorSampleStations(network: NetworkData, track: TrainTrack): number[] {
  const total = track.lengths[track.lengths.length - 1]
  // Negative stations carry the bed out under the terminus stub (see
  // terminusStub): the corridor data stops at Churchgate, but the platform
  // roads run on to the buffers, and without this they run on over bare grass.
  const all: number[] = []
  for (let m = -TERMINUS_STUB_M; m < 0; m += TURNOUT_SAMPLE_STEP_M) all.push(m)
  for (let s = 0; s < network.sections.length; s++) {
    for (const m of sectionSampleStations(network.sections, s, track.lengths, track.scale)) {
      all.push(Math.min(total, m))
    }
  }
  return [...new Set(all)].sort((a, b) => a - b)
}

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

    // One base vertex per sampling station (see sectionSampleStations — the
    // ballast bed under these tracks samples the same stations), each keeping
    // its station so offsets and normals are measured along the corridor
    // rather than along this section's own clipped chord.
    const stations = sectionSampleStations(sections, s, lengths, scale)
    if (stations.length < 2) continue
    const base = stations.map((m) => pointAt(centerline, lengths, m))

    for (let t = 0; t < section.tracks; t++) {
      const staticOffset = centeredOffset(t, section.tracks, spacingM)
      const startEntry = startMatch?.nextOnly.includes(t) ?? false
      const startPair = startMatch?.matched.find((m) => m.nextIdx === t)
      const endExit = endMatch?.prevOnly.includes(t) ?? false
      const endPair = endMatch?.matched.find((m) => m.prevIdx === t)

      const points = base.map((p, i) => {
        const dFromStart = stations[i] - fromScene
        const dFromEnd = toScene - stations[i]
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
        const [nx, nz] = normalAt(centerline, lengths, stations[i])
        return [p[0] + nx * offset, p[1] + nz * offset] as [number, number]
      })
      out.push({ points })
    }
  }
  return out
}
