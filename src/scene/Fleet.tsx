import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BoxGeometry, Color, InstancedMesh, Object3D } from 'three'
import type { NetworkData } from '../data/network-types'
import { trainStates, type Timetable } from '../sim/simulate'
import {
  TRACK_EXPRESS_DOWN,
  TRACK_EXPRESS_UP,
  TRACK_FAST_DOWN,
  TRACK_FAST_UP,
  type ServiceType,
} from '../sim/types'
import {
  COACH_GAP_SCENE_M,
  COACH_LENGTH_SCENE_M,
  PLATFORM_LENGTH_SCENE_M,
  TRACK_SPACING_SCENE_M,
} from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { simClock } from './sim-clock'
import { buildTrainTrack, poseAt, sectionAtChainage } from './track-geometry'

const COACHES = 12
const BODY_W = 18
const BODY_H = 18
/** Instance capacity — plenty above the ~70 concurrent rakes at peak. */
const MAX_RAKES = 128
/** Rakes fatten up to BULK_MAX x as the camera passes BULK_DISTANCE_M away. */
const BULK_DISTANCE_M = 25000
const BULK_MAX = 3.5
const NOSE_L = 14
const RAKE_LEN = COACHES * (COACH_LENGTH_SCENE_M + COACH_GAP_SCENE_M) - COACH_GAP_SCENE_M
/** How close a dwelling rake's nose pulls up to the platform's far edge (in
 * the direction of travel) — a real driver pulls up as far as the starter
 * signal allows, not to the platform's midpoint. */
const PLATFORM_NOSE_MARGIN_M = 15
const PLATFORM_NOSE_OFFSET_M = PLATFORM_LENGTH_SCENE_M / 2 - PLATFORM_NOSE_MARGIN_M
/** Below this speed the platform-alignment shift is blended fully in — well
 * under cruise (VMAX_MPS=15.5 in simulate.ts), so it only kicks in during the
 * final few metres of braking/accelerating, not the whole approach. */
const PLATFORM_BLEND_SPEED_MPS = 2.5
/**
 * Rake-overlap deconfliction for two trains folded onto the same drawn lane
 * (no signalling model keeps them apart in time — see laneFor above). Full
 * push is held across the whole gap range where two ~RAKE_LEN-long bodies
 * could be overlapping lengthwise, then fades out over NUDGE_FADE_M so it
 * never pops once they're already clear. Push magnitude is one extra
 * half-lane each side, enough to clear BODY_W with margin.
 */
const NUDGE_FULL_RANGE_M = RAKE_LEN
const NUDGE_FADE_M = 200
const NUDGE_MAX_M = TRACK_SPACING_SCENE_M / 2

