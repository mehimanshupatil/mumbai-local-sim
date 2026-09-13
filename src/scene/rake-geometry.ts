/**
 * Rake dimensions and yard-siding placement shared between Fleet (draws the
 * rake), Yards (draws the roads it stands on) and CameraRig (targets it in
 * follow mode) — kept in one place so a parked train's follow-camera and its
 * ballast can never drift from where it's actually rendered (ticket #17).
 */
import type { NetworkData } from '../data/network-types'
import { YARD_CAPACITY } from '../sim/simulate'
import { COACH_GAP_SCENE_M, COACH_LENGTH_SCENE_M, TRACK_SPACING_SCENE_M } from './config'
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
