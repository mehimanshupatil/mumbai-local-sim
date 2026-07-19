import { useMemo } from 'react'
import { Billboard, Text } from '@react-three/drei'
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
import { IS_COARSE_POINTER, TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { FONT_EN, FONT_MR } from './fonts'
import { buildTrainTrack, poseAt, sectionAtChainage, type TrainTrack } from './track-geometry'

const BALLAST_MARGIN_M = 22
const BALLAST_COLOR = '#57504a'
const PLATFORM_L = 620
const PLATFORM_W = 32
const PLATFORM_H = 10
const PLATFORM_COLOR = '#8f8a84'
const BOARD_W = 210
const BOARD_H = 56
const BOARD_Y = 150
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
    const y = heightfield.railY(x, z) - 0.8
    positions.push(x + nx * half, y, z + nz * half, x - nx * half, y, z - nz * half)
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
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
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

  // Two platforms per station, flanking the outermost tracks.
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
        out.push(
          new Matrix4().compose(
            new Vector3(s.x + nx * half * side, s.y + PLATFORM_H / 2 - 1, s.z + nz * half * side),
            q,
            new Vector3(1, 1, 1),
          ),
        )
      }
    }
    return out
  }, [stations])

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
        <Billboard key={s.name} position={[s.x, s.y + BOARD_Y, s.z]}>
          {/* Classic WR yellow board: EN over Marathi, black on yellow. */}
          <mesh>
            <planeGeometry args={[BOARD_W, BOARD_H]} />
            <meshBasicMaterial color="#f2c40f" />
          </mesh>
          <Text
            position={[0, 10, 0.5]}
            font={FONT_EN}
            fontSize={24}
            color="#151208"
            anchorY="middle"
            renderOrder={11}
            material-depthTest={false}
          >
            {s.name}
          </Text>
          <Text
            position={[0, -14, 0.5]}
            font={FONT_MR}
            fontSize={17}
            color="#151208"
            anchorY="middle"
            renderOrder={11}
            material-depthTest={false}
          >
            {s.nameMr}
          </Text>
        </Billboard>
      ))}
    </group>
  )
}
