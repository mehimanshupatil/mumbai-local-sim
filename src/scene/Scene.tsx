import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { MapControls, Sky, Stars } from '@react-three/drei'
import { network, timetables, type Focus } from '../app-data'
import { CameraRig, type ControlsLike } from './CameraRig'
import { Corridor } from './Corridor'
import { useSimDaylight } from './daylight'
import { Fleet } from './Fleet'
import { loadHeightfield, type Heightfield } from './heightfield'
import { createProjection } from './projection'
import { SimClockDriver } from './sim-clock'
import { StationDressing } from './StationDressing'
import { buildTrainTrack } from './track-geometry'
import { Terrain } from './Terrain'

const FOV_DEG = 45

export function Scene({ focus, onFocus }: { focus: Focus; onFocus: (f: Focus) => void }) {
  const projection = useMemo(() => createProjection(network), [])
  const pointerDownAt = useRef<[number, number] | null>(null)
  const centerTrack = useMemo(() => buildTrainTrack(network, projection, 0), [projection])
  const controlsRef = useRef<React.ComponentRef<typeof MapControls> | null>(null)
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
      onPointerDown={(e) => (pointerDownAt.current = [e.clientX, e.clientY])}
      onPointerMissed={(e) => {
        // A drag that ends off-target is navigation, not a click-away.
        const d = pointerDownAt.current
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 8) return
        onFocus({ mode: 'free' })
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
          <StationDressing network={network} projection={projection} heightfield={heightfield} />
          <Corridor
            network={network}
            projection={projection}
            heightfield={heightfield}
            night={daylight.night}
            onSelectStation={(stationId) => onFocus({ mode: 'station', stationId })}
          />
          <SimClockDriver />
          <Fleet
            network={network}
            projection={projection}
            heightfield={heightfield}
            timetables={timetables}
            night={daylight.night}
            onSelectTrain={(trainId) => onFocus({ mode: 'follow', trainId })}
          />
          <CameraRig
            focus={focus}
            onFocus={onFocus}
            // MapControls satisfies the rig's narrow enabled+target slice.
            controls={controlsRef as React.RefObject<ControlsLike | null>}
            network={network}
            projection={projection}
            heightfield={heightfield}
            timetables={timetables}
            track={centerTrack}
          />
        </>
      )}
      {/* Google-Maps-style navigation: drag pans along the ground, right-drag
          (or two fingers) rotates/tilts, wheel zooms toward the cursor. */}
      <MapControls
        ref={controlsRef}
        makeDefault
        target={[cx, 0, cz]}
        maxPolarAngle={Math.PI / 2.3}
        minDistance={150}
        maxDistance={distance * 2}
        enableDamping
        zoomToCursor
        screenSpacePanning={false}
      />
    </Canvas>
  )
}
