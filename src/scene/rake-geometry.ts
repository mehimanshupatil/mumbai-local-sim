/**
 * Rake dimensions and yard-siding placement shared between Fleet (draws the
 * rake), Yards (draws the roads it stands on) and CameraRig (targets it in
 * follow mode) — kept in one place so a parked train's follow-camera and its
 * ballast can never drift from where it's actually rendered (ticket #17).
 */
import type { NetworkData } from '../data/network-types'
import { YARD_CAPACITY } from '../sim/simulate'
import { TRACK_EXPRESS_DOWN, TRACK_EXPRESS_UP, TRACK_FAST_DOWN, TRACK_FAST_UP } from '../sim/types'
import {
  COACH_GAP_SCENE_M,
  COACH_LENGTH_SCENE_M,
  PLATFORM_LENGTH_SCENE_M,
  TRACK_SPACING_SCENE_M,
} from './config'
import type { Projection } from './projection'
import { buildYardRoads, type TrainTrack } from './track-geometry'

export const COACHES = 12
export const RAKE_LEN = COACHES * (COACH_LENGTH_SCENE_M + COACH_GAP_SCENE_M) - COACH_GAP_SCENE_M

/**
 * A yard stables its rakes on parallel roads, one rake each — what an EMU
 * carshed actually looks like, and the only layout that fits: nose-to-tail
 * slots on a single siding need ~2.4 km of it for YARD_CAPACITY rakes, which
 * is longer than three of this line's four sheds are drawn.
 */
export const YARD_ROADS = YARD_CAPACITY
/** Throat length each road diverges off the running lines over. Long enough
 * that the divergence reads as a turnout rather than a hard kink. */
const YARD_THROAT_M = 500
/** Clear ground either end of a parked rake, so the road reads as a road and
 * not as a rake-shaped piece of ballast. */
const YARD_ROAD_MARGIN_M = 80
/** Straight stabling length past the throat. */
const YARD_ROAD_M = RAKE_LEN + 2 * YARD_ROAD_MARGIN_M
/**
 * Clear strip between the outermost running lane and the first stabling road:
 * the corridor's own ballast margin (see StationDressing's BALLAST_MARGIN_M)
 * plus enough ground that the yard reads as separate from the running lines.
 */
const YARD_CLEARANCE_M = 72

/** Where a parked rake's nose sits along its road: clear of the throat. */
export const PARKED_RAKE_CHAINAGE_M = YARD_THROAT_M + YARD_ROAD_MARGIN_M + RAKE_LEN

/** Every yard's stabling roads, by yard id. */
export function buildYardRoadTracks(
  network: NetworkData,
  projection: Projection,
  corridor: TrainTrack,
): Map<string, TrainTrack[]> {
  return new Map(
    network.yards.map(
      (yard) =>
        [
          yard.id,
          buildYardRoads(yard, projection, corridor, network.sections, {
            roads: YARD_ROADS,
            spacingM: TRACK_SPACING_SCENE_M,
            clearanceM: YARD_CLEARANCE_M,
            throatM: YARD_THROAT_M,
            roadM: YARD_ROAD_M,
          }),
        ] as const,
    ),
  )
}

/** The road a parked rake stands on; slot comes from the sim (ticket #17). */
export function roadForSlot(roads: TrainTrack[], slot: number | null): TrainTrack {
  return roads[Math.min(roads.length - 1, Math.max(0, slot ?? 0))]
}

/**
 * Drawn lane for a semantic track index within a section. Narrow sections
 * fold expresses onto the fast pair (up direction first, so opposing
 * expresses never share a lane), and the two-track stretch folds everything
 * onto the single up/down pair.
 *
 * Shared with CameraRig, not just Fleet: a cab or lineside camera has to sit
 * on the lane the rake is actually drawn on, or it floats between tracks.
 */
export function laneFor(track: number, sectionTracks: number): number {
  const isUp = track % 2 === 1 // all *_UP constants are odd by construction
  if (sectionTracks >= 6) return track
  if (track === TRACK_EXPRESS_DOWN || track === TRACK_EXPRESS_UP) {
    // A lone 5th line hosts down expresses; up expresses join the fast pair.
    if (sectionTracks === 5 && !isUp) return 4
    track = isUp ? TRACK_FAST_UP : TRACK_FAST_DOWN
  }
  if (sectionTracks <= 2) return isUp ? 1 : 0
  return Math.min(track, sectionTracks - 1)
}

/** Lateral offset of a drawn lane from the corridor centreline. */
export function laneLateralM(track: number, sectionTracks: number): number {
  return (laneFor(track, sectionTracks) - (sectionTracks - 1) / 2) * TRACK_SPACING_SCENE_M
}

/** Length of the cab nose capping each end of a rake. */
export const NOSE_L = 14
/** How close a dwelling rake's nose pulls up to the platform's far edge (in
 * the direction of travel) — a real driver pulls up as far as the starter
 * signal allows, not to the platform's midpoint. */
const PLATFORM_NOSE_MARGIN_M = 15
export const PLATFORM_NOSE_OFFSET_M = PLATFORM_LENGTH_SCENE_M / 2 - PLATFORM_NOSE_MARGIN_M
/**
 * Distance (from the relevant stop, approaching or departing) over which the
 * nose offset blends in/out. Keyed on DISTANCE rather than speed: a speed-based
 * blend stalls near a stop, where speed is ~0 but position is still changing —
 * it reads as "hesitates, then darts to the platform edge" on arrival, and on
 * departure it regresses outright, sliding the rake backwards. A distance-keyed
 * smoothstep grows and shrinks in step with actual position instead.
 *
 * The margin above PLATFORM_NOSE_OFFSET_M keeps the nose's net motion
 * non-negative even at the steepest point of the smoothstep curve (its
 * derivative peaks at 1.5x the linear rate at the midpoint) — 2x leaves the
 * nose visibly still advancing there, not just barely non-decreasing.
 */
const PLATFORM_EDGE_BLEND_M = PLATFORM_NOSE_OFFSET_M * 2

function edgeBlend(distanceM: number): number {
  const t = Math.max(0, Math.min(1, distanceM / PLATFORM_EDGE_BLEND_M))
  return 1 - t * t * (3 - 2 * t) // smoothstep, inverted: 1 at distance 0, 0 past the blend window
}

/**
 * How far ahead of its sim chainage a rake is actually drawn, unsigned.
 *
 * TrainState.chainageM is the rake's leading edge while moving (correct for a
 * real train's front relative to signals/platforms) — but while dwelling it
 * equals the station's own chainage exactly, and platforms are centred on that
 * same point, so an unshifted rake hangs most of its length off the back of
 * the platform. Blended continuously rather than gated on `dwelling`, which
 * would snap the whole rake forward the instant dwelling starts.
 *
 * Shared with CameraRig: a cab camera placed at the sim chainage sits inside
 * its own rake wherever this offset is non-zero, which is every approach to
 * and departure from a station.
 */
export function platformNoseOffsetM(
  chainageM: number,
  nextStopChainageM: number,
  legDistanceM: number,
): number {
  const approach = edgeBlend(Math.abs(nextStopChainageM - chainageM))
  const depart = edgeBlend(legDistanceM)
  return PLATFORM_NOSE_OFFSET_M * Math.max(approach, depart)
}
