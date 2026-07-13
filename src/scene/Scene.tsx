import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Sky } from '@react-three/drei'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import { SIM_START } from '../sim/clock'
import { buildTimetable } from '../sim/simulate'
import type { ServiceDef } from '../sim/types'
import { Corridor } from './Corridor'
import { TRACK_SPACING_SCENE_M } from './config'
import { createProjection } from './projection'
import { SimClockDriver } from './sim-clock'
import { buildTrainTrack } from './track-geometry'
import { Train } from './Train'

const network = westernJson as NetworkData

const FOV_DEG = 45

// The first service: one slow local departing Churchgate at sim start,
// stopping everywhere to Virar. The synthetic scheduler (ticket #6) will
// replace this hand-rolled def.
const virarIndex = network.stations.findIndex((s) => s.name === 'Virar')
if (virarIndex < 0) throw new Error('baked network is missing Virar')
const firstSlowLocal: ServiceDef = {
  id: 'CCG-VR-0831',
  serviceType: 'slow',
  direction: 'down',
  track: 0,
  departureTime: SIM_START,
  stopIds: network.stations.slice(0, virarIndex + 1).map((s) => s.id),
}

export function Scene() {
  const projection = useMemo(() => createProjection(network), [])
  const timetable = useMemo(() => buildTimetable(network, firstSlowLocal), [])
  // Down slow line: one track left of the centerline pending real
  // per-section track assignment (ticket #6).
  const trainTrack = useMemo(
    () => buildTrainTrack(network, projection, -TRACK_SPACING_SCENE_M),
    [projection],
  )
  const { minX, maxX, minZ, maxZ } = projection.bounds
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  // Frame the whole corridor: pull back far enough for its long axis at the
  // camera fov, with margin for the camera tilt foreshortening the near end.
  const extent = Math.max(maxX - minX, maxZ - minZ)
  const distance = (1.3 * extent) / (2 * Math.tan((FOV_DEG / 2) * (Math.PI / 180)))

  return (
    <Canvas
      camera={{
        position: [cx, distance, cz + distance * 0.25],
        fov: FOV_DEG,
        near: 10,
        far: distance * 6,
      }}
    >
      <Sky sunPosition={[100, 60, 100]} distance={distance * 4} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[50000, 80000, 30000]} intensity={1.2} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]}>
        <planeGeometry args={[extent * 10, extent * 10]} />
        <meshStandardMaterial color="#8a9a6b" />
      </mesh>
      <Corridor network={network} projection={projection} />
      <SimClockDriver />
      <Train timetable={timetable} track={trainTrack} />
      <OrbitControls
        makeDefault
        target={[cx, 0, cz]}
        maxPolarAngle={Math.PI / 2.1}
        minDistance={300}
        maxDistance={distance * 2}
        enableDamping
        zoomToCursor
      />
    </Canvas>
  )
}
