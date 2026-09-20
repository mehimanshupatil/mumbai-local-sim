/**
 * Bake the Livery mask atlas: public/livery/rake-masks.png.
 *
 * One 1024x1024 RGBA PNG of greyscale masks — window / doorway / dirt / panel
 * lines, one per channel — drawn from the committed proportions in
 * src/scene/livery-atlas.ts. Masks, not colour: Livery stays per-instance in
 * Fleet's setColorAt, so one atlas serves every Livery and every Stock there
 * will ever be. See docs/adr/0003-rake-detail-is-a-baked-mask-atlas.md.
 *
 * Deterministic by construction — every mark is a pure function of the layout
 * constants, and the "noise" is a hash of the texel coordinate, not a PRNG
 * with hidden state. A re-bake is byte-identical; `--check` asserts that
 * against the committed file instead of writing.
 *
 * Usage: pnpm bake:livery [--check]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import {
  ATLAS_PATH,
  ATLAS_SIZE,
  CHANNEL,
  COACH,
  REGION,
  sideU,
  sideV,
  type Channel,
  type Region,
} from '../src/scene/livery-atlas'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = join(ROOT, 'public', ATLAS_PATH)

/* -------------------------------------------------------------------------
 * Painting primitives
 *
 * Everything below paints in region-local (u, v) — 0..1 across a region, v
 * down from its top edge — so the layout reads in the same coordinates the
 * proportions are declared in, and moving a region in the atlas moves its
 * pixels with it.
 * ---------------------------------------------------------------------- */

/** RGBA texels, one byte per channel. */
type Pixels = Uint8Array

/**
 * Paint one channel of one region. `value` returns 0..1 per texel and is
 * combined with what is already there by max, so overlapping marks add detail
 * instead of erasing each other (a vent over roof grime, a pillar over glass).
 */
function paint(
  px: Pixels,
  region: Region,
  channel: Channel,
  value: (u: number, v: number) => number,
): void {
  for (let y = 0; y < region.h; y++) {
    // Texel centres, so a mark's edges land the same either way up.
    const v = (y + 0.5) / region.h
    for (let x = 0; x < region.w; x++) {
      const u = (x + 0.5) / region.w
      const got = value(u, v)
      if (got <= 0) continue
      const i = ((region.y + y) * ATLAS_SIZE + region.x + x) * 4 + channel
      const byte = Math.round(Math.min(1, got) * 255)
      if (byte > px[i]) px[i] = byte
    }
  }
}

/** A rectangle with a soft edge, in region-local coords. `feather` is in u/v. */
function rect(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  { value = 1, feather = 0 }: { value?: number; feather?: number } = {},
): (u: number, v: number) => number {
  return (u, v) => {
    if (u < u0 - feather || u > u1 + feather || v < v0 - feather || v > v1 + feather) return 0
    if (feather <= 0) return value
    // Distance inside the rect, in edge-widths, clamped: 1 in the middle.
    const du = Math.min(u - (u0 - feather), u1 + feather - u) / (2 * feather)
    const dv = Math.min(v - (v0 - feather), v1 + feather - v) / (2 * feather)
    return value * Math.min(1, du) * Math.min(1, dv)
  }
}

/** Union of several marks: whichever is strongest at this texel. */
function union(...marks: ((u: number, v: number) => number)[]) {
  return (u: number, v: number) => {
    let out = 0
    for (const mark of marks) out = Math.max(out, mark(u, v))
    return out
  }
}

/** Hash of a texel coordinate → 0..1. Stateless, so the bake stays reproducible. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

/** Value noise on a `cells`-square lattice over the region. */
function noise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells
  const y = v * cells
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smoothstep(x - x0)
  const fy = smoothstep(y - y0)
  const c00 = hash2(x0 + seed, y0)
  const c10 = hash2(x0 + 1 + seed, y0)
  const c01 = hash2(x0 + seed, y0 + 1)
  const c11 = hash2(x0 + 1 + seed, y0 + 1)
  return (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy
}

