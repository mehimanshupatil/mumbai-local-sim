import { useMemo } from 'react'
import { Billboard } from '@react-three/drei'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
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
/** Two platform instances (one each side of the tracks) pushed per station,
 * in station order — see platformMatrices below. */
const PLATFORMS_PER_STATION = 2
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

interface StationPose {
  id: string
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

  // Two platforms per station, flanking the outermost tracks. Height is
  // sampled at each platform's own offset position, not the station's
  // centerline pose — same reasoning as the ballast bed above.
  const platformMatrices = useMemo(() => {
    const out: Matrix4[] = []
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    for (const s of stations) {
      const half = (s.tracks * TRACK_SPACING_SCENE_M) / 2 + PLATFORM_W / 2 + 6
      const nx = -Math.cos(s.angleRad)
      const nz = Math.sin(s.angleRad)
      q.setFromAxisAngle(up, s.angleRad)
      for (const side of [1, -1]) {
        const px = s.x + nx * half * side
        const pz = s.z + nz * half * side
        const py = heightfield.railY(px, pz)
        out.push(
          new Matrix4().compose(new Vector3(px, py + PLATFORM_H / 2 - 1, pz), q, new Vector3(1, 1, 1)),
        )
      }
    }
    return out
  }, [stations, heightfield])

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
      <instancedMesh
        args={[undefined, undefined, platformMatrices.length]}
        ref={applyMatrices(platformMatrices)}
        frustumCulled={false}
        onClick={(e) => {
          e.stopPropagation()
          if (e.instanceId === undefined) return
          const station = stations[Math.floor(e.instanceId / PLATFORMS_PER_STATION)]
          if (station) onSelectStation(station.id)
        }}
      >
        <boxGeometry args={[PLATFORM_W, PLATFORM_H, PLATFORM_L]} />
        <meshStandardMaterial color={PLATFORM_COLOR} roughness={0.9} />
      </instancedMesh>
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
