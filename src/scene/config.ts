/**
 * Render-time exaggeration. Network data is true-scale; a 120 km corridor
 * makes true-scale details (5 m track spacing, 3 m-wide trains) invisible
 * from any useful camera height, so visuals scale up by this factor.
 */
export const RENDER_EXAGGERATION = 5

/** Scene-space gap between track centrelines (real IR spacing is ~5 m). */
export const TRACK_SPACING_SCENE_M = 5 * RENDER_EXAGGERATION

/**
 * Coach length is exaggerated less than width/height: a real 12-car rake is
 * ~255 m, and 5x would stretch it past a whole inter-station gap.
 */
export const COACH_LENGTH_SCENE_M = 21.3 * 2
export const COACH_GAP_SCENE_M = 4