/** Two octaves is all grime needs at this camera distance. */
function grime(u: number, v: number, cells: number, seed: number): number {
  return 0.65 * noise(u, v, cells, seed) + 0.35 * noise(u, v, cells * 3, seed + 97)
}

/* -------------------------------------------------------------------------
 * The coach side
 * ---------------------------------------------------------------------- */

/** Each doorway as a region-local rect: floor to door head, four a side. */
function doorways(): ((u: number, v: number) => number)[] {
  const halfW = sideU(COACH.doorWidthM) / 2
  const top = sideV(COACH.doorHeightM)
  const floor = sideV(0)
  return COACH.doorCentreFrac.map((centre) =>
    rect(centre - halfW, top, centre + halfW, floor, { feather: 0.002 }),
  )
}

/**
 * The window panes between the doorways.
 *
 * Bays are whatever the doorways leave; each is filled with as many panes at
 * the real pitch as fit, centred in the bay, so the pillar spacing falls out
 * of the dimensions rather than being counted by hand. With four doorways a
 * side that comes to three panes in each inner bay and one in the short bays
 * past the end doorways, which is how the stock reads.
 */
function windowPanes(): ((u: number, v: number) => number)[] {
  const halfDoor = sideU(COACH.doorWidthM) / 2
  const edges = [0, ...COACH.doorCentreFrac, 1]
  const panes: ((u: number, v: number) => number)[] = []
  const sill = sideV(COACH.windowSillM)
  const head = sideV(COACH.windowHeadM)
  const louvre = sideV(COACH.louvreTopM)
  const paneW = sideU(COACH.windowWidthM)
  const pitch = sideU(COACH.windowPitchM)
  for (let i = 0; i < edges.length - 1; i++) {
    // Bay between two doorways (or between the body end and a doorway).
    const from = i === 0 ? sideU(0.35) : edges[i] + halfDoor
    const to = i === edges.length - 2 ? 1 - sideU(0.35) : edges[i + 1] - halfDoor
    const count = Math.floor((to - from + (pitch - paneW)) / pitch)
    if (count < 1) continue
    const span = count * pitch - (pitch - paneW)
    const start = from + (to - from - span) / 2
    for (let n = 0; n < count; n++) {
      const u0 = start + n * pitch
      // Glass, plus the fixed louvre strip above it at half strength — it is
      // polycarbonate, so it lights at night but never reads as clear glass.
      panes.push(rect(u0, head, u0 + paneW, sill, { feather: 0.0015 }))
      panes.push(rect(u0, louvre, u0 + paneW, head, { value: 0.55, feather: 0.0015 }))
    }
  }
  return panes
}

function paintSide(px: Pixels): void {
  const region = REGION.side
  const doors = doorways()
  const openDoorway = union(...doors)

  paint(px, region, CHANNEL.DOORWAY, openDoorway)

  // Glass everywhere except where a doorway has cut the body away.
  const panes = union(...windowPanes())
  paint(px, region, CHANNEL.WINDOW, (u, v) => (openDoorway(u, v) > 0.5 ? 0 : panes(u, v)))

  // Dirt: roof wash spilling over the cantrail, brake dust thrown up the
  // skirt, and a streak under each doorway where feet and rain take the paint.
  const floor = sideV(0)
  const gutter = sideV(COACH.aboveFloorM)
  paint(px, region, CHANNEL.DIRT, (u, v) => {
    const fromRoof = 0.85 * Math.max(0, 1 - (v - gutter) / 0.16) * (0.55 + 0.45 * grime(u, v, 24, 11))
    const fromBrakes = 0.9 * smoothstep((v - floor) / (1 - floor)) * (0.5 + 0.5 * grime(u, v, 18, 23))
    let atDoors = 0
    for (const centre of COACH.doorCentreFrac) {
      const across = Math.abs(u - centre) / (sideU(COACH.doorWidthM) * 0.9)
      if (across > 1) continue
      const below = smoothstep((v - sideV(1.2)) / (floor - sideV(1.2)))
      atDoors = Math.max(atDoors, 0.5 * (1 - across) * below * (0.6 + 0.4 * grime(u, v, 40, 31)))
    }
    return Math.max(fromRoof, Math.max(fromBrakes, atDoors))
  })

  // Panel lines: the horizontal body datums (gutter, window sill, waist,
  // solebar), a pillar seam beside every doorway, and the underframe in
  // shadow below the floor.
  const band = (heightM: number, thicknessM: number, value = 1) => {
    const half = (thicknessM / (COACH.aboveFloorM + COACH.belowFloorM)) / 2
    const v = sideV(heightM)
    return rect(0, v - half, 1, v + half, { value, feather: half })
  }
  const pillars = COACH.doorCentreFrac.flatMap((centre) => {
    const half = sideU(COACH.doorWidthM) / 2
    const seam = sideU(0.06)
    return [
      rect(centre - half - seam, sideV(COACH.doorHeightM), centre - half, sideV(0), { value: 0.8 }),
      rect(centre + half, sideV(COACH.doorHeightM), centre + half + seam, sideV(0), { value: 0.8 }),
    ]
  })
  paint(
    px,
    region,
    CHANNEL.PANEL,
    union(
      band(COACH.aboveFloorM, 0.08), // roof gutter
      band(COACH.louvreTopM, 0.05, 0.7), // top of the louvre strip
      band(COACH.windowSillM, 0.06, 0.85), // window sill line
      band(0.0, 0.1), // solebar
      rect(0, sideV(0) + 0.02, 1, 1, { value: 0.75, feather: 0.01 }), // underframe shadow
      ...pillars,
    ),
  )
}

