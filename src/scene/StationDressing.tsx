import { useMemo } from 'react'
import { Billboard } from '@react-three/drei'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'
import type { NetworkData } from '../data/network-types'
import { IS_COARSE_POINTER, PLATFORM_LENGTH_SCENE_M, TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrainTrack, poseAt, sectionAtChainage, type TrainTrack } from './track-geometry'
import { WRBoard } from './WRBoard'

const BALLAST_MARGIN_M = 22
const BALLAST_COLOR = '#57504a'
const PLATFORM_L = PLATFORM_LENGTH_SCENE_M
const PLATFORM_W = 32
const PLATFORM_H = 10
const PLATFORM_COLOR = '#8f8a84'
const BOARD_Y = 150
/** Sample points along a platform's length — enough to read as following the
 * local track curve on a bend (e.g. Bandra, Dadar) without a visible facet. */
const PLATFORM_STEPS = 6
const BUILDINGS_PER_STATION = IS_COARSE_POINTER ? 8 : 24

/** Deterministic PRNG so the city never reshuffles between loads. */
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

/** Ballast bed: a corridor-long ribbon under the tracks, width per section. */
function ballastGeometry(network: NetworkData, track: TrainTrack, heightfield: Heightfield) {
  const { points, lengths, scale } = track
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i]
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dx = next[0] - prev[0]
    const dz = next[1] - prev[1]
    const len = Math.hypot(dx, dz) || 1
    const nx = -dz / len
    const nz = dx / len
    const section = sectionAtChainage(network.sections, lengths[i] / scale)
    const half = (section.tracks * TRACK_SPACING_SCENE_M) / 2 + BALLAST_MARGIN_M
    // Sample height at each edge independently — a 6-track section's edges
    // sit up to ~97 scene-m either side of the centerline, and terrain
    // slope over that span means the centerline's height doesn't apply
    // across the whole cross-section. Using one flat height for both edges
    // is what caused the bed to visibly part company with the rails on
    // sloped ground.
    const rightX = x + nx * half
    const rightZ = z + nz * half
    const leftX = x - nx * half
    const leftZ = z - nz * half
    const rightY = heightfield.railY(rightX, rightZ) - 0.8
    const leftY = heightfield.railY(leftX, leftZ) - 0.8
    positions.push(rightX, rightY, rightZ, leftX, leftY, leftZ)
    if (i > 0) {
      // Wound counter-clockwise seen from above (+y) so the bed isn't culled.
      const a = (i - 1) * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

/**
 * One platform, as a curved box following the local track curve — sampled
 * via poseAt at even intervals along the platform's length, same idea as
 * ballastGeometry's per-point sampling, so a platform on a bend (e.g.
 * Bandra, Dadar) doesn't render as a straight box cutting across the curve.
 */
function platformGeometry(
  track: TrainTrack,
  heightfield: Heightfield,
  station: StationPose,
  side: 1 | -1,
): BufferGeometry {
  const centerOffset = ((station.tracks * TRACK_SPACING_SCENE_M) / 2 + PLATFORM_W / 2 + 6) * side
  const innerOffset = centerOffset - side * (PLATFORM_W / 2)
  const outerOffset = centerOffset + side * (PLATFORM_W / 2)
  const positions: number[] = []
  const indices: number[] = []
  for (let k = 0; k <= PLATFORM_STEPS; k++) {
    const along = -PLATFORM_L / 2 + (k * PLATFORM_L) / PLATFORM_STEPS
    const pose = poseAt(track, station.chainageM, along)
    const nx = -Math.cos(pose.angleRad)
    const nz = Math.sin(pose.angleRad)
    const ix = pose.x + nx * innerOffset
    const iz = pose.z + nz * innerOffset
    const ox = pose.x + nx * outerOffset
    const oz = pose.z + nz * outerOffset
    const iy = heightfield.railY(ix, iz)
    const oy = heightfield.railY(ox, oz)
    // 4 verts per step: innerTop, outerTop, innerBottom, outerBottom.
    positions.push(
      ix, iy + PLATFORM_H - 1, iz,
      ox, oy + PLATFORM_H - 1, oz,
      ix, iy - 1, iz,
      ox, oy - 1, oz,
    )
    if (k > 0) {
      const a = (k - 1) * 4
      const b = k * 4
      indices.push(a, a + 1, b, b, a + 1, b + 1) // top
      indices.push(a + 1, a + 3, b + 1, b + 1, a + 3, b + 3) // outer wall
      indices.push(a + 2, b + 2, a, a, b + 2, b) // inner wall
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

interface StationPose {
  id: string
  chainageM: number
  x: number
  z: number
  y: number
  angleRad: number
  tracks: number
  name: string
  nameMr: string
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

export function StationDressing({
  network,
  projection,
  heightfield,
  onSelectStation,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  onSelectStation: (stationId: string) => void
}) {
  const track = useMemo(() => buildTrainTrack(network, projection, 0), [network, projection])

  const ballast = useMemo(
    () => ballastGeometry(network, track, heightfield),
    [network, track, heightfield],
  )

  const stations = useMemo<StationPose[]>(
    () =>
      network.stations.map((s) => {
        const pose = poseAt(track, s.chainageM)
        return {
          id: s.id,
          chainageM: s.chainageM,
          x: pose.x,
          z: pose.z,
          y: heightfield.railY(pose.x, pose.z),
          angleRad: pose.angleRad,
          tracks: sectionAtChainage(network.sections, s.chainageM).tracks,
          name: s.name,
          nameMr: s.nameMr,
        }
      }),
    [network, track, heightfield],
  )

  // Two platforms per station, flanking the outermost tracks, each a small
  // standalone mesh curved to the local track (see platformGeometry) —
  // one shared instanced box can't follow a curve that differs per station.
  const platforms = useMemo(
    () =>
      stations.flatMap((station) =>
        ([1, -1] as const).map((side) => ({
          key: `${station.id}-${side}`,
          station,
          geometry: platformGeometry(track, heightfield, station, side),
        })),
      ),
    [stations, track, heightfield],
  )

  // Sparse procedural blocks around each station, off the rail corridor.
  const buildingInstances = useMemo(() => {
    const matrices: Matrix4[] = []
    const colors: Color[] = []
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    stations.forEach((s, si) => {
      const rand = mulberry32(si * 7919 + 17)
      const nx = -Math.cos(s.angleRad)
      const nz = Math.sin(s.angleRad)
      const fx = Math.sin(s.angleRad)
      const fz = Math.cos(s.angleRad)
      const corridorHalf = (s.tracks * TRACK_SPACING_SCENE_M) / 2 + PLATFORM_W + 40
      for (let i = 0; i < BUILDINGS_PER_STATION; i++) {
        const side = rand() > 0.5 ? 1 : -1
        const lateral = corridorHalf + 40 + rand() * 700
        const along = (rand() - 0.5) * 1600
        const x = s.x + nx * lateral * side + fx * along
        const z = s.z + nz * lateral * side + fz * along
        const ground = heightfield.sceneY(x, z)
        if (ground < 2) continue // keep out of the sea and creeks
        const w = 40 + rand() * 50
        const h = 25 + rand() * 65
        const d = 40 + rand() * 50
        q.setFromAxisAngle(up, s.angleRad + (rand() - 0.5) * 0.4)
        matrices.push(
          new Matrix4().compose(new Vector3(x, ground + h / 2, z), q.clone(), new Vector3(w, h, d)),
        )
        const shade = 0.55 + rand() * 0.25
        colors.push(new Color(shade, shade * 0.98, shade * 0.94))
      }
    })
    return { matrices, colors }
  }, [stations, heightfield])

  return (
    <group>
      <mesh geometry={ballast}>
        <meshStandardMaterial color={BALLAST_COLOR} roughness={1} />
      </mesh>
      {platforms.map(({ key, station, geometry }) => (
        <mesh
          key={key}
          geometry={geometry}
          onClick={(e) => {
            e.stopPropagation()
            onSelectStation(station.id)
          }}
        >
          <meshStandardMaterial color={PLATFORM_COLOR} roughness={0.9} side={DoubleSide} />
        </mesh>
      ))}
      <instancedMesh
        args={[undefined, undefined, Math.max(1, buildingInstances.matrices.length)]}
        ref={applyMatrices(buildingInstances.matrices, buildingInstances.colors)}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      {stations.map((s) => (
        <Billboard
          key={s.id}
          position={[s.x, s.y + BOARD_Y, s.z]}
          onClick={(e) => {
            e.stopPropagation()
            onSelectStation(s.id)
          }}
        >
          <WRBoard name={s.name} nameMr={s.nameMr} />
        </Billboard>
      ))}
    </group>
  )
}
