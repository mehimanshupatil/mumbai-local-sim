import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { MapControls, Sky, Stars } from '@react-three/drei'
import { faceTracks, network, timetables, type Focus } from '../app-data'
import { Atmosphere } from './Atmosphere'
import { AudioRig } from './AudioRig'
import { Bridges } from './Bridges'
import { CameraRig, type ControlsLike } from './CameraRig'
import { IS_COARSE_POINTER } from './config'
import { Corridor } from './Corridor'
import { Effects } from './Effects'
import { useSimDaylight } from './daylight'
import { DevCamera } from './dev-camera'
import { Fleet } from './Fleet'
import { loadHeightfield, type Heightfield } from './heightfield'
import { createProjection } from './projection'
import { CueDriver } from './sim-audio'
import { SimClockDriver } from './sim-clock'
import { StationDressing } from './StationDressing'
import { StationLabels } from './station-labels'
import { buildTrainTrack } from './track-geometry'
import { Terrain } from './Terrain'
import { Wayside } from './Wayside'
import { Yards } from './Yards'

const FOV_DEG = 45
/**
 * Landing camera, as fractions of the framing distance: oblique rather than
 * top-down, because a near-vertical framing reads as a paper map and flattens
 * 124 km of corridor into a line.
 */
const LANDING_UP = 0.42
const LANDING_SOUTH = 0.5
/** Slack past the landing framing before the zoom-out stops. */
const MAX_ZOOM_OUT = 1.2

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
  // How far the landing camera actually sits from what it looks at. Zooming
  // out is capped just past this: the whole line is already in frame here, so
  // anything further only shrinks the subject and pulls in terrain the line
  // has nothing to do with.
  const landingDistance = distance * Math.hypot(LANDING_UP, LANDING_SOUTH)

  return (
    <Canvas
      // 120 km of coastal plain metres from a 190 km camera: the standard
      // depth buffer z-fights sea against low-lying land.
      gl={{ logarithmicDepthBuffer: true }}
      // Desktop keeps r3f's default pixel ratio (forcing full retina 2.0
      // costs half the frame rate); coarse-pointer devices clamp lower.
      {...(IS_COARSE_POINTER ? { dpr: [1, 1.5] as [number, number] } : {})}
      camera={{
        // See LANDING_UP/LANDING_SOUTH — from here the line recedes toward a
        // hazed horizon with sky above it (see Atmosphere).
        position: [cx, distance * LANDING_UP, cz + distance * LANDING_SOUTH],
        fov: FOV_DEG,
        near: 50,
        far: distance * 6,
      }}
      onPointerDown={(e) => (pointerDownAt.current = [e.clientX, e.clientY])}
      onPointerMissed={(e) => {
        // Only a click on the canvas itself is a click on empty space. An
        // overlay that takes its own clicks still reaches here, and releasing
        // the focus underneath it undoes whatever the overlay just did.
        if (!(e.target instanceof HTMLCanvasElement)) return
        // A drag that ends off-target is navigation, not a click-away.
        const d = pointerDownAt.current
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 8) return
        onFocus({ mode: 'free' })
      }}
    >
      <color attach="background" args={[daylight.skyColor]} />
      <Atmosphere color={daylight.skyColor} />
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
          <Terrain
            heightfield={heightfield}
            projection={projection}
            daylight={daylight}
            corridor={centerTrack.points}
          />
          <StationDressing
            network={network}
            projection={projection}
            heightfield={heightfield}
            night={daylight.night}
            faceTracks={faceTracks}
            onSelectStation={(stationId) => onFocus({ mode: 'station', stationId })}
          />
          <Corridor
            network={network}
            projection={projection}
            heightfield={heightfield}
            night={daylight.night}
            onSelectStation={(stationId) => onFocus({ mode: 'station', stationId })}
          />
          <Yards
            network={network}
            projection={projection}
            heightfield={heightfield}
            track={centerTrack}
          />
          <Bridges network={network} projection={projection} heightfield={heightfield} />
          <Wayside network={network} projection={projection} heightfield={heightfield} />
          <SimClockDriver />
          <CueDriver />
          <AudioRig
            network={network}
            timetables={timetables}
            track={centerTrack}
            focus={focus}
          />
          <Fleet
            network={network}
            projection={projection}
            heightfield={heightfield}
            timetables={timetables}
            night={daylight.night}
            onSelectTrain={(trainId) => onFocus({ mode: 'follow', trainId })}
          />
          {/* After the components that register labels: one pass decides
              which Station names are visible this frame. */}
          <StationLabels />
          <DevCamera controls={controlsRef as React.RefObject<ControlsLike | null>} />
          <Effects daylight={daylight} />
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
        maxDistance={landingDistance * MAX_ZOOM_OUT}
        enableDamping
        zoomToCursor
        screenSpacePanning={false}
      />
    </Canvas>
  )
}