/* -------------------------------------------------------------------------
 * The cab face
 * ---------------------------------------------------------------------- */

/**
 * The driving end, seen head-on: two windscreen panes over the driver's desk,
 * the destination board above them, marker and head lamps low on the face,
 * and the coupler in shadow at the bottom. Proportions are across the body
 * width (u) and the same heights above floor as the side (v), so the two
 * regions line up where they meet at the corner.
 */
function paintCab(px: Pixels): void {
  const region = REGION.cab
  const vAt = (heightAboveFloorM: number) => sideV(heightAboveFloorM)

  const screenTop = vAt(2.3)
  const screenBottom = vAt(1.35)
  paint(
    px,
    region,
    CHANNEL.WINDOW,
    union(
      rect(0.13, screenTop, 0.47, screenBottom, { feather: 0.004 }),
      rect(0.53, screenTop, 0.87, screenBottom, { feather: 0.004 }),
      // The cab door's droplight, one either side of the nose.
      rect(0.02, vAt(2.1), 0.1, vAt(1.5), { value: 0.9, feather: 0.004 }),
      rect(0.9, vAt(2.1), 0.98, vAt(1.5), { value: 0.9, feather: 0.004 }),
    ),
  )

  paint(
    px,
    region,
    CHANNEL.PANEL,
    union(
      // Destination board recess over the windscreens.
      rect(0.28, vAt(2.75), 0.72, vAt(2.4), { feather: 0.004 }),
      // Windscreen surround and the divider between the panes.
      rect(0.47, screenTop, 0.53, screenBottom, { value: 0.9 }),
      // Lamp cases: two markers high, two heads low.
      rect(0.08, vAt(2.55), 0.18, vAt(2.35), { value: 0.85, feather: 0.004 }),
      rect(0.82, vAt(2.55), 0.92, vAt(2.35), { value: 0.85, feather: 0.004 }),
      rect(0.16, vAt(0.85), 0.29, vAt(0.55), { feather: 0.004 }),
      rect(0.71, vAt(0.85), 0.84, vAt(0.55), { feather: 0.004 }),
      // Buffer beam, and the coupler pocket in shadow beneath it.
      rect(0, vAt(0.15), 1, vAt(0.0), { value: 0.9, feather: 0.003 }),
      rect(0.38, vAt(0.0), 0.62, 1, { feather: 0.006 }),
    ),
  )

  // Dirt on a cab face is thrown up from the track, heaviest at the bottom
  // corners, with the windscreens kept wiped.
  paint(px, region, CHANNEL.DIRT, (u, v) => {
    const low = smoothstep((v - vAt(1.6)) / (vAt(0) - vAt(1.6)))
    const corners = 0.6 + 0.4 * Math.abs(u - 0.5) * 2
    const wiped = u > 0.1 && u < 0.9 && v > screenTop && v < screenBottom ? 0.15 : 1
    return 0.85 * low * corners * wiped * (0.55 + 0.45 * grime(u, v, 14, 47))
  })
}

