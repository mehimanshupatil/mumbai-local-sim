import { useMemo, useRef } from 'react'
import { Billboard, Line, Text } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
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
  onSelectStation,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  night: number
  onSelectStation: (stationId: string) => void
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
            onSelect={() => onSelectStation(s.id)}
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
  onSelect,
}: {
  name: string
  fastHalt: boolean
  position: [number, number, number]
  night: number
  onSelect: () => void
}) {
  const color = fastHalt ? FAST_HALT_COLOR : STATION_COLOR
  const ref = useRef<Group>(null)
  const labelRef = useRef<Group>(null)
  useFrame(({ camera }) => {
    // Markers are sized for corridor-level views; shrink them as the camera
    // closes in so they don't tower over ground-level chase shots.
    const g = ref.current
    if (!g) return
    const dist = camera.position.distanceTo(g.position)
    const s = Math.min(1, Math.max(0.06, dist / 12000))
    g.scale.setScalar(s)
    // Close up, the yellow station board takes over from the floating label.
    const label = labelRef.current
    if (label) label.scale.setScalar(Math.min(1, Math.max(0, (dist - 4000) / 8000)))
  })
  return (
    <group
      ref={ref}
      position={[x, y, z]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      <mesh position={[0, 150, 0]}>
        <cylinderGeometry args={[18, 18, 300]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* the marker head doubles as the platform lamp after dark */}
      <mesh position={[0, 330, 0]}>
        <sphereGeometry args={[55]} />
        <meshStandardMaterial color={color} emissive="#ffe9b0" emissiveIntensity={night * 1.6} />
      </mesh>
      <Billboard ref={labelRef} position={[0, 520, 0]}>
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
