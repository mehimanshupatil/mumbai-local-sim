import { useMemo } from 'react'
import { Billboard, Line, Text } from '@react-three/drei'
import type { NetworkData } from '../data/network-types'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Projection } from './projection'
import { buildTrackPolylines } from './track-geometry'

const TRACK_Y = 2
const TRACK_COLOR = '#4a4f5a'
const STATION_COLOR = '#7b1fa2'
const FAST_HALT_COLOR = '#e0a020'

export function Corridor({ network, projection }: { network: NetworkData; projection: Projection }) {
  const tracks = useMemo(
    () =>
      buildTrackPolylines(network, projection, TRACK_SPACING_SCENE_M).map((t) =>
        t.points.map(([x, z]) => [x, TRACK_Y, z] as [number, number, number]),
      ),
    [network, projection],
  )
  return (
    <group>
      {tracks.map((points, i) => (
        <Line key={i} points={points} color={TRACK_COLOR} lineWidth={2.5} />
      ))}
      {network.stations.map((s) => (
        <StationMarker
          key={s.id}
          name={s.name}
          fastHalt={s.fastHalt}
          position={projection.toScene([s.lon, s.lat])}
        />
      ))}
    </group>
  )
}

function StationMarker({
  name,
  fastHalt,
  position: [x, z],
}: {
  name: string
  fastHalt: boolean
  position: [number, number]
}) {
  const color = fastHalt ? FAST_HALT_COLOR : STATION_COLOR
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 150, 0]}>
        <cylinderGeometry args={[18, 18, 300]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 330, 0]}>
        <sphereGeometry args={[55]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <Billboard position={[0, 520, 0]}>
        <Text fontSize={220} color="#ffffff" outlineWidth={12} outlineColor="#0b0e14" anchorY="bottom">
          {name}
        </Text>
      </Billboard>
    </group>
  )
}
