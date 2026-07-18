/**
 * Baked terrain heightfield (public/terrain/, produced by pnpm bake:terrain).
 * Loaded once at startup; samples answer both geographic and scene-space
 * queries. Heights are real metres; TERRAIN_EXAGGERATION scales scene Y.
 */
import { TERRAIN_EXAGGERATION } from './config'
import type { Projection } from './projection'

export interface TerrainMeta {
  width: number
  height: number
  west: number
  east: number
  north: number
  south: number
}

export interface Heightfield {
  meta: TerrainMeta
  /** Real metres above sea level at a geographic point (bilinear). */
  sampleGeo: (lon: number, lat: number) => number
  /** Exaggerated scene Y at a scene-space point. */
  sceneY: (x: number, z: number) => number
  /** Scene Y the rail formation sits at: embanked above ground and water. */
  railY: (x: number, z: number) => number
}

/** Rails ride an embankment; creek/bay crossings become low bridges. */
const EMBANKMENT_M = 2

export async function loadHeightfield(projection: Projection): Promise<Heightfield> {
  const base = import.meta.env.BASE_URL
  const [meta, bin] = await Promise.all([
    fetch(`${base}terrain/meta.json`).then((r) => {
      if (!r.ok) throw new Error(`terrain meta: HTTP ${r.status}`)
      return r.json() as Promise<TerrainMeta>
    }),
    fetch(`${base}terrain/heights.bin`).then((r) => {
      if (!r.ok) throw new Error(`terrain heights: HTTP ${r.status}`)
      return r.arrayBuffer()
    }),
  ])
  const heights = new Int16Array(bin)

  const sampleGeo = (lon: number, lat: number): number => {
    const fx = ((lon - meta.west) / (meta.east - meta.west)) * (meta.width - 1)
    const fy = ((meta.north - lat) / (meta.north - meta.south)) * (meta.height - 1)
    const x0 = Math.max(0, Math.min(meta.width - 2, Math.floor(fx)))
    const y0 = Math.max(0, Math.min(meta.height - 2, Math.floor(fy)))
    const tx = Math.max(0, Math.min(1, fx - x0))
    const ty = Math.max(0, Math.min(1, fy - y0))
    const at = (x: number, y: number) => heights[y * meta.width + x]
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx
    return top * (1 - ty) + bottom * ty
  }

  const sceneY = (x: number, z: number): number => {
    const [lon, lat] = projection.toGeo(x, z)
    return sampleGeo(lon, lat) * TERRAIN_EXAGGERATION
  }

  const railY = (x: number, z: number): number =>
    Math.max(sceneY(x, z), 0) + EMBANKMENT_M * TERRAIN_EXAGGERATION

  return { meta, sampleGeo, sceneY, railY }
}
