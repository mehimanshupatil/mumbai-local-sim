import { useMemo } from 'react'
import type { NetworkData } from '../data/network-types'
import { trackRibbonGeometry } from './Corridor'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildYardRoadTracks } from './rake-geometry'
import type { TrainTrack } from './track-geometry'

/** Sidings lift a hair less than the main line (see Corridor's TRACK_LIFT)
 * so a running track never z-fights a siding that happens to cross near it. */
const SIDING_LIFT = 0.5
/** Narrower than a running track (TRACK_WIDTH_SCENE_M) — a real yard siding
 * is the same gauge but reads as secondary track when drawn thinner. */
const SIDING_WIDTH_SCENE_M = 9
const SIDING_COLOR = '#4a3f38' // weathered ballast, unlit — no sleeper texture

/**
 * A yard's stabling roads (ticket #17). One ribbon per road, following the
 * road's own polyline vertex for vertex: the roads curve with the corridor
 * (see buildYardRoads), so drawing them as a straight junction-to-end chord
 * — as this did — walked them back across the running lines.
 */
export function Yards({
  network,
  projection,
  heightfield,
  track,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  /** The corridor centreline the roads are laid out against. */
  track: TrainTrack
}) {
  const geometries = useMemo(() => {
    const roadsByYard = buildYardRoadTracks(network, projection, track)
    return [...roadsByYard].flatMap(([yardId, roads]) =>
      roads.map((road, i) => ({
        key: `${yardId}-${i}`,
        geo: trackRibbonGeometry(
          road.points.map(
            ([x, z]) => [x, heightfield.railY(x, z) + SIDING_LIFT, z] as [number, number, number],
          ),
          SIDING_WIDTH_SCENE_M,
        ),
      })),
    )
  }, [network, projection, heightfield, track])
  return (
    <group>
      {geometries.map(({ key, geo }) => (
        <mesh key={key} geometry={geo}>
          <meshStandardMaterial color={SIDING_COLOR} roughness={1} />
        </mesh>
      ))}
    </group>
  )
}