/** A box tapered toward +z: the EMU cab nose. */
function noseGeometry(): BoxGeometry {
  const geo = new BoxGeometry(BODY_W, BODY_H * 0.9, NOSE_L)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > 0) {
      pos.setX(i, pos.getX(i) * 0.55)
      pos.setY(i, pos.getY(i) * 0.72)
    }
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}
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
  night,
  onSelectTrain,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  timetables: Timetable[]
  night: number
  onSelectTrain: (trainId: string) => void
}) {
  const bodyRef = useRef<InstancedMesh>(null)
  const stripeRef = useRef<InstancedMesh>(null)
  const lightRef = useRef<InstancedMesh>(null)
  const noseRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const noseGeo = useMemo(() => noseGeometry(), [])
  /** Service id per drawn rake slot, refreshed every frame for click picking. */
  const rakeIds = useRef<string[]>([])

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

  useFrame(({ camera }) => {
    const bodies = bodyRef.current
    const stripes = stripeRef.current
    const lights = lightRef.current
    const noses = noseRef.current
    if (!bodies || !stripes || !lights || !noses) return
    const states = trainStates(timetables, simClock.t)
    if (states.length > MAX_RAKES && !warnedCapacity) {
      warnedCapacity = true
      console.warn(`Fleet: ${states.length} concurrent rakes exceed capacity ${MAX_RAKES}; truncating`)
    }
    const rakes = states.map((state) => {
      const section = sectionAtChainage(sections, state.chainageM)
      return { state, section, lane: laneFor(state.track, section.tracks), nudge: 0 }
    })
    // Narrow sections fold several logical lanes onto one drawn lane (see
    // laneFor above), and there's no block-signalling model keeping same-lane
    // rakes apart in time — so two can legitimately be scheduled through the
    // same physical space at once (an overtake with no passing loop to draw
    // it on). Nudge them sideways while close so they read as two trains
    // instead of one interpenetrating blob; it fades out once they clear.
    const laneGroups = new Map<string, typeof rakes>()
    for (const r of rakes) {
      if (r.section.tracks >= 6) continue // every semantic lane has its own track; never folded
      const key = `${r.section.fromM}-${r.lane}`
      const g = laneGroups.get(key)
      if (g) g.push(r)
      else laneGroups.set(key, [r])
    }
    // Adjacent pairs only — a third rake caught between two close neighbours
    // can have its pushes partially cancel. Rare enough at real service
    // density in a narrow section not to chase further here.
    for (const group of laneGroups.values()) {
      if (group.length < 2) continue
      group.sort((a, b) => a.state.chainageM - b.state.chainageM)
      for (let i = 1; i < group.length; i++) {
        const a = group[i - 1]
        const b = group[i]
        const gap = b.state.chainageM - a.state.chainageM
        if (gap >= NUDGE_FULL_RANGE_M + NUDGE_FADE_M) continue
        const push =
          gap <= NUDGE_FULL_RANGE_M
            ? NUDGE_MAX_M
            : NUDGE_MAX_M * (1 - (gap - NUDGE_FULL_RANGE_M) / NUDGE_FADE_M)
        a.nudge -= push
        b.nudge += push
      }
    }
    let n = 0
    let rake = 0
    for (const { state, section, lane, nudge } of rakes) {
      if (n >= MAX_RAKES * COACHES) break
      const livery = LIVERY[state.serviceType]
      const lateral = (lane - (section.tracks - 1) / 2) * TRACK_SPACING_SCENE_M + nudge
      const dirSign = state.direction === 'down' ? 1 : -1
      // TrainState.chainageM is the rake's leading edge while moving (correct
      // for a real train's front relative to signals/platforms) — but while
      // dwelling it equals the station's own chainage exactly, and platforms
      // are centered on that same point. Left as the nose, the rake (~555
      // scene-m) would hang ~245 scene-m off the back of a 620 scene-m
      // platform. Shift the whole rake forward so the nose pulls up near the
      // platform's far edge instead, same as a real driver would.
      //
      // Blended continuously by speed rather than gated on the `dwelling`
      // boolean: every leg profile eases speed to exactly 0 at arrival and
      // back up from 0 at departure (see kinematics.ts), so speed is a
      // continuous proxy for "how settled into the platform is this rake" —
      // gating on the boolean instead would snap the whole rake forward the
      // instant dwelling starts, and back the instant it ends.
      const platformBlend = Math.max(0, Math.min(1, 1 - state.speedMps / PLATFORM_BLEND_SPEED_MPS))
      const refOffset = dirSign * PLATFORM_NOSE_OFFSET_M * platformBlend
      // Extra width/height exaggeration as the camera pulls away, so rakes
      // stay readable over the whole corridor but sit true at station level.
      const nose = poseAt(centerTrack, state.chainageM, refOffset)
      const noseY = heightfield.railY(nose.x, nose.z)
      const camDist = Math.hypot(
        camera.position.x - nose.x,
        camera.position.y - noseY,
        camera.position.z - nose.z,
      )
      const bulk = Math.min(BULK_MAX, Math.max(1, camDist / BULK_DISTANCE_M))
      for (let c = 0; c < COACHES; c++) {
        const pose = poseAt(centerTrack, state.chainageM, refOffset - dirSign * coachOffsets[c])
        // Same normal convention as offsetPolyline: left of travel = (-dz, dx).
        const nx = -Math.cos(pose.angleRad)
        const nz = Math.sin(pose.angleRad)
        const px = pose.x + nx * lateral
        const pz = pose.z + nz * lateral
        dummy.position.set(px, heightfield.railY(px, pz) + (BODY_H * bulk) / 2, pz)
        dummy.rotation.set(0, pose.angleRad, 0)
        dummy.scale.set(bulk, bulk, 1)
        dummy.updateMatrix()
        bodies.setMatrixAt(n, dummy.matrix)
        stripes.setMatrixAt(n, dummy.matrix)
        bodies.setColorAt(n, livery.body)
        stripes.setColorAt(n, livery.stripe)
        n++
      }
      // Headlight at the tip of the front nose so the cab doesn't occlude it.
      const tip = poseAt(centerTrack, state.chainageM, refOffset + dirSign * NOSE_L * 0.9)
      const tx = -Math.cos(tip.angleRad)
      const tz = Math.sin(tip.angleRad)
      dummy.position.set(
        tip.x + tx * lateral,
        heightfield.railY(tip.x + tx * lateral, tip.z + tz * lateral) + BODY_H * bulk * 0.3,
        tip.z + tz * lateral,
      )
      dummy.rotation.set(0, tip.angleRad, 0)
      dummy.scale.set(bulk * 0.6, bulk * 0.6, 1)
      dummy.updateMatrix()
      lights.setMatrixAt(rake, dummy.matrix)
      // Cab noses cap both rake ends, pointing outward along travel.
      for (const [endOffset, flip] of [
        [-NOSE_L / 2, 0], // ahead of the leading coach face
        [RAKE_LEN + NOSE_L / 2, Math.PI], // beyond the trailing face
      ] as const) {
        const p = poseAt(centerTrack, state.chainageM, refOffset - dirSign * endOffset)
        const ex = -Math.cos(p.angleRad)
        const ez = Math.sin(p.angleRad)
        const px = p.x + ex * lateral
        const pz = p.z + ez * lateral
        dummy.position.set(px, heightfield.railY(px, pz) + (BODY_H * bulk * 0.9) / 2, pz)
        dummy.rotation.set(0, p.angleRad + (dirSign === 1 ? 0 : Math.PI) + flip, 0)
        dummy.scale.set(bulk, bulk, 1)
        dummy.updateMatrix()
        noses.setMatrixAt(rake * 2 + (flip === 0 ? 0 : 1), dummy.matrix)
        noses.setColorAt(rake * 2 + (flip === 0 ? 0 : 1), livery.body)
      }
      rakeIds.current[rake] = state.id
      rake++
    }
    rakeIds.current.length = rake
    bodies.count = n
    stripes.count = n
    lights.count = rake
    noses.count = rake * 2
    bodies.instanceMatrix.needsUpdate = true
    stripes.instanceMatrix.needsUpdate = true
    lights.instanceMatrix.needsUpdate = true
    noses.instanceMatrix.needsUpdate = true
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true
    if (stripes.instanceColor) stripes.instanceColor.needsUpdate = true
    if (noses.instanceColor) noses.instanceColor.needsUpdate = true
  })

  return (
    <group>
      <instancedMesh
        ref={bodyRef}
        args={[undefined, undefined, MAX_RAKES * COACHES]}
        frustumCulled={false}
        onClick={(e) => {
          e.stopPropagation()
          if (e.instanceId === undefined) return
          const id = rakeIds.current[Math.floor(e.instanceId / COACHES)]
          if (id) onSelectTrain(id)
        }}
      >
        <boxGeometry args={[BODY_W, BODY_H, COACH_LENGTH_SCENE_M]} />
        <meshStandardMaterial />
      </instancedMesh>
      {/* the waist band doubles as the lit window strip after dark */}
      <instancedMesh
        ref={stripeRef}
        args={[undefined, undefined, MAX_RAKES * COACHES]}
        frustumCulled={false}
      >
        <boxGeometry args={[BODY_W + 1, BODY_H * 0.28, COACH_LENGTH_SCENE_M + 1]} />
        <meshStandardMaterial emissive="#ffca7a" emissiveIntensity={night * 1.4} />
      </instancedMesh>
      {/* housing always drawn (visible unlit by day); glow fades in with night,
          same as the window-glow stripe, instead of popping on at a threshold */}
      <instancedMesh ref={lightRef} args={[undefined, undefined, MAX_RAKES]} frustumCulled={false}>
        <boxGeometry args={[BODY_W * 0.7, BODY_H * 0.35, 6]} />
        <meshStandardMaterial emissive="#fff3c4" emissiveIntensity={night * 3} color="#3a3a30" />
      </instancedMesh>
      <instancedMesh
        ref={noseRef}
        args={[noseGeo, undefined, MAX_RAKES * 2]}
        frustumCulled={false}
      >
        <meshStandardMaterial />
      </instancedMesh>
    </group>
  )
}

