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

/** Platform length, shared by StationDressing (draws it) and Fleet (aligns
 * a dwelling rake within it). Real WR platforms run ~600-670m for a 12-car halt. */
export const PLATFORM_LENGTH_SCENE_M = 620

/**
 * Vertical exaggeration for terrain relief. The corridor is coastal plain;
 * without it the Sahyadri foothills east of the line read as noise from a
 * 120 km camera distance.
 */
export const TERRAIN_EXAGGERATION = 2.5

/** Scene Y of the sea surface (slightly above the 0 m seabed contour). */
export const SEA_LEVEL_Y = 0.4

/**
 * Desktop-first: coarse-pointer devices get reduced pixel ratio and building
 * density, same UI.
 */
export const IS_COARSE_POINTER =
  typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
