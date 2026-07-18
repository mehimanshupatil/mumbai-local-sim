import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Sky } from '@react-three/drei'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import { syntheticScheduler } from '../sim/scheduler'
import { buildTimetable } from '../sim/simulate'
import { Corridor } from './Corridor'
import { Fleet } from './Fleet'
import { createProjection } from './projection'
import { SimClockDriver } from './sim-clock'

const network = westernJson as NetworkData

const FOV_DEG = 45

// The full synthetic day of services, expanded to timetables once at load.
const timetables = syntheticScheduler(network).map((def) => buildTimetable(network, def))

export function Scene() {
  const projection = useMemo(() => createProjection(network), [])
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
      <Fleet network={network} projection={projection} timetables={timetables} />
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
