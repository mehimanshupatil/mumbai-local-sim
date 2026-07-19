import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Focus } from '../app-data'
import type { NetworkData } from '../data/network-types'
import { trainStates, type Timetable } from '../sim/simulate'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { simClock } from './sim-clock'
import { poseAt, type TrainTrack } from './track-geometry'

/** Chase-cam geometry: behind and above the rake, whole train in frame. */
const CHASE_BACK_M = 1100
const CHASE_UP_M = 480
/** Station focus viewpoint. */
const STATION_UP_M = 1400
const STATION_SOUTH_M = 1800

const desired = new Vector3()
const lookTarget = new Vector3()

/** The slice of MapControls the rig drives — keeps three-stdlib types out. */
export interface ControlsLike {
  enabled: boolean
  target: Vector3
}

/**
 * Drives the camera in follow/station modes with critically-damped chasing;
 * hands control back to MapControls in free mode (and around a station once
 * the fly-in lands, so the viewer can orbit the platform).
 */
export function CameraRig({
  focus,
  onFocus,
  controls,
  network,
  projection,
  heightfield,
  timetables,
  track,
}: {
  focus: Focus
  onFocus: (f: Focus) => void
  controls: React.RefObject<ControlsLike | null>
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  timetables: Timetable[]
  track: TrainTrack
}) {
  const landed = useRef(false)
  const lastFocusRef = useRef<Focus>(focus)

  // Only the followed service's timetable is simulated per frame.
  const followed = useMemo(
    () =>
      focus.mode === 'follow' ? timetables.filter((t) => t.def.id === focus.trainId) : [],
    [focus, timetables],
  )

  useFrame(({ camera }, delta) => {
    // Focus-change bookkeeping lives here, not in render — a discarded
    // concurrent render must not replay the station fly-in.
    if (lastFocusRef.current !== focus) {
      lastFocusRef.current = focus
      landed.current = false
    }
    const ctl = controls.current
    if (!ctl) return
    const damp = 1 - Math.exp(-3.5 * delta)

    if (focus.mode === 'follow') {
      const state = trainStates(followed, simClock.t)[0]
      if (!state) {
        onFocus({ mode: 'free' }) // service ended — release the camera
        return
      }
      const pose = poseAt(track, state.chainageM)
      const y = heightfield.railY(pose.x, pose.z)
      // Chase from behind the direction of travel.
      const dirSign = state.direction === 'down' ? 1 : -1
      const back = poseAt(track, state.chainageM, -dirSign * CHASE_BACK_M)
      desired.set(back.x, y + CHASE_UP_M, back.z)
      lookTarget.set(pose.x, y + 60, pose.z)
      ctl.enabled = false
      camera.position.lerp(desired, damp)
      ctl.target.lerp(lookTarget, damp)
      camera.lookAt(ctl.target)
      return
    }

    if (focus.mode === 'station') {
      const station = network.stations.find((s) => s.id === focus.stationId)
      if (!station) return
      const [x, z] = projection.toScene([station.lon, station.lat])
      const y = heightfield.railY(x, z)
      desired.set(x, y + STATION_UP_M, z + STATION_SOUTH_M)
      lookTarget.set(x, y, z)
      if (!landed.current) {
        ctl.enabled = false
        camera.position.lerp(desired, damp)
        ctl.target.lerp(lookTarget, damp)
        camera.lookAt(ctl.target)
        if (camera.position.distanceTo(desired) < 40) {
          landed.current = true
          ctl.enabled = true // fly-in done — orbit freely around the station
        }
      }
      return
    }

    ctl.enabled = true
  })

  return null
}
