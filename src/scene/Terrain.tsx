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
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const lon = meta.west + ((gx * STRIDE) / (meta.width - 1)) * (meta.east - meta.west)
        const lat = meta.north - ((gy * STRIDE) / (meta.height - 1)) * (meta.north - meta.south)
        const elev = sampleGeo(lon, lat)
        const [x, z] = projection.toScene([lon, lat])
        const i = (gy * w + gx) * 3
        positions[i] = x
        positions[i + 1] = elev * TERRAIN_EXAGGERATION
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
    const index = new Uint32Array((w - 1) * (h - 1) * 6)
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
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3))
    geo.setAttribute('color', new BufferAttribute(colors, 3))
    geo.setIndex(new BufferAttribute(index, 1))
    geo.computeVertexNormals()
    return geo
  }, [heightfield, projection, corridorGrid])

  const sea = useMemo(() => {
    const [wx, nz] = projection.toScene([heightfield.meta.west, heightfield.meta.north])
    const [ex, sz] = projection.toScene([heightfield.meta.east, heightfield.meta.south])
    return { cx: (wx + ex) / 2, cz: (nz + sz) / 2, w: (ex - wx) * 6, h: (sz - nz) * 6 }
  }, [heightfield, projection])

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial vertexColors flatShading roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[sea.cx, SEA_LEVEL_Y, sea.cz]}>
        <planeGeometry args={[sea.w, sea.h]} />
        <WaterMaterial color="#1e6a89" daylight={daylight} />
      </mesh>
    </group>
  )
}
