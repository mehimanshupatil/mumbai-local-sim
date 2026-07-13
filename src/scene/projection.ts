/**
 * Maps WGS84 network coordinates into scene space: metres on the XZ plane,
 * origin at the corridor's bounding-box centre, +x east, -z north (so the
 * default three.js camera looking down -z faces up the line). True scale —
 * any visual exaggeration happens in the components that consume this.
 */
import type { LonLat } from '../data/geo'
import type { NetworkData } from '../data/network-types'

const M_PER_DEG_LAT = 111_320

export interface Projection {
  /** [x, z] scene metres. */
  toScene: (p: LonLat) => [number, number]
  /** Corridor bounding box in scene metres. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}

export function createProjection(network: NetworkData): Projection {
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of network.corridor) {
    minLon = Math.min(minLon, lon)
    maxLon = Math.max(maxLon, lon)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  const lon0 = (minLon + maxLon) / 2
  const lat0 = (minLat + maxLat) / 2
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180)

  const toScene = ([lon, lat]: LonLat): [number, number] => [
    (lon - lon0) * mPerDegLon,
    -(lat - lat0) * M_PER_DEG_LAT,
  ]

  const [ax, az] = toScene([minLon, minLat])
  const [bx, bz] = toScene([maxLon, maxLat])
  return {
    toScene,
    bounds: {
      minX: Math.min(ax, bx),
      maxX: Math.max(ax, bx),
      minZ: Math.min(az, bz),
      maxZ: Math.max(az, bz),
    },
  }
}
