import { useMemo } from 'react'
import { Billboard, Line, Text } from '@react-three/drei'
import type { NetworkData } from '../data/network-types'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrackPolylines } from './track-geometry'

/** Track lines float just above the rail formation to avoid z-fighting. */
const TRACK_LIFT = 0.6
const TRACK_COLOR = '#4a4f5a'
const STATION_COLOR = '#7b1fa2'
const FAST_HALT_COLOR = '#e0a020'

export function Corridor({
  network,
  projection,
  heightfield,
  night,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  night: number
}) {
  const tracks = useMemo(
    () =>
      buildTrackPolylines(network, projection, TRACK_SPACING_SCENE_M).map((t) =>
        t.points.map(
          ([x, z]) => [x, heightfield.railY(x, z) + TRACK_LIFT, z] as [number, number, number],
        ),
      ),
    [network, projection, heightfield],
  )
  return (
    <group>
      {tracks.map((points, i) => (
        <Line key={i} points={points} color={TRACK_COLOR} lineWidth={2.5} />
      ))}
      {network.stations.map((s) => {
        const [x, z] = projection.toScene([s.lon, s.lat])
        return (
          <StationMarker
            key={s.id}
            name={s.name}
            fastHalt={s.fastHalt}
            position={[x, heightfield.railY(x, z), z]}
            night={night}
          />
        )
      })}
    </group>
  )
}

function StationMarker({
  name,
  fastHalt,
  position: [x, y, z],
  night,
}: {
  name: string
  fastHalt: boolean
  position: [number, number, number]
  night: number
}) {
  const color = fastHalt ? FAST_HALT_COLOR : STATION_COLOR
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, 150, 0]}>
        <cylinderGeometry args={[18, 18, 300]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* the marker head doubles as the platform lamp after dark */}
      <mesh position={[0, 330, 0]}>
        <sphereGeometry args={[55]} />
        <meshStandardMaterial color={color} emissive="#ffe9b0" emissiveIntensity={night * 1.6} />
      </mesh>
      <Billboard position={[0, 520, 0]}>
        {/* Labels skip the depth test: troika text z-flickers against the
            logarithmic depth buffer on some GPUs, and terrain should never
            occlude a station name anyway. */}
        <Text
          fontSize={220}
          color="#ffffff"
          outlineWidth={12}
          outlineColor="#0b0e14"
          anchorY="bottom"
          renderOrder={10}
          material-depthTest={false}
        >
          {name}
        </Text>
      </Billboard>
    </group>
  )
}
