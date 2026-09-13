import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Focus } from '../app-data'
import type { NetworkData } from '../data/network-types'
import { trainStates, type Timetable } from '../sim/simulate'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import {
  buildYardRoadTracks,
  laneLateralAtChainage,
  NOSE_L,
  PARKED_RAKE_CHAINAGE_M,
  platformNoseOffsetM,
  RAKE_LEN,
  roadForSlot,
} from './rake-geometry'
import { simClock } from './sim-clock'
import { poseAt, type TrainTrack } from './track-geometry'

/** Chase-cam geometry: behind and above the rake, whole train in frame. */
const CHASE_BACK_M = 1100
const CHASE_UP_M = 480
/** Cab view: driver's eye just ahead of the nose, looking down the rails.
 * Height is above the body (BODY_H is 18) rather than true cab height, which
 * would put the eye inside the roof of the coach behind it. Measured from the
 * rake's *drawn* nose — platformNoseOffsetM shifts that up to ~295 scene-m
 * ahead of the sim chainage near stations, and an eye placed at the chainage
 * instead ends up looking at the back of its own train. */
const CAB_AHEAD_M = 12
const CAB_EYE_M = 24
const CAB_LOOK_AHEAD_M = 700
/**
 * Lineside view: the camera is planted beside the track ahead of the train
 * and holds still while the train comes past, instead of tracking it — the
 * whole point is the pass-by, and a camera that follows has no parallax and
 * so no sense of speed. Re-anchors once the rake is clear of it.
 *
 * Planted only a few hundred metres ahead: at line speed that is ~15 seconds
 * of approach, where a kilometre is most of a minute spent watching a dot.
 */
const LINESIDE_AHEAD_M = 450
/**
 * Clear of the platforms but inside the building-free strip: StationDressing
 * scatters blocks from ~(track fan + platform + 80) outward, and a camera
 * planted past that line spends the pass-by looking at the back of a
 * warehouse. Low, too — a lineside shot wants the rake going past above the
 * lens, not seen down on from office-block height.
 */
const LINESIDE_LATERAL_M = 85
const LINESIDE_UP_M = 16
/** Re-anchor once the rake's tail has cleared the camera by this much. */
const LINESIDE_PASSED_M = RAKE_LEN + 250
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
  /** Where the lineside camera is planted, and for which service. */
  const linesideAnchor = useRef({ trainId: '', chainageM: 0 })
  const lastFocusRef = useRef<Focus>(focus)
  const yardRoads = useMemo(
    () => buildYardRoadTracks(network, projection, track),
    [network, projection, track],
  )

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
      // A yard-parked rake (ticket #17) renders on its own siding, not the
      // main corridor at its old chainage — chase it there instead, or the
      // camera would settle on empty track while the train sits elsewhere.
      const roads = state.parkedYardId ? yardRoads.get(state.parkedYardId) : undefined
      const yardTrack = roads ? roadForSlot(roads, state.parkedSlot) : undefined
      const chaseTrack = yardTrack ?? track
      const chaseChainageM = yardTrack ? PARKED_RAKE_CHAINAGE_M : state.chainageM
      const pose = poseAt(chaseTrack, chaseChainageM)
      const y = heightfield.railY(pose.x, pose.z)
      // Chase from behind the direction of travel.
      const dirSign = yardTrack ? 1 : state.direction === 'down' ? 1 : -1
      // The rake is drawn on its own lane, not the centreline the chase cam
      // targets — a cab or lineside camera has to use the same offset or it
      // sits between tracks (see Fleet's lateral).
      const lateral = yardTrack
        ? 0
        : laneLateralAtChainage(network.sections, state.track, state.chainageM)
      const offsetOf = (p: { x: number; z: number; angleRad: number }, m: number) => ({
        x: p.x + -Math.cos(p.angleRad) * m,
        z: p.z + Math.sin(p.angleRad) * m,
      })
      const view = focus.view ?? 'chase'
      ctl.enabled = false

      if (view === 'cab' && !yardTrack) {
        const nextStopChainageM =
          network.stations.find((s) => s.id === state.nextStopId)?.chainageM ?? state.chainageM
        const nose =
          platformNoseOffsetM(state.chainageM, nextStopChainageM, state.legDistanceM) + NOSE_L
        const eye = poseAt(chaseTrack, chaseChainageM, dirSign * (nose + CAB_AHEAD_M))
        const ahead = poseAt(chaseTrack, chaseChainageM, dirSign * (nose + CAB_LOOK_AHEAD_M))
        const e = offsetOf(eye, lateral)
        const a = offsetOf(ahead, lateral)
        // Snapped, not damped: a cab camera that lags its own train reads as
        // the train sliding sideways out from under the viewer.
        camera.position.set(e.x, heightfield.railY(e.x, e.z) + CAB_EYE_M, e.z)
        lookTarget.set(a.x, heightfield.railY(a.x, a.z) + CAB_EYE_M * 0.6, a.z)
        ctl.target.lerp(lookTarget, damp)
        camera.lookAt(ctl.target)
        return
      }

      if (view === 'lineside' && !yardTrack) {
        const passed = dirSign * (state.chainageM - linesideAnchor.current.chainageM)
        if (
          linesideAnchor.current.trainId !== focus.trainId ||
          passed > LINESIDE_PASSED_M ||
          passed < -LINESIDE_AHEAD_M * 3
        ) {
          linesideAnchor.current = {
            trainId: focus.trainId,
            chainageM: state.chainageM + dirSign * LINESIDE_AHEAD_M,
          }
        }
        const spot = poseAt(chaseTrack, linesideAnchor.current.chainageM)
        const s = offsetOf(spot, lateral + LINESIDE_LATERAL_M)
        camera.position.set(s.x, heightfield.railY(s.x, s.z) + LINESIDE_UP_M, s.z)
        const p = offsetOf(pose, lateral)
        lookTarget.set(p.x, heightfield.railY(p.x, p.z) + 20, p.z)
        ctl.target.lerp(lookTarget, damp)
        camera.lookAt(ctl.target)
        return
      }

      const back = poseAt(chaseTrack, chaseChainageM, -dirSign * CHASE_BACK_M)
      desired.set(back.x, y + CHASE_UP_M, back.z)
      lookTarget.set(pose.x, y + 60, pose.z)
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
