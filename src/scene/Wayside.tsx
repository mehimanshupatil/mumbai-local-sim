import { useMemo, useRef } from 'react'
import { Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import type { NetworkData } from '../data/network-types'
import { PLATFORM_LENGTH_SCENE_M, TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrainTrack, poseAt, sectionAtChainage } from './track-geometry'

/**
 * Decorative OHE masts + signal posts along the whole corridor (ticket #20).
 * Static dressing only — same fidelity tier as StationDressing's scattered
 * buildings, no working signal-aspect logic (that needs a real block-
 * occupancy model in src/sim/, out of scope here) and no sim state read.
 */

/**
 * Real WR OHE mast spacing is ~60-80m — but chainage here is true-scale
 * while the train isn't (COACH_LENGTH_SCENE_M exaggerates coach length 2x,
 * same reasoning as that constant's own comment: a 120km corridor needs
 * exaggerated foreground detail to read at all). Left at true scale, a rake
 * would pass ~8 gantries along its own oversized length versus ~3.7 in
 * reality — poles read as packed tight next to an oversized train. Scaling
 * spacing by the same 2x keeps it proportional to the train instead.
 * Masts run in portal-gantry pairs (one either side of the tracks + a
 * spanning boom) so a single shape works for every section regardless of
 * track count.
 */
const OHE_SPACING_M = 300
const OHE_MAST_HEIGHT = 45
const OHE_MAST_RADIUS = 2.5
const OHE_BOOM_Y = 42
const OHE_BOOM_THICKNESS = 2.5
/** Clearance from the outermost track to a mast's own centreline. */
const OHE_MARGIN_M = 15
const OHE_COLOR = '#565b5f'

/** Block signals between stations, independent of station spacing. */
const SIGNAL_INTERVAL_M = 1200
const SIGNAL_MAST_HEIGHT = 28
const SIGNAL_MAST_RADIUS = 1.6
const SIGNAL_HEAD_SIZE = 5
const SIGNAL_LATERAL_MARGIN_M = 10
const SIGNAL_MAST_COLOR = '#3a3a3a'
/** Static aspects, purely decorative variety — not tied to any train or block. */
const SIGNAL_ASPECTS = ['#d32f2f', '#f9a825', '#2e7d32']
/** Gap beyond the platform's own length before a starter signal stands. */
const PLATFORM_SIGNAL_GAP_M = 25

/** Deterministic PRNG so wayside dressing never reshuffles between loads. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const applyMatrices = (matrices: Matrix4[], colors?: Color[]) => (mesh: InstancedMesh | null) => {
  if (!mesh) return
  matrices.forEach((m, i) => {
    mesh.setMatrixAt(i, m)
    if (colors) mesh.setColorAt(i, colors[i])
  })
  mesh.count = matrices.length
  mesh.instanceMatrix.needsUpdate = true
  if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

export function Wayside({
  network,
  projection,
  heightfield,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
}) {
  const track = useMemo(() => buildTrainTrack(network, projection, 0), [network, projection])
  const q = useRef(new Quaternion()).current
  const up = useRef(new Vector3(0, 1, 0)).current

  const ohe = useMemo(() => {
    const mastMatrices: Matrix4[] = []
    const boomMatrices: Matrix4[] = []
    for (let m = 0; m <= network.lengthM; m += OHE_SPACING_M) {
      const pose = poseAt(track, m)
      const section = sectionAtChainage(network.sections, m)
      const half = (section.tracks * TRACK_SPACING_SCENE_M) / 2 + OHE_MARGIN_M
      const nx = -Math.cos(pose.angleRad)
      const nz = Math.sin(pose.angleRad)
      const groundY = heightfield.railY(pose.x, pose.z)
      q.setFromAxisAngle(up, pose.angleRad)
      for (const side of [-1, 1] as const) {
        const x = pose.x + nx * half * side
        const z = pose.z + nz * half * side
        mastMatrices.push(
          new Matrix4().compose(
            new Vector3(x, groundY + OHE_MAST_HEIGHT / 2, z),
            q.clone(),
            new Vector3(1, 1, 1),
          ),
        )
      }
      // Boom spans between the two masts at OHE_BOOM_Y, oriented along the
      // same heading as the masts (its long axis — local x before rotation —
      // needs to run across the tracks, i.e. along the masts' own local x).
      boomMatrices.push(
        new Matrix4().compose(
          new Vector3(pose.x, groundY + OHE_BOOM_Y, pose.z),
          q.clone(),
          new Vector3(half * 2, OHE_BOOM_THICKNESS, OHE_BOOM_THICKNESS),
        ),
      )
    }
    return { mastMatrices, boomMatrices }
  }, [network, track, heightfield, q, up])

  const signals = useMemo(() => {
    const matrices: Matrix4[] = []
    const heads: { matrix: Matrix4; color: Color }[] = []
    const rand = mulberry32(20260801)
    const placeSignal = (chainageM: number, side: 1 | -1) => {
      const pose = poseAt(track, chainageM)
      const section = sectionAtChainage(network.sections, chainageM)
      const lateral = (section.tracks * TRACK_SPACING_SCENE_M) / 2 + SIGNAL_LATERAL_MARGIN_M
      const nx = -Math.cos(pose.angleRad)
      const nz = Math.sin(pose.angleRad)
      const x = pose.x + nx * lateral * side
      const z = pose.z + nz * lateral * side
      const groundY = heightfield.railY(x, z)
      q.setFromAxisAngle(up, pose.angleRad)
      matrices.push(
        new Matrix4().compose(
          new Vector3(x, groundY + SIGNAL_MAST_HEIGHT / 2, z),
          q.clone(),
          new Vector3(1, 1, 1),
        ),
      )
      heads.push({
        matrix: new Matrix4().compose(
          new Vector3(x, groundY + SIGNAL_MAST_HEIGHT + SIGNAL_HEAD_SIZE / 2, z),
          q.clone(),
          new Vector3(1, 1, 1),
        ),
        color: new Color(SIGNAL_ASPECTS[Math.floor(rand() * SIGNAL_ASPECTS.length)]),
      })
    }

    // Starter signals at every platform end, one per running direction.
    for (const s of network.stations) {
      placeSignal(s.chainageM + PLATFORM_LENGTH_SCENE_M / 2 + PLATFORM_SIGNAL_GAP_M, 1)
      placeSignal(s.chainageM - PLATFORM_LENGTH_SCENE_M / 2 - PLATFORM_SIGNAL_GAP_M, -1)
    }
    // Intermediate block signals, independent of station spacing.
    for (let m = SIGNAL_INTERVAL_M / 2; m < network.lengthM; m += SIGNAL_INTERVAL_M) {
      placeSignal(m, 1)
    }
    return { matrices, heads }
  }, [network, track, heightfield, q, up])

  return (
    <group>
      <instancedMesh
        args={[undefined, undefined, Math.max(1, ohe.mastMatrices.length)]}
        ref={applyMatrices(ohe.mastMatrices)}
        frustumCulled={false}
      >
        <cylinderGeometry args={[OHE_MAST_RADIUS, OHE_MAST_RADIUS, OHE_MAST_HEIGHT, 6]} />
        <meshStandardMaterial color={OHE_COLOR} roughness={0.7} metalness={0.3} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, Math.max(1, ohe.boomMatrices.length)]}
        ref={applyMatrices(ohe.boomMatrices)}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={OHE_COLOR} roughness={0.7} metalness={0.3} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, Math.max(1, signals.matrices.length)]}
        ref={applyMatrices(signals.matrices)}
        frustumCulled={false}
      >
        <cylinderGeometry args={[SIGNAL_MAST_RADIUS, SIGNAL_MAST_RADIUS, SIGNAL_MAST_HEIGHT, 6]} />
        <meshStandardMaterial color={SIGNAL_MAST_COLOR} roughness={0.8} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, Math.max(1, signals.heads.length)]}
        ref={applyMatrices(
          signals.heads.map((h) => h.matrix),
          signals.heads.map((h) => h.color),
        )}
        frustumCulled={false}
      >
        <boxGeometry args={[SIGNAL_HEAD_SIZE, SIGNAL_HEAD_SIZE, SIGNAL_HEAD_SIZE]} />
        <meshStandardMaterial roughness={0.6} />
      </instancedMesh>
    </group>
  )
}
