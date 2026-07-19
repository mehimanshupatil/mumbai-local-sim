import { useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Sky, Stars } from '@react-three/drei'
import westernJson from '../data/western.json'
import type { NetworkData } from '../data/network-types'
import { syntheticScheduler } from '../sim/scheduler'
import { buildTimetable } from '../sim/simulate'
import { Corridor } from './Corridor'
import { useSimDaylight } from './daylight'
import { Fleet } from './Fleet'
import { loadHeightfield, type Heightfield } from './heightfield'
import { createProjection } from './projection'
import { SimClockDriver } from './sim-clock'
import { Terrain } from './Terrain'

const network = westernJson as NetworkData

const FOV_DEG = 45

// The full synthetic day of services, expanded to timetables once at load.
const timetables = syntheticScheduler(network).map((def) => buildTimetable(network, def))

export function Scene() {
  const projection = useMemo(() => createProjection(network), [])
  const daylight = useSimDaylight()
  const [heightfield, setHeightfield] = useState<Heightfield | null>(null)
  useEffect(() => {
    let cancelled = false
    loadHeightfield(projection)
      .then((hf) => {
        if (!cancelled) setHeightfield(hf)
      })
      .catch((err) => console.error('terrain failed to load, scene stays empty:', err))
    return () => {
      cancelled = true
    }
  }, [projection])

  const { minX, maxX, minZ, maxZ } = projection.bounds
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  // Frame the whole corridor: pull back far enough for its long axis at the
  // camera fov, with margin for the camera tilt foreshortening the near end.
  const extent = Math.max(maxX - minX, maxZ - minZ)
  const distance = (1.3 * extent) / (2 * Math.tan((FOV_DEG / 2) * (Math.PI / 180)))

  return (
    <Canvas
      // 120 km of coastal plain metres from a 190 km camera: the standard
      // depth buffer z-fights sea against low-lying land.
      gl={{ logarithmicDepthBuffer: true }}
      camera={{
        position: [cx, distance, cz + distance * 0.25],
        fov: FOV_DEG,
        near: 50,
        far: distance * 6,
      }}
    >
      <color attach="background" args={[daylight.skyColor]} />
      <Sky sunPosition={daylight.skySunPos} distance={distance * 4} />
      {daylight.night > 0.5 && (
        <Stars radius={distance * 2} depth={distance} count={2500} factor={800} fade />
      )}
      <ambientLight color={daylight.ambientColor} intensity={daylight.ambientIntensity} />
      {/* Directional light aims at the origin — the projection is corridor-centred. */}
      <directionalLight
        position={[daylight.sunPos[0] * 600, daylight.sunPos[1] * 600, daylight.sunPos[2] * 600]}
        color={daylight.sunColor}
        intensity={daylight.sunIntensity}
      />
      {heightfield && (
        <>
          <Terrain heightfield={heightfield} projection={projection} />
          <Corridor
            network={network}
            projection={projection}
            heightfield={heightfield}
            night={daylight.night}
          />
          <SimClockDriver />
          <Fleet
            network={network}
            projection={projection}
            heightfield={heightfield}
            timetables={timetables}
            night={daylight.night}
          />
        </>
      )}
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
