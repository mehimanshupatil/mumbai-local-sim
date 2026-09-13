import { useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color } from 'three'
import { SEA_LEVEL_Y, TERRAIN_EXAGGERATION } from './config'
import type { Daylight } from './daylight'
import { smooth } from './daylight'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { WaterMaterial } from './WaterMaterial'

/** Grid decimation: 1 = full heightfield resolution. */
const STRIDE = 2
/**
 * How far the terrain's border ring is extruded outward, flat, at its own
 * edge height and colour. The baked heightfield is a finite ~90x180 km plate,
 * and past its edge the world simply stopped: a pale band of bare sky sat
 * east of the Sahyadris even in the default top-down view, and any tilt
 * turned it into a cliff hanging in mid-air. A skirt continues the land to
 * well past the far plane, where haze finishes the job (see Atmosphere).
 */
const SKIRT_M = 400_000
/**
 * What the skirt fades to at its outer edge. Carrying each border vertex's
 * own colour all the way out smears the ramp into 400 km-long stripes; every
 * outer vertex sharing one dull inland tone turns that into a single gradient
 * away from the data instead.
 */
const HORIZON_COLOR = new Color('#6f7b5e')
const HORIZON_MIX = 0.93

/**
 * Clearance above the sea plane for any vertex the ramp still colours as land.
 *
 * Terrain Y is `elev * TERRAIN_EXAGGERATION`, so with the sea plane at
 * SEA_LEVEL_Y everything below `SEA_LEVEL_Y / TERRAIN_EXAGGERATION` real
 * metres sinks under it. The Vasai/Naigaon salt flats sit right in that band,
 * so decimated cells there punched hundreds of hard-edged blue holes through
 * tan mudflat — geometry saying "sea" while the colour ramp said "land".
 *
 * Elevation alone cannot fix this. Heights are Int16 whole metres, so the
 * open Arabian Sea and a Vasai salt flat are both stored as exactly 0, while
 * the colour ramp paints 0 as sand. Any threshold that floats the flats also
 * floats the ocean and lands Mumbai. Connectivity is the discriminator:
 * water reachable from the map border is sea, an isolated 0 m patch inland
 * is a flat, and only the latter is lifted clear of the plane.
 */
const SHORE_CLEARANCE_Y = 0.06

/** Elevation color ramp (real metres → land cover), mumbai-lakes style. */
const RAMP: [number, string][] = [
  [-50, '#284c56'], // seabed
  [0.5, '#b8a877'], // sand / mudflat
  [8, '#7c8f5a'], // coastal plain
  [60, '#5d7a45'], // wooded slopes
  [220, '#6e6a58'], // ridge rock
  [600, '#8d8877'], // high rock
]

function rampColor(h: number): Color {
  let lo = RAMP[0]
  let hi = RAMP[RAMP.length - 1]
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (h >= RAMP[i][0] && h < RAMP[i + 1][0]) {
      lo = RAMP[i]
      hi = RAMP[i + 1]
      break
    }
  }
  const t = Math.max(0, Math.min(1, (h - lo[0]) / (hi[0] - lo[0] || 1)))
  return new Color(lo[1]).lerp(new Color(hi[1]), t)
}

/**
 * Built-up tint blended atop the elevation ramp near the corridor — real
 * suburban Mumbai is dense trackside and fades to open land within a few
 * hundred metres. Distance found via a spatial grid over corridor points
 * (cell size = outer radius, so a 3x3 neighbourhood always covers it) —
 * a plain O(vertices x points) scan is too slow at heightfield resolution.
 */
const URBAN_INNER_R = 180
const URBAN_OUTER_R = 650
const URBAN_STRENGTH = 0.55
const URBAN_COLOR = new Color('#8f8a76')
const GRID_CELL = URBAN_OUTER_R

