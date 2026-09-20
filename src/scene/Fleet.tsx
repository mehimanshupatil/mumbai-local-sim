import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { InstancedBufferAttribute, InstancedMesh, Object3D, Vector3 } from 'three'
import type { NetworkData } from '../data/network-types'
import { trainStates, type Timetable } from '../sim/simulate'
import { COACH_GAP_SCENE_M, COACH_LENGTH_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import { COACH } from './livery-atlas'
import type { Projection } from './projection'
import {
  buildYardRoadTracks,
  COACHES,
  trackLateralAtChainage,
  NOSE_L,
  PARKED_RAKE_CHAINAGE_M,
  platformNoseOffsetM,
  RAKE_LEN,
  roadForSlot,
} from './rake-geometry'
import {
  addInstanceAttributes,
  BODY_H,
  BODY_W,
  buildCabGeometry,
  buildCoachFarGeometry,
  buildCoachGeometry,
  buildRakeMaterial,
  loadAtlas,
  LIVERY,
  SEED_ATTRIBUTE,
  STRIPE_ATTRIBUTE,
} from './rake-visual'
import {
  buildRiderGeometry,
  doorwayLoad,
  MAX_PER_DOORWAY,
  rakeSeed,
  riderColor,
  riderSlots,
} from './riders'
import { trackForLineAt } from '../sim/lines'
import { simClock } from './sim-clock'
import { buildTrainTrack, poseAt, type TrainTrack } from './track-geometry'

/** Instance capacity — plenty above the ~70 concurrent rakes at peak. */
const MAX_RAKES = 128
/**
 * How many rakes can wear the detailed geometry at once. A station or follow
 * camera sees a handful; anything past that is far enough to be a box anyway,
 * and a rake over the budget simply draws as its far LOD.
 */
const MAX_NEAR_RAKES = 24
/**
 * Camera distance at which a rake drops to the box LOD. At 2.5 km a coach is
 * a few pixels across and the masks are below the mip chain — and the box is
 * what the distance-fattening lie below reads well on.
 */
const DETAIL_DISTANCE_M = 2500
/**
 * Riders are drawn much closer in than the coach they stand in: a figure is
 * subpixel well before a doorway is, and a crush-loaded rake is ~290 of them.
 */
const RIDER_DISTANCE_M = 900
const MAX_RIDER_RAKES = 6
/** Both sides of the body, every doorway, filled to crush. */
const RIDERS_PER_COACH = COACH.doorsPerSide * 2 * MAX_PER_DOORWAY
/** Rakes fatten up to BULK_MAX x as the camera passes BULK_DISTANCE_M away. */
const BULK_DISTANCE_M = 25000
const BULK_MAX = 3.5

let warnedCapacity = false

/**
 * The whole fleet, posed from the sim seam every frame: coaches near the
 * camera drawn with the masked geometry from rake-visual, the rest as the
 * boxes they have always been, plus a cab at each end of a near rake.
 *
 * What a coach looks like lives in rake-visual.ts; this file is instancing,
 * posing and the sim wiring, and nothing else.
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
  const nearRef = useRef<InstancedMesh>(null)
  const riderRef = useRef<InstancedMesh>(null)
  const farRef = useRef<InstancedMesh>(null)
  const cabRef = useRef<InstancedMesh>(null)
  const lightRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const rider = useMemo(() => new Object3D(), [])
  const riderAt = useMemo(() => new Vector3(), [])
  const riderGeometry = useMemo(() => buildRiderGeometry(), [])

  const visual = useMemo(() => {
    const atlas = loadAtlas(import.meta.env.BASE_URL)
    const { material, uniforms } = buildRakeMaterial(atlas)
    const coach = buildCoachGeometry()
    const cab = buildCabGeometry()
    addInstanceAttributes(coach, MAX_NEAR_RAKES * COACHES)
    addInstanceAttributes(cab, MAX_NEAR_RAKES * 2)
    return { material, uniforms, coach, cab, far: buildCoachFarGeometry() }
  }, [])

  /** Service id per drawn rake slot, per mesh, refreshed every frame for click picking. */
  const nearIds = useRef<string[]>([])
  const farIds = useRef<string[]>([])

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

  useFrame(({ camera }) => {
    const near = nearRef.current
    const far = farRef.current
    const cabs = cabRef.current
    const lights = lightRef.current
    const riders = riderRef.current
    if (!near || !far || !cabs || !lights || !riders) return
    visual.uniforms.uNight.value = night
    const stripeOf = (mesh: InstancedMesh) =>
      mesh.geometry.getAttribute(STRIPE_ATTRIBUTE) as InstancedBufferAttribute
    const seedOf = (mesh: InstancedMesh) =>
      mesh.geometry.getAttribute(SEED_ATTRIBUTE) as InstancedBufferAttribute
    const states = trainStates(timetables, simClock.t)
    if (states.length > MAX_RAKES && !warnedCapacity) {
      warnedCapacity = true
      console.warn(`Fleet: ${states.length} concurrent rakes exceed capacity ${MAX_RAKES}; truncating`)
    }
    // Where each rake will actually be drawn: on the line it is timetabled
    // on, nose shifted toward the platform edge on an approach or departure.
    const rakes = states.map((state) => {
      const dirSign = state.direction === 'down' ? 1 : -1
      const nextStopChainageM = stationChainageById.get(state.nextStopId) ?? state.chainageM
      const parked = state.parkedYardId !== null
      return {
        state,
        dirSign,
        // Capped below, so keep the unclamped pull-up distance to hand.
        wantOffset: parked
          ? 0
          : platformNoseOffsetM(state.chainageM, nextStopChainageM, state.legDistanceM),
        refOffset: 0,
        lateral: parked ? 0 : trackLateralAtChainage(sections, state.lineId, state.chainageM),
      }
    })

    // The sim holds trains a block apart on the line (MIN_SEPARATION_M), but
    // that is in chainage, and pulling a rake up to the platform edge moves
    // the drawn one forward by up to ~295 scene-m on top of it — enough to
    // eat the gap and put it inside the train ahead. A driver does not pull
    // up into an occupied platform either: the pull-up is given only as much
    // room as the train ahead leaves.
    const lines = new Map<string, typeof rakes>()
    for (const r of rakes) {
      if (r.state.parkedYardId !== null) continue
      const key = `${trackForLineAt(sections, r.state.lineId, r.state.chainageM)}:${r.state.direction}`
      const line = lines.get(key)
      if (line) line.push(r)
      else lines.set(key, [r])
    }
    for (const line of lines.values()) {
      const sign = line[0].dirSign
      line.sort((a, b) => sign * (b.state.chainageM - a.state.chainageM)) // leader first
      let aheadTail = sign * Infinity
      for (const r of line) {
        const want = r.state.chainageM + sign * r.wantOffset
        // Keep a rake length between this nose and the tail ahead of it.
        const limit = aheadTail - sign * RAKE_LEN
        const nose = sign > 0 ? Math.min(want, limit) : Math.max(want, limit)
        r.refOffset = sign * Math.max(0, sign * (nose - r.state.chainageM))
        aheadTail = r.state.chainageM + r.refOffset - sign * RAKE_LEN
      }
    }
    let nearN = 0
    let farN = 0
    let cabN = 0
    let riderN = 0
    let riderRakes = 0
    let rake = 0
    for (const { state, dirSign: baseDirSign, refOffset: baseRefOffset, lateral: drawnLateral } of rakes) {
      if (rake >= MAX_RAKES) break
      const livery = LIVERY[state.serviceType]
      // Parked rakes (ticket #17) pose on their own yard siding instead of
      // the Route: a fixed nose-to-tail slot, no platform or Track geometry.
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
      const nose = poseAt(track, trackChainageM, refOffset)
      const noseY = heightfield.railY(nose.x, nose.z)
      const camDist = Math.hypot(
        camera.position.x - nose.x,
        camera.position.y - noseY,
        camera.position.z - nose.z,
      )
      // Detailed near the camera, box beyond — and only the box gets the
      // extra width/height exaggeration that keeps far rakes readable, since
      // fattening a masked body stretches its windows with it.
      const detailed = camDist < DETAIL_DISTANCE_M && nearN + COACHES <= MAX_NEAR_RAKES * COACHES
      const bulk = detailed ? 1 : Math.min(BULK_MAX, Math.max(1, camDist / BULK_DISTANCE_M))
      const mesh = detailed ? near : far
      // Riders in the doorways, on the rakes close enough for a figure to be
      // more than a pixel. How full they are is the sim's Crowding curve, so
      // the same Rake is packed Up at 08:00 and empty Down at 09:00.
      const withRiders = detailed && camDist < RIDER_DISTANCE_M && riderRakes < MAX_RIDER_RAKES
      const load = withRiders ? doorwayLoad(simClock.t, state.direction) : 0
      const crowdSeed = withRiders ? rakeSeed(state.id) : 0
      if (withRiders) riderRakes++
      if (!detailed && farN + COACHES > MAX_RAKES * COACHES) break
      // One seed per rake: the shader varies lit windows off it, so a night
      // rake is not twelve identical glowing bars.
      const seed = (rake * 2654435761) % 4096
      for (let c = 0; c < COACHES; c++) {
        const alongOffset = refOffset - dirSign * coachOffsets[c]
        const pose = poseAt(track, trackChainageM, alongOffset)
        // Same normal convention as offsetPolyline: left of travel = (-dz, dx).
        const nx = -Math.cos(pose.angleRad)
        const nz = Math.sin(pose.angleRad)
        // Each coach takes the lateral of the line beneath *it*, not the one
        // beneath the cab. A rake is 555 scene-m long and the lines shift
        // sideways across a section boundary, so a single lateral for the
        // whole train leaves it cutting the corner of its own line — and two
        // trains passing there, each held rigidly off its own rails, can be
        // drawn straight through one another.
        const coachLateral = yardTrack
          ? lateral
          : trackLateralAtChainage(sections, state.lineId, trackChainageM + alongOffset / track.scale)
        const px = pose.x + nx * coachLateral
        const pz = pose.z + nz * coachLateral
        dummy.position.set(px, heightfield.railY(px, pz) + (BODY_H * bulk) / 2, pz)
        // A coach faces the way the rake runs, so its cab end and its masks
        // read the same way round along the whole train.
        dummy.rotation.set(0, pose.angleRad + (dirSign === 1 ? 0 : Math.PI), 0)
        dummy.scale.set(bulk, bulk, 1)
        dummy.updateMatrix()
        const n = detailed ? nearN++ : farN++
        mesh.setMatrixAt(n, dummy.matrix)
        mesh.setColorAt(n, livery.body)
        if (detailed) {
          stripeOf(near).setXYZ(n, livery.stripe.r, livery.stripe.g, livery.stripe.b)
          seedOf(near).setX(n, seed + c)
        }
        if (withRiders) {
          for (const slot of riderSlots(crowdSeed, c, load)) {
            // Slots are coach-local, so the coach's own matrix puts them in
            // the doorway wherever that coach has ended up on the Track.
            riderAt.set(slot.x, slot.y, slot.z).applyMatrix4(dummy.matrix)
            rider.position.copy(riderAt)
            rider.rotation.set(0, pose.angleRad, 0)
            rider.updateMatrix()
            riders.setMatrixAt(riderN, rider.matrix)
            riders.setColorAt(riderN, riderColor(slot.variation))
            riderN++
          }
        }
      }
      if (detailed) nearIds.current[nearN / COACHES - 1] = state.id
      else farIds.current[farN / COACHES - 1] = state.id
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
      // Cab ends cap a near rake, pointing outward along travel. Beyond the
      // detail distance a 14 scene-m nose is subpixel, so it is simply gone.
      if (detailed) {
        for (const [endOffset, flip] of [
          [-NOSE_L / 2, 0], // ahead of the leading coach face
          [RAKE_LEN + NOSE_L / 2, Math.PI], // beyond the trailing face
        ] as const) {
          const p = poseAt(track, trackChainageM, refOffset - dirSign * endOffset)
          const ex = -Math.cos(p.angleRad)
          const ez = Math.sin(p.angleRad)
          const px = p.x + ex * lateral
          const pz = p.z + ez * lateral
          dummy.position.set(px, heightfield.railY(px, pz) + BODY_H / 2, pz)
          dummy.rotation.set(0, p.angleRad + (dirSign === 1 ? 0 : Math.PI) + flip, 0)
          dummy.scale.set(1, 1, 1)
          dummy.updateMatrix()
          cabs.setMatrixAt(cabN, dummy.matrix)
          cabs.setColorAt(cabN, livery.body)
          stripeOf(cabs).setXYZ(cabN, livery.stripe.r, livery.stripe.g, livery.stripe.b)
          seedOf(cabs).setX(cabN, seed)
          cabN++
        }
      }
      rake++
    }
    nearIds.current.length = nearN / COACHES
    farIds.current.length = farN / COACHES
    near.count = nearN
    far.count = farN
    cabs.count = cabN
    riders.count = riderN
    lights.count = rake
    for (const mesh of [near, far, cabs, lights, riders]) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    for (const mesh of [near, cabs]) {
      stripeOf(mesh).needsUpdate = true
      seedOf(mesh).needsUpdate = true
    }
  })

  /** Clicking any coach selects the Service that rake is working. */
  const pick = (ids: React.RefObject<string[]>, per: number) => (e: { stopPropagation: () => void; instanceId?: number }) => {
    e.stopPropagation()
    if (e.instanceId === undefined) return
    const id = ids.current[Math.floor(e.instanceId / per)]
    if (id) onSelectTrain(id)
  }

  return (
    <group>
      <instancedMesh
        ref={nearRef}
        args={[visual.coach, visual.material, MAX_NEAR_RAKES * COACHES]}
        frustumCulled={false}
        onClick={pick(nearIds, COACHES)}
      />
      <instancedMesh
        ref={farRef}
        args={[visual.far, undefined, MAX_RAKES * COACHES]}
        frustumCulled={false}
        onClick={pick(farIds, COACHES)}
      >
        {/* Far rakes keep a hint of the lit-window glow, or the corridor view
            loses its trains after dark. */}
        <meshStandardMaterial emissive="#ffca7a" emissiveIntensity={night * 0.5} />
      </instancedMesh>
      {/* Riders standing in the open doorways — the doorway is open by
          definition here, so this is what fills it. */}
      <instancedMesh
        ref={riderRef}
        args={[riderGeometry, undefined, MAX_RIDER_RAKES * COACHES * RIDERS_PER_COACH]}
        frustumCulled={false}
      >
        <meshStandardMaterial roughness={0.9} metalness={0} />
      </instancedMesh>
      <instancedMesh
        ref={cabRef}
        args={[visual.cab, visual.material, MAX_NEAR_RAKES * 2]}
        frustumCulled={false}
      />
      {/* housing always drawn (visible unlit by day); glow fades in with night,
          same as the window mask, instead of popping on at a threshold */}
      <instancedMesh ref={lightRef} args={[undefined, undefined, MAX_RAKES]} frustumCulled={false}>
        <boxGeometry args={[BODY_W * 0.7, BODY_H * 0.35, 6]} />
        <meshStandardMaterial emissive="#fff3c4" emissiveIntensity={night * 3} color="#3a3a30" />
      </instancedMesh>
    </group>
  )
}
