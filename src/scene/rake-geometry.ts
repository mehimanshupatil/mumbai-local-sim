/**
 * Rake dimensions and yard-siding placement shared between Fleet (draws the
 * rake) and CameraRig (targets it in follow mode) — kept in one place so a
 * parked train's follow-camera can never drift from where it's actually
 * rendered (ticket #17).
 */
import { COACH_GAP_SCENE_M, COACH_LENGTH_SCENE_M } from './config'

export const COACHES = 12
export const RAKE_LEN = COACHES * (COACH_LENGTH_SCENE_M + COACH_GAP_SCENE_M) - COACH_GAP_SCENE_M

/**
 * Parked-rake placement along a yard siding: slot 0 sits just clear of the
 * junction switch so it never overlaps the running lines, each later slot
 * nose-to-tail behind it. Independent of the siding's own drawn length —
 * poseAt extrapolates past a TrainTrack's ends (see track-geometry.ts), so a
 * short real siding just renders its rakes a bit past the drawn ballast
 * rather than clamping/crashing.
 */
const YARD_JUNCTION_CLEARANCE_M = RAKE_LEN / 2 + 40
const YARD_SLOT_GAP_M = 60

export function parkedSlotChainageM(slot: number | null): number {
  return YARD_JUNCTION_CLEARANCE_M + (slot ?? 0) * (RAKE_LEN + YARD_SLOT_GAP_M)
}