function buildCorridorGrid(points: [number, number][]): Map<string, [number, number][]> {
  const grid = new Map<string, [number, number][]>()
  for (const p of points) {
    const key = `${Math.floor(p[0] / GRID_CELL)},${Math.floor(p[1] / GRID_CELL)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(p)
    else grid.set(key, [p])
  }
  return grid
}

function distanceToCorridor(grid: Map<string, [number, number][]>, x: number, z: number): number {
  const cx = Math.floor(x / GRID_CELL)
  const cz = Math.floor(z / GRID_CELL)
  let best = Infinity
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(`${cx + dx},${cz + dz}`)
      if (!bucket) continue
      for (const [px, pz] of bucket) {
        const d = Math.hypot(px - x, pz - z)
        if (d < best) best = d
      }
    }
  }
  return best
}

/** The draped terrain mesh plus the sea plane. */
export function Terrain({
  heightfield,
  projection,
  daylight,
  corridor,
}: {
  heightfield: Heightfield
  projection: Projection
  daylight: Daylight
  /** Scene-space corridor centerline, for the urban tint's distance falloff. */
  corridor: [number, number][]
}) {
  const corridorGrid = useMemo(() => buildCorridorGrid(corridor), [corridor])

  const geometry = useMemo(() => {
    const { meta, sampleGeo } = heightfield
    const w = Math.floor((meta.width - 1) / STRIDE) + 1
    const h = Math.floor((meta.height - 1) / STRIDE) + 1
    const positions = new Float32Array(w * h * 3)
    const colors = new Float32Array(w * h * 3)
    const elevs = new Float32Array(w * h)
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const lon = meta.west + ((gx * STRIDE) / (meta.width - 1)) * (meta.east - meta.west)
        const lat = meta.north - ((gy * STRIDE) / (meta.height - 1)) * (meta.north - meta.south)
        const elev = sampleGeo(lon, lat)
        const [x, z] = projection.toScene([lon, lat])
        const i = (gy * w + gx) * 3
        elevs[gy * w + gx] = elev
        positions[i] = x
        positions[i + 2] = z
        const c = rampColor(elev)
        // Below sea level there's no built-up land to tint.
        if (elev >= 0.5) {
          const d = distanceToCorridor(corridorGrid, x, z)
          const urbanT = (1 - smooth(URBAN_INNER_R, URBAN_OUTER_R, d)) * URBAN_STRENGTH
          if (urbanT > 0) c.lerp(URBAN_COLOR, urbanT)
        }
        colors[i] = c.r
        colors[i + 1] = c.g
        colors[i + 2] = c.b
      }
    }

    // Flood-fill the real sea inward from the map border, then float every
    // at-or-below-sea-level cell the fill never reached (see SHORE_CLEARANCE_Y).
    const isSea = new Uint8Array(w * h)
    const queue = new Int32Array(w * h)
    let head = 0
    let tail = 0
    const flood = (idx: number) => {
      if (isSea[idx] || elevs[idx] > 0) return
      isSea[idx] = 1
      queue[tail++] = idx
    }
    for (let gx = 0; gx < w; gx++) {
      flood(gx)
      flood((h - 1) * w + gx)
    }
    for (let gy = 0; gy < h; gy++) {
      flood(gy * w)
      flood(gy * w + w - 1)
    }
    while (head < tail) {
      const idx = queue[head++]
      const gx = idx % w
      const gy = (idx / w) | 0
      if (gx > 0) flood(idx - 1)
      if (gx < w - 1) flood(idx + 1)
      if (gy > 0) flood(idx - w)
      if (gy < h - 1) flood(idx + w)
    }
    const floor = SEA_LEVEL_Y + SHORE_CLEARANCE_Y
    for (let idx = 0; idx < w * h; idx++) {
      const y = elevs[idx] * TERRAIN_EXAGGERATION
      positions[idx * 3 + 1] = isSea[idx] ? y : Math.max(y, floor)
    }

    // Border ring, extruded outward from each edge vertex — same height and
    // colour, so the join is seamless and the land just keeps going.
    const border: number[] = []
    for (let gx = 0; gx < w; gx++) border.push(gx)
    for (let gy = 1; gy < h; gy++) border.push(gy * w + w - 1)
    for (let gx = w - 2; gx >= 0; gx--) border.push((h - 1) * w + gx)
    for (let gy = h - 2; gy >= 1; gy--) border.push(gy * w)
    const skirtPos = new Float32Array((w * h + border.length) * 3)
    const skirtCol = new Float32Array((w * h + border.length) * 3)
    skirtPos.set(positions)
    skirtCol.set(colors)
    border.forEach((idx, j) => {
      const o = (w * h + j) * 3
      const x = positions[idx * 3]
      const z = positions[idx * 3 + 2]
      // Straight out of the edge this vertex sits on — corners, which are on
      // two edges at once, go diagonally. Extruding radially from the plate's
      // centre instead fans the whole ring into a starburst of long thin
      // triangles at wildly different heights, which is exactly what it looks
      // like on screen.
      const gx = idx % w
      const gy = (idx / w) | 0
      const sx = gx === 0 ? -1 : gx === w - 1 ? 1 : 0
      const sz = gy === 0 ? -1 : gy === h - 1 ? 1 : 0
      const len = Math.hypot(sx, sz) || 1
      // x follows gx (west to east), z follows gy (north to south).
      skirtPos[o] = x + (sx / len) * SKIRT_M
      // Tapered most of the way down to the coastal plain: the border can be
      // 600 m of Sahyadri ridge, and holding that height for 400 km reads as
      // one impossible plateau filling the eastern sky.
      skirtPos[o + 1] = positions[idx * 3 + 1] * 0.25
      skirtPos[o + 2] = z + (sz / len) * SKIRT_M
      const edge = new Color(colors[idx * 3], colors[idx * 3 + 1], colors[idx * 3 + 2])
      edge.lerp(HORIZON_COLOR, HORIZON_MIX)
      skirtCol[o] = edge.r
      skirtCol[o + 1] = edge.g
      skirtCol[o + 2] = edge.b
    })

    const index = new Uint32Array((w - 1) * (h - 1) * 6 + border.length * 6)
    let k = 0
    for (let gy = 0; gy < h - 1; gy++) {
      for (let gx = 0; gx < w - 1; gx++) {
        const a = gy * w + gx
        const b = a + 1
        const c = a + w
        const d = c + 1
        index[k++] = a
        index[k++] = c
        index[k++] = b
        index[k++] = b
        index[k++] = c
        index[k++] = d
      }
    }
    for (let j = 0; j < border.length; j++) {
      const j2 = (j + 1) % border.length
      const a = border[j]
      const b = border[j2]
      const c = w * h + j
      const d = w * h + j2
      // Wound the opposite way round from the grid quads above: the ring walks
      // the border clockwise in x/z, so the grid's own order would face these
      // downward and cull them.
      index[k++] = a
      index[k++] = b
      index[k++] = c
      index[k++] = b
      index[k++] = d
      index[k++] = c
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(skirtPos, 3))
    geo.setAttribute('color', new BufferAttribute(skirtCol, 3))
    geo.setIndex(new BufferAttribute(index, 1))
    geo.computeVertexNormals()
    return geo
  }, [heightfield, projection, corridorGrid])

  const sea = useMemo(() => {
    const [wx, nz] = projection.toScene([heightfield.meta.west, heightfield.meta.north])
    const [ex, sz] = projection.toScene([heightfield.meta.east, heightfield.meta.south])
    const w = Math.abs(ex - wx) * 6
    const h = Math.abs(sz - nz) * 6
    // The plane runs 6x the terrain so the ocean reaches the horizon west of
    // the coast — but centring it that wide also pushed sea out past the
    // terrain's eastern edge, painting a blue band on the skyline *behind*
    // the Sahyadris, where there is only land. Anchor the east edge to the
    // terrain instead and let the overhang fall to the seaward side.
    const eastEdge = Math.max(wx, ex)
    return { cx: eastEdge - w / 2, cz: (nz + sz) / 2, w, h }
  }, [heightfield, projection])

  return (
    <group>
      <mesh geometry={geometry}>
        {/* Smooth-shaded: computeVertexNormals() above already produces the
            normals, and flatShading discarded them, rendering the STRIDE=2
            grid's ~290 m triangles as hard-edged low-poly facets. */}
        <meshStandardMaterial vertexColors roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[sea.cx, SEA_LEVEL_Y, sea.cz]}>
        <planeGeometry args={[sea.w, sea.h]} />
        <WaterMaterial color="#1e6a89" daylight={daylight} />
      </mesh>
    </group>
  )
}
