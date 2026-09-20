/**
 * Layout of the Livery mask atlas — the single source of truth shared by the
 * bake script (scripts/bake-livery-atlas.ts, which draws it) and the Rake
 * material (which samples it). Kept in one place so the painted pixels and the
 * UVs that read them can never drift, the same reason rake-geometry.ts exists.
 *
 * The atlas holds *masks*, not colour. Livery stays per-instance (Fleet's
 * setColorAt), so one atlas serves every Livery and every Stock there will ever
 * be — adding a Livery is a colour constant, not a re-bake. See
 * docs/adr/0003-rake-detail-is-a-baked-mask-atlas.md.
 *
 * No three.js import here: the bake script runs this in Node.
 */

/** One texture, four masks. Square and power-of-two for mipmaps. */
export const ATLAS_SIZE = 1024

/**
 * What each channel carries. Roof grime and brake dust share DIRT because at
 * the follow camera they are one phenomenon at two heights; merging them frees
 * a channel for PANEL. See the ADR.
 */
export const CHANNEL = {
  /** Where glass is. Doubles as the night emissive mask. */
  WINDOW: 0,
  /** Where the carbody is open. A Mumbai local runs with its doorways open
   *  throughout (CONTEXT.md, Dwell), so this is a permanent hole, not a door. */
  DOORWAY: 1,
  /** Roof accumulation and brake dust on the skirt. */
  DIRT: 2,
  /** Body seams, rivet lines, underframe shadow. */
  PANEL: 3,
} as const
export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL]

/** A rectangle in atlas pixels, y down from the top-left. */
export interface Region {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The three surfaces a coach needs. Sized by how much detail each carries
 * rather than by its real area: the side is where every window and doorway
 * lives and gets the most texels, the cab face is small but is what the follow
 * camera looks straight at, and the roof is mostly dirt gradient.
 */
export const REGION = {
  /** One coach side, tiled along the body. */
  side: { x: 0, y: 0, w: 1024, h: 512 },
  /** The driving end: windscreen, lights, coupler. */
  cab: { x: 0, y: 512, w: 512, h: 384 },
  /** Roof: pantograph well, vents, centreline grime. */
  roof: { x: 512, y: 512, w: 512, h: 384 },
} as const satisfies Record<string, Region>
export type RegionName = keyof typeof REGION

/** Atlas-space UV rect for a region, for the material to offset/scale into. */
export function uvRect(name: RegionName): {
  offset: [number, number]
  scale: [number, number]
} {
  const r = REGION[name]
  return {
    // Atlas y runs down; UV v runs up.
    offset: [r.x / ATLAS_SIZE, 1 - (r.y + r.h) / ATLAS_SIZE],
    scale: [r.w / ATLAS_SIZE, r.h / ATLAS_SIZE],
  }
}

/**
 * Which channels each region actually carries. Declared here rather than
 * discovered from the pixels, so the invariant test checks the bake against
 * the layout's intent: a cab face has no doorway, a roof has no glass.
 */
export const REGION_CHANNELS = {
  side: [CHANNEL.WINDOW, CHANNEL.DOORWAY, CHANNEL.DIRT, CHANNEL.PANEL],
  cab: [CHANNEL.WINDOW, CHANNEL.DIRT, CHANNEL.PANEL],
  roof: [CHANNEL.DIRT, CHANNEL.PANEL],
} as const satisfies Record<RegionName, readonly Channel[]>

/**
 * Real coach proportions, in metres, as the masks are laid out from.
 *
 * Reference is the WR suburban EMU as it actually runs, not an invented
 * layout: a 12-car rake is four 3-car units (CAMTECH/2009/E/Trg/AC-DC EMU
 * training package, Fig. 4), the body is ~12 ft wide (IRFCA MU FAQ), and IR
 * suburban stock carries eight entrance doorways per coach, four a side. The
 * doorways have no doors to draw: a Mumbai local runs with them open
 * throughout (CONTEXT.md, Dwell), which is what makes them a mask channel of
 * their own rather than a panel line.
 *
 * Heights are given above floor level, which is where a doorway and a window
 * are actually dimensioned from; sideV converts them to region coordinates.
 */
export const COACH = {
  /** Over body. COACH_LENGTH_SCENE_M in scene/config.ts is this plus coupling. */
  bodyLenM: 20.7,
  /** ~12 ft over body — wider than a mainline IR coach. */
  bodyWidthM: 3.66,
  /** Body above floor, floor to roof gutter. */
  aboveFloorM: 2.95,
  /** Solebar, underframe kit and skirt below floor. */
  belowFloorM: 0.95,
  /** Four a side, evenly spaced, first centred this far along the body. */
  doorsPerSide: 4,
  doorCentreFrac: [0.14, 0.38, 0.62, 0.86],
  doorWidthM: 1.25,
  doorHeightM: 1.95,
  /** Lift-up window: clear glass from sill to head. */
  windowSillM: 1.15,
  windowHeadM: 2.05,
  /** Fixed polycarbonate louvre strip above the lift-up pane (Siemens stock). */
  louvreTopM: 2.35,
  /** Window pitch along a bay: one pane plus one body pillar. */
  windowWidthM: 1.0,
  windowPitchM: 1.24,
} as const

/** Total height the side region spans: gutter to the bottom of the skirt. */
export const SIDE_HEIGHT_M = COACH.aboveFloorM + COACH.belowFloorM

/** Height above floor → v within the side region (0 at the gutter, 1 at the skirt). */
export function sideV(heightAboveFloorM: number): number {
  return (COACH.aboveFloorM - heightAboveFloorM) / SIDE_HEIGHT_M
}

/** Length along the body → u within the side region. */
export function sideU(alongM: number): number {
  return alongM / COACH.bodyLenM
}

/**
 * Where the committed atlas lands under public/. Relative, no leading slash:
 * consumers prefix import.meta.env.BASE_URL (the site is served from a
 * subpath on Pages), the same way fonts.ts and bed.ts do.
 */
export const ATLAS_PATH = 'livery/rake-masks.png'
