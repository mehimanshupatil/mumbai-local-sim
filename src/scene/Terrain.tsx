import { useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color } from 'three'
import { SEA_LEVEL_Y, TERRAIN_EXAGGERATION } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'

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

/** The draped terrain mesh plus the sea plane. */
export function Terrain({ heightfield, projection }: { heightfield: Heightfield; projection: Projection }) {
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
  }, [heightfield, projection])

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
        <meshStandardMaterial color="#1e6a89" roughness={0.35} />
      </mesh>
    </group>
  )
}
