import { useMemo } from 'react'
import type { NetworkData } from '../data/network-types'
import { trackRibbonGeometry } from './Corridor'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildYardTrack } from './track-geometry'

/** Sidings lift a hair less than the main line (see Corridor's TRACK_LIFT)
 * so a running track never z-fights a siding that happens to cross near it. */
const SIDING_LIFT = 0.5
/** Narrower than a running track (TRACK_WIDTH_SCENE_M) — a real yard siding
 * is the same gauge but reads as secondary track when drawn thinner. */
const SIDING_WIDTH_SCENE_M = 9
const SIDING_COLOR = '#4a3f38' // weathered ballast, unlit — no sleeper texture
/** How far past the siding's own drawn length to extend the ribbon, since a
 * parked rake can sit beyond it (poseAt extrapolates, see track-geometry.ts)
 * — draws enough ballast under the rake instead of it visibly floating past
 * bare ground. */
const OVERRUN_SCENE_M = 700

export function Yards({
  network,
  projection,
  heightfield,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
}) {
  const geometries = useMemo(
    () =>
      network.yards.map((yard) => {
        const track = buildYardTrack(yard, projection)
        const [jx, jz] = track.points[0]
        const [fx, fz] = track.points[track.points.length - 1]
        const dx = fx - jx
        const dz = fz - jz
        const len = Math.hypot(dx, dz) || 1
        const points: [number, number, number][] = [
          [jx, 0, jz],
          [fx + (dx / len) * OVERRUN_SCENE_M, 0, fz + (dz / len) * OVERRUN_SCENE_M],
        ].map(([x, , z]) => [x, heightfield.railY(x, z) + SIDING_LIFT, z])
        return { id: yard.id, geo: trackRibbonGeometry(points, SIDING_WIDTH_SCENE_M) }
      }),
    [network, projection, heightfield],
  )
  return (
    <group>
      {geometries.map(({ id, geo }) => (
        <mesh key={id} geometry={geo}>
          <meshStandardMaterial color={SIDING_COLOR} roughness={1} />
        </mesh>
      ))}
    </group>
  )
}
