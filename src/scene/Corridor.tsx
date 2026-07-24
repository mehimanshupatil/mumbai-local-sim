import { useMemo, useRef } from 'react'
import { Billboard, Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import type { NetworkData } from '../data/network-types'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrackPolylines, terminusFanStub } from './track-geometry'
import { WRBoard } from './WRBoard'

/** Track lines float just above the rail formation to avoid z-fighting. */
const TRACK_LIFT = 0.6
const TRACK_COLOR = '#4a4f5a'
const STATION_COLOR = '#7b1fa2'
const FAST_HALT_COLOR = '#e0a020'
/** WRBoard's own text is sized for close-up reading (see StationDressing);
 * scaled up so the floating corridor-level label stays legible from afar. */
const LABEL_SCALE = 9

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
  const tracks = useMemo(() => {
    const polylines = buildTrackPolylines(network, projection, TRACK_SPACING_SCENE_M)
    // Churchgate's tracks are always the first `tracks`-many polylines here,
    // since buildTrackPolylines walks sections in order starting at chainage 0.
    const churchgateTracks = network.sections[0].tracks
    const fan = terminusFanStub(network, projection, TRACK_SPACING_SCENE_M, churchgateTracks)
    return polylines.map((t, i) => {
      const stub = i < churchgateTracks ? fan[i] : []
      return [...stub, ...t.points].map(
        ([x, z]) => [x, heightfield.railY(x, z) + TRACK_LIFT, z] as [number, number, number],
      )
    })
  }, [network, projection, heightfield])
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
            nameMr={s.nameMr}
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
  nameMr,
  fastHalt,
  position: [x, y, z],
  night,
  onSelect,
}: {
  name: string
  nameMr: string
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
    // closes in (they stay as the station's click target, so never to zero).
    const g = ref.current
    if (!g) return
    const dist = camera.position.distanceTo(g.position)
    g.scale.setScalar(Math.min(1, Math.max(0.06, dist / 12000)))
    // Close up the yellow board takes over from the floating label; far out,
    // minor-station labels yield so the dense south corridor doesn't smear.
    const label = labelRef.current
    if (label) {
      const near = Math.min(1, Math.max(0, (dist - 4000) / 8000))
      const far = fastHalt ? 1 : Math.min(1, Math.max(0, (45000 - dist) / 10000))
      label.scale.setScalar(near * far * LABEL_SCALE)
    }
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
        <WRBoard name={name} nameMr={nameMr} />
      </Billboard>
    </group>
  )
}
