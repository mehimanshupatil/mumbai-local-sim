import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, InstancedMesh, Object3D } from 'three'
import type { NetworkData, TrackSection } from '../data/network-types'
import { trainStates, type Timetable } from '../sim/simulate'
import {
  TRACK_EXPRESS_DOWN,
  TRACK_EXPRESS_UP,
  TRACK_FAST_DOWN,
  TRACK_FAST_UP,
  type ServiceType,
} from '../sim/types'
import { COACH_GAP_SCENE_M, COACH_LENGTH_SCENE_M, TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { simClock } from './sim-clock'
import { buildTrainTrack, poseAt } from './track-geometry'

const COACHES = 12
const BODY_W = 18
const BODY_H = 18
/** Instance capacity — plenty above the ~70 concurrent rakes at peak. */
const MAX_RAKES = 128
let warnedCapacity = false

/** Liveries by service type: rake body and waist-band colors. */
const LIVERY: Record<ServiceType, { body: Color; stripe: Color }> = {
  slow: { body: new Color('#efecf1'), stripe: new Color('#6d1ca3') }, // WR white/purple
  ac: { body: new Color('#3a7bd5'), stripe: new Color('#e8eef7') }, // AC local blue
  fast: { body: new Color('#efecf1'), stripe: new Color('#6d1ca3') }, // same stock as slow
  express: { body: new Color('#77302c'), stripe: new Color('#e0b04a') }, // long-distance maroon
}

/**
 * Drawn lane for a semantic track index within a section. Narrow sections
 * fold expresses onto the fast pair (up direction first, so opposing
 * expresses never share a lane), and the two-track stretch folds everything
 * onto the single up/down pair.
 */
function laneFor(track: number, sectionTracks: number): number {
  const isUp = track % 2 === 1 // all *_UP constants are odd by construction
  if (sectionTracks >= 6) return track
  if (track === TRACK_EXPRESS_DOWN || track === TRACK_EXPRESS_UP) {
    // A lone 5th line hosts down expresses; up expresses join the fast pair.
    if (sectionTracks === 5 && !isUp) return 4
    track = isUp ? TRACK_FAST_UP : TRACK_FAST_DOWN
  }
  if (sectionTracks <= 2) return isUp ? 1 : 0
  return Math.min(track, sectionTracks - 1)
}

/**
 * The whole fleet as two instanced draws (bodies + livery bands), one
 * instance per coach, posed from the sim seam every frame. Replaces the
 * per-rake Train component; still swappable for detailed models later.
 */
export function Fleet({
  network,
  projection,
  heightfield,
  timetables,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  timetables: Timetable[]
}) {
  const bodyRef = useRef<InstancedMesh>(null)
  const stripeRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])

  const centerTrack = useMemo(() => buildTrainTrack(network, projection, 0), [network, projection])
  const sections = network.sections

  const coachOffsets = useMemo(
    () =>
      Array.from(
        { length: COACHES },
        (_, i) => i * (COACH_LENGTH_SCENE_M + COACH_GAP_SCENE_M) + COACH_LENGTH_SCENE_M / 2,
      ),
    [],
  )

  useFrame(() => {
    const bodies = bodyRef.current
    const stripes = stripeRef.current
    if (!bodies || !stripes) return
    const states = trainStates(timetables, simClock.t)
    if (states.length > MAX_RAKES && !warnedCapacity) {
      warnedCapacity = true
      console.warn(`Fleet: ${states.length} concurrent rakes exceed capacity ${MAX_RAKES}; truncating`)
    }
    let n = 0
    for (const state of states) {
      if (n >= MAX_RAKES * COACHES) break
      const livery = LIVERY[state.serviceType]
      const section = sectionAt(sections, state.chainageM)
      const lane = laneFor(state.track, section.tracks)
      const lateral = (lane - (section.tracks - 1) / 2) * TRACK_SPACING_SCENE_M
      const dirSign = state.direction === 'down' ? 1 : -1
      for (let c = 0; c < COACHES; c++) {
        const pose = poseAt(centerTrack, state.chainageM, -dirSign * coachOffsets[c])
        // Same normal convention as offsetPolyline: left of travel = (-dz, dx).
        const nx = -Math.cos(pose.angleRad)
        const nz = Math.sin(pose.angleRad)
        const px = pose.x + nx * lateral
        const pz = pose.z + nz * lateral
        dummy.position.set(px, heightfield.railY(px, pz) + BODY_H / 2, pz)
        dummy.rotation.set(0, pose.angleRad, 0)
        dummy.updateMatrix()
        bodies.setMatrixAt(n, dummy.matrix)
        stripes.setMatrixAt(n, dummy.matrix)
        bodies.setColorAt(n, livery.body)
        stripes.setColorAt(n, livery.stripe)
        n++
      }
    }
    bodies.count = n
    stripes.count = n
    bodies.instanceMatrix.needsUpdate = true
    stripes.instanceMatrix.needsUpdate = true
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true
    if (stripes.instanceColor) stripes.instanceColor.needsUpdate = true
  })

  return (
    <group>
      <instancedMesh ref={bodyRef} args={[undefined, undefined, MAX_RAKES * COACHES]} frustumCulled={false}>
        <boxGeometry args={[BODY_W, BODY_H, COACH_LENGTH_SCENE_M]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh
        ref={stripeRef}
        args={[undefined, undefined, MAX_RAKES * COACHES]}
        frustumCulled={false}
      >
        <boxGeometry args={[BODY_W + 1, BODY_H * 0.28, COACH_LENGTH_SCENE_M + 1]} />
        <meshStandardMaterial />
      </instancedMesh>
    </group>
  )
}

function sectionAt(sections: TrackSection[], chainageM: number): TrackSection {
  for (const s of sections) {
    if (chainageM < s.toM) return s
  }
  return sections[sections.length - 1]
}