/* -------------------------------------------------------------------------
 * The roof
 * ---------------------------------------------------------------------- */

/**
 * Roof plan: u along the body, v across it. A pantograph well over one end
 * (only motor coaches carry one — the geometry decides which coaches get this
 * region, the mask just has it), ventilator rows down the centre, and the
 * centreline grime every EMU roof wears.
 */
function paintRoof(px: Pixels): void {
  const region = REGION.roof
  const vents: ((u: number, v: number) => number)[] = []
  const VENT_COUNT = 8
  for (let i = 0; i < VENT_COUNT; i++) {
    const u = 0.1 + (i * 0.8) / (VENT_COUNT - 1)
    vents.push(rect(u - 0.022, 0.4, u + 0.022, 0.6, { feather: 0.004 }))
  }
  paint(
    px,
    region,
    CHANNEL.PANEL,
    union(
      // Pantograph well and its insulator pads.
      rect(0.16, 0.22, 0.44, 0.78, { value: 0.9, feather: 0.006 }),
      rect(0.2, 0.3, 0.24, 0.38, {}),
      rect(0.36, 0.3, 0.4, 0.38, {}),
      rect(0.2, 0.62, 0.24, 0.7, {}),
      rect(0.36, 0.62, 0.4, 0.7, {}),
      // Roof sheet seams across the body, and the cable duct along it.
      rect(0.48, 0.46, 1, 0.54, { value: 0.8, feather: 0.004 }),
      ...vents,
    ),
  )

  // Grime: heaviest along the centreline where nothing washes it off, and
  // pooled around the pantograph well.
  paint(px, region, CHANNEL.DIRT, (u, v) => {
    const centre = 0.55 + 0.45 * (1 - Math.min(1, Math.abs(v - 0.5) / 0.35))
    const wellPool = 0.35 * (1 - Math.min(1, Math.hypot((u - 0.3) / 0.28, (v - 0.5) / 0.4)))
    return Math.min(1, centre * (0.5 + 0.5 * grime(u, v, 16, 71)) + Math.max(0, wellPool))
  })
}

/* ---------------------------------------------------------------------- */

/** The whole atlas as raw RGBA texels. Pure: same output, every run. */
export function renderAtlas(): Pixels {
  const px = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4)
  paintSide(px)
  paintCab(px)
  paintRoof(px)
  return px
}

/**
 * The atlas as PNG bytes. Deflate settings are pinned rather than left to
 * pngjs's defaults so "byte-identical re-bake" stays a property of this file
 * and not of a dependency's default.
 */
export function renderAtlasPng(): Buffer {
  const png = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE, colorType: 6 })
  png.data = Buffer.from(renderAtlas())
  return PNG.sync.write(png, {
    colorType: 6,
    deflateLevel: 9,
    deflateStrategy: 3,
    // Paeth on every row: a fixed filter (not pngjs's per-row heuristic) keeps
    // the bytes reproducible, and on masks it is a third the size of no filter.
    filterType: 4,
  })
}

function main(): void {
  const buf = renderAtlasPng()
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT_FILE)) throw new Error(`${OUT_FILE} missing; run pnpm bake:livery`)
    const committed = readFileSync(OUT_FILE)
    if (!committed.equals(buf)) {
      throw new Error(`${ATLAS_PATH} is stale: re-bake drifts from the committed file`)
    }
    console.log(`${ATLAS_PATH} matches a fresh bake (${buf.length} bytes)`)
    return
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, buf)
  console.log(`wrote ${OUT_FILE} (${ATLAS_SIZE}x${ATLAS_SIZE}, ${buf.length} bytes)`)
}

// Only when run as a script: the invariant test imports renderAtlasPng to
// check the committed file against a fresh render, and must not write one.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
