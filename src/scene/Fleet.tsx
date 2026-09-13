import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BoxGeometry, Color, InstancedMesh, Object3D } from 'three'
import type { NetworkData } from '../data/network-types'
import { trainStates, type Timetable } from '../sim/simulate'
import type { ServiceType } from '../sim/types'
import {
  COACH_GAP_SCENE_M,
  COACH_LENGTH_SCENE_M,
} from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import {
  assignLanes,
  buildYardRoadTracks,
  COACHES,
  laneLateralAtChainage,
  NOSE_L,
  PARKED_RAKE_CHAINAGE_M,
  platformNoseOffsetM,
  RAKE_LEN,
  roadForSlot,
} from './rake-geometry'
import { simClock } from './sim-clock'
import { buildTrainTrack, poseAt, type TrainTrack } from './track-geometry'

const BODY_W = 18
const BODY_H = 18
/** Instance capacity — plenty above the ~70 concurrent rakes at peak. */
const MAX_RAKES = 128
/** How fast a rake slides across when it is put onto another line, in
 * e-folds per second — a crossover you can watch, not a teleport. */
const LANE_CHANGE_RATE = 0.9
/** The semantic track indices, as declared in sim/types.ts. */
const SEMANTIC_TRACKS = [0, 1, 2, 3, 4, 5]
/** Rakes fatten up to BULK_MAX x as the camera passes BULK_DISTANCE_M away. */
const BULK_DISTANCE_M = 25000
const BULK_MAX = 3.5

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
  /** Last drawn lateral per service, so a line change eases instead of popping. */
  const lateralRef = useRef(new Map<string, number>())

  const centerTrack = useMemo(() => buildTrainTrack(network, projection, 0), [network, projection])
  const yardRoads = useMemo(
    () => buildYardRoadTracks(network, projection, centerTrack),
    [network, projection, centerTrack],
  )
  const sections = network.sections
  const stationChainageById = useMemo(
    () => new Map(network.stations.map((s) => [s.id, s.chainageM])),
    [network],
  )

  const coachOffsets = useMemo(
    () =>
      Array.from(
        { length: COACHES },
        (_, i) => i * (COACH_LENGTH_SCENE_M + COACH_GAP_SCENE_M) + COACH_LENGTH_SCENE_M / 2,
      ),
    [],
  )

  useFrame(({ camera }, delta) => {
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
    // Where each rake will actually be drawn: nose shifted to the platform
    // edge on an approach or departure, lateral taken from the line it is
    // timetabled on — with the lines running the same way offered as fallbacks
    // if that one is already occupied here (see assignLanes).
    const rakes = states.map((state) => {
      const dirSign = state.direction === 'down' ? 1 : -1
      const nextStopChainageM = stationChainageById.get(state.nextStopId) ?? state.chainageM
      const parked = state.parkedYardId !== null
      const refOffset = parked
        ? 0
        : dirSign * platformNoseOffsetM(state.chainageM, nextStopChainageM, state.legDistanceM)
      const home = parked ? 0 : laneLateralAtChainage(sections, state.track, state.chainageM)
      // Every line running the same way, nearest first — same parity as the
      // service's own track, since every *_UP constant is odd. Nearest first
      // means a slow service reaches for the fast line beside it before the
      // express road beyond it, and a fast one drops to the slow line only
      // when the express road is taken too.
      const alternatives = parked
        ? []
        : SEMANTIC_TRACKS.filter((t) => t % 2 === state.track % 2 && t !== state.track)
            .map((t) => laneLateralAtChainage(sections, t, state.chainageM))
            .filter((lat) => Math.abs(lat - home) > 1)
            .sort((a, b) => Math.abs(a - home) - Math.abs(b - home))
      return {
        state,
        dirSign,
        refOffset,
        along: state.chainageM + refOffset,
        home,
        alternatives,
        lateral: home,
      }
    })
    // Parked rakes stand on their own roads and share no space with anything
    // on the corridor, so they take no part in this. Ordered leading train
    // first — down services run up the chainage, up services down it — so the
    // train ahead keeps its own line and the follower is the one put across.
    const running = rakes.filter((r) => r.state.parkedYardId === null)
    running.sort((a, b) => b.dirSign * b.along - a.dirSign * a.along)
    assignLanes(running)

    // Eased toward the assigned line rather than snapped onto it, so being
    // put onto the fast line reads as a train crossing over.
    const smoothed = lateralRef.current
    const damp = 1 - Math.exp(-LANE_CHANGE_RATE * delta)
    for (const r of rakes) {
      const prev = smoothed.get(r.state.id)
      const next = prev === undefined ? r.lateral : prev + (r.lateral - prev) * damp
      smoothed.set(r.state.id, next)
      r.lateral = next
    }
    if (smoothed.size > states.length * 4) {
      const live = new Set(states.map((s) => s.id))
      for (const id of smoothed.keys()) if (!live.has(id)) smoothed.delete(id)
    }
    let n = 0
    let rake = 0
    for (const { state, dirSign: baseDirSign, refOffset: baseRefOffset, lateral: drawnLateral } of rakes) {
      if (n >= MAX_RAKES * COACHES) break
      const livery = LIVERY[state.serviceType]
      // Parked rakes (ticket #17) pose on their own yard siding instead of
      // the corridor: a fixed nose-to-tail slot, no platform/lane geometry.
      const roads = state.parkedYardId ? yardRoads.get(state.parkedYardId) : undefined
      const yardTrack = roads ? roadForSlot(roads, state.parkedSlot) : undefined
      const track: TrainTrack = yardTrack ?? centerTrack
      let lateral = drawnLateral
      let dirSign = baseDirSign
      let trackChainageM = state.chainageM
      let refOffset = baseRefOffset
      if (yardTrack) {
        lateral = 0 // the road itself is already offset; see rake-geometry
        dirSign = 1 // nose points from the junction into the yard
        trackChainageM = PARKED_RAKE_CHAINAGE_M
      } else {
        // TrainState.chainageM is the rake's leading edge while moving (correct
        // for a real train's front relative to signals/platforms) — but while
        // dwelling it equals the station's own chainage exactly, and platforms
        // are centered on that same point. Left as the nose, the rake (~555
        // scene-m) would hang ~245 scene-m off the back of a 620 scene-m
        // platform. Shift the whole rake forward so the nose pulls up near the
        // platform's far edge instead, same as a real driver would.
        //
        // Blended continuously rather than gated on the `dwelling` boolean —
        // gating would snap the whole rake forward the instant dwelling starts,
        // and back the instant it ends. Two edgeBlend()s, taken by whichever
        // shifts the rake further forward: distance-to-next-stop while
        // approaching, distance-since-last-stop while departing (0 either way
        // while actually dwelling, so both already agree there).
        // See platformNoseOffsetM — shared with the cab camera, which has to
        // stand where the rake is actually drawn.
        const nextStopChainageM = stationChainageById.get(state.nextStopId) ?? state.chainageM
        refOffset =
          dirSign * platformNoseOffsetM(state.chainageM, nextStopChainageM, state.legDistanceM)
      }
      // Extra width/height exaggeration as the camera pulls away, so rakes
      // stay readable over the whole corridor but sit true at station level.
      const nose = poseAt(track, trackChainageM, refOffset)
      const noseY = heightfield.railY(nose.x, nose.z)
      const camDist = Math.hypot(
        camera.position.x - nose.x,
        camera.position.y - noseY,
        camera.position.z - nose.z,
      )
      const bulk = Math.min(BULK_MAX, Math.max(1, camDist / BULK_DISTANCE_M))
      for (let c = 0; c < COACHES; c++) {
        const pose = poseAt(track, trackChainageM, refOffset - dirSign * coachOffsets[c])
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
      const tip = poseAt(track, trackChainageM, refOffset + dirSign * NOSE_L * 0.9)
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
        const p = poseAt(track, trackChainageM, refOffset - dirSign * endOffset)
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

