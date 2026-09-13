import { useMemo, useRef } from 'react'
import { Billboard } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'
import type { NetworkData } from '../data/network-types'
import { IS_COARSE_POINTER, PLATFORM_LENGTH_SCENE_M, TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildYardRoadTracks } from './rake-geometry'
import {
  buildTrainTrack,
  corridorSampleStations,
  poseAt,
  sectionAtChainage,
  type TrainTrack,
} from './track-geometry'
import { BOARD_WIDTH, WRBoard } from './WRBoard'

const BALLAST_MARGIN_M = 22
const BALLAST_COLOR = '#57504a'
const PLATFORM_L = PLATFORM_LENGTH_SCENE_M
const PLATFORM_W = 32
const PLATFORM_H = 10
const PLATFORM_COLOR = '#8f8a84'
const BOARD_Y = 150
/**
 * These boards are the close-up representation: Corridor's floating labels
 * fade *in* over the same band (dist 4000 -> 12000) and take over from here.
 * Without the matching fade *out*, all 37 stayed drawn at every distance and
 * collapsed into overlapping specks near the horizon — the handover was only
 * ever half-implemented, and Corridor's declutter can't see these.
 */
const BOARD_FADE_NEAR = 4000
const BOARD_FADE_FAR = 12000
/**
 * Close in, the floating board hands over to the boards standing on the
 * platform (see platformBoards) — the ones a real station actually has. Left
 * on, a signboard several storeys tall hangs over the roof of the station in
 * every close view.
 */
const BOARD_HANDOVER_NEAR = 700
const BOARD_HANDOVER_FAR = 1700
/**
 * Name boards along each platform, standing square across it — the board face
 * perpendicular to the rails, so it reads to a train coming up the platform
 * and, in this scene, to a camera looking along the corridor.
 * Sized to the platform: standing square across it, the board's width is
 * what spans the platform, so anything wider than the platform hangs out over
 * the tracks either side. That puts it far below the floating board, which is
 * scaled to be read from the station camera 2.3 km up — at that distance
 * these are specks, and they are meant for the views that get close enough to
 * read them.
 */
const PLATFORM_BOARD_W = PLATFORM_W * 0.8
const PLATFORM_BOARD_SCALE = PLATFORM_BOARD_W / BOARD_WIDTH
const PLATFORM_BOARD_POST_H = 13
/** Boards per platform face — one turned toward each end. */
const PLATFORM_BOARDS = 2
/** How far in from the platform end a board stands. */
const PLATFORM_BOARD_INSET_M = 70
/** Past this the platform boards are too small to resolve, so skip drawing
 * them rather than paying for a few hundred text meshes every frame. */
const PLATFORM_BOARD_VISIBLE_M = 3500
/** Sample points along a platform's length — enough to read as following the
 * local track curve on a bend (e.g. Bandra, Dadar) without a visible facet. */
const PLATFORM_STEPS = 6
const BUILDINGS_PER_STATION = IS_COARSE_POINTER ? 8 : 24
/**
 * Lit windows after dark. The city was a field of unlit boxes at night — the
 * only light on the map came from the platform lamps and the rakes' own
 * window strips, so a 124 km corridor read as empty ground. These are their
 * own instanced mesh rather than an emissive term on the buildings, because
 * instanceColor only multiplies the diffuse colour: a material-level emissive
 * lights every block identically, whereas scattering separate window quads
 * gives each block its own pattern of lit and dark.
 */
const WINDOWS_PER_BUILDING = IS_COARSE_POINTER ? 4 : 10
/** Sized like everything else here — a true-scale window is sub-pixel even
 * at the station camera's ~2.3 km (see config.ts's RENDER_EXAGGERATION). */
const WINDOW_W = 15
const WINDOW_H = 9
const WINDOW_COLOR = '#ffd9a0'
/**
 * Street lighting. Windows alone only read from close in — from corridor
 * altitude a lit facade is sub-pixel and the city went black again. These are
 * small emissive points at head height, dense enough that each station reads
 * as a pool of light on an otherwise dark coast.
 */
const LAMPS_PER_STATION = IS_COARSE_POINTER ? 25 : 80
const LAMP_COLOR = '#ffb765'
const LAMP_RADIUS = 3.5
const LAMP_HEIGHT = 12
/** Buildings with any lights on at all — the rest stay dark, so the city
 * doesn't read as uniformly occupied at 03:00. */
const LIT_BUILDING_SHARE = 0.72
/**
 * Clear ground either side of a yard's stabling roads. The building scatter
 * starts just outside the platforms and runs 700 m out, which is exactly
 * where the roads are — so blocks were landing on top of them, and a yard
 * read as a car shed inside an office park.
 */
const YARD_CLEAR_M = 45

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

/**
 * Ballast bed: a corridor-long ribbon under the tracks, width per section.
 *
 * Sampled as a grid, not a two-edge strip. Both dimensions of that grid are
 * forced by the same rule — the bed only stays under the rails where it
 * chords no longer a span of terrain than the tracks do:
 *
 * - Across: a 6-track section's cross-section is ~194 scene-m wide, and one
 *   straight chord between its two edges rides above every dip in between,
 *   swallowing the tracks that follow the ground down (worst case ~4.7
 *   scene-m, near Mumbai Central).
 * - Along: the tracks densify to 20 m inside each turnout window (see
 *   track-geometry), so the bed samples the same stations rather than the
 *   sparser ~77 m native centreline vertices.
 */
const BALLAST_COLUMNS = 8

function ballastGeometry(network: NetworkData, track: TrainTrack, heightfield: Heightfield) {
  const { scale } = track
  const stations = corridorSampleStations(network, track)
  const positions: number[] = []
  const indices: number[] = []
  const perRow = BALLAST_COLUMNS + 1
  for (let i = 0; i < stations.length; i++) {
    const chainageM = stations[i] / scale
    const pose = poseAt(track, chainageM)
    // Same normal convention as platformGeometry below: +lateral is the
    // side a +offset platform sits on.
    const nx = -Math.cos(pose.angleRad)
    const nz = Math.sin(pose.angleRad)
    const section = sectionAtChainage(network.sections, chainageM)
    const half = (section.tracks * TRACK_SPACING_SCENE_M) / 2 + BALLAST_MARGIN_M
    for (let c = 0; c <= BALLAST_COLUMNS; c++) {
      const lateral = -half + (2 * half * c) / BALLAST_COLUMNS
      const px = pose.x + nx * lateral
      const pz = pose.z + nz * lateral
      positions.push(px, heightfield.railY(px, pz) - 0.8, pz)
    }
    if (i > 0) {
      // Wound counter-clockwise seen from above (+y) so the bed isn't culled.
      const a = (i - 1) * perRow
      const b = i * perRow
      for (let c = 0; c < BALLAST_COLUMNS; c++) {
        indices.push(a + c + 1, b + c + 1, a + c, a + c, b + c + 1, b + c)
      }
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
  night,
  onSelectStation,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  /** 0 = full day, 1 = full night; dims the unlit station boards. */
  night: number
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

  /**
   * Name boards standing along each platform face, looking across the track —
   * which is where a real WR board is and which way it points, so it can be
   * read from a train. Laid out off the same poses as the platform itself.
   */
  const platformBoards = useMemo(
    () =>
      stations.flatMap((station) => {
        const out: {
          key: string
          station: StationPose
          position: [number, number, number]
          yaw: number
        }[] = []
        for (const side of [1, -1] as const) {
          const centerOffset =
            ((station.tracks * TRACK_SPACING_SCENE_M) / 2 + PLATFORM_W / 2 + 6) * side
          // Set in from the platform's track-side edge, clear of the coaches.
          const offset = centerOffset - side * (PLATFORM_W / 2 - 5)
          for (let k = 0; k < PLATFORM_BOARDS; k++) {
            // One toward each end of the platform, each turned to face the
            // end it is nearest, so a train arriving from either direction
            // meets a board square on rather than edge on.
            const facesUp = k === 0
            const along = (facesUp ? -1 : 1) * (PLATFORM_L / 2 - PLATFORM_BOARD_INSET_M)
            const pose = poseAt(track, station.chainageM, along)
            const nx = -Math.cos(pose.angleRad)
            const nz = Math.sin(pose.angleRad)
            const x = pose.x + nx * offset
            const z = pose.z + nz * offset
            out.push({
              key: `${station.id}-${side}-${k}`,
              station,
              position: [x, heightfield.railY(x, z) + PLATFORM_H + PLATFORM_BOARD_POST_H, z],
              // poseAt's angle looks up the chainage; the board's own face is
              // turned along the rails, one board each way.
              yaw: pose.angleRad + (facesUp ? Math.PI : 0),
            })
          }
        }
        return out
      }),
    [stations, track, heightfield],
  )

  // Hand the boards over to Corridor's floating labels as the camera pulls
  // back (see BOARD_FADE_NEAR/FAR).
  const boardRefs = useRef<(Group | null)[]>([])
  const platformBoardsRef = useRef<Group>(null)
  const boardPoints = useMemo(
    () => stations.map((s) => new Vector3(s.x, s.y + BOARD_Y, s.z)),
    [stations],
  )
  useFrame(({ camera }) => {
    for (let i = 0; i < boardPoints.length; i++) {
      const board = boardRefs.current[i]
      if (!board) continue
      const dist = camera.position.distanceTo(boardPoints[i])
      const far = (BOARD_FADE_FAR - dist) / (BOARD_FADE_FAR - BOARD_FADE_NEAR)
      const near = (dist - BOARD_HANDOVER_NEAR) / (BOARD_HANDOVER_FAR - BOARD_HANDOVER_NEAR)
      board.scale.setScalar(Math.min(1, Math.max(0, far)) * Math.min(1, Math.max(0, near)))
    }
    // The platform boards are life-sized, so they are worth drawing only from
    // close in; past that they are sub-pixel and cost a text mesh apiece.
    const group = platformBoardsRef.current
    if (group) {
      group.visible =
        camera.position.distanceTo(group.position) < PLATFORM_BOARD_VISIBLE_M ||
        boardPoints.some((p) => camera.position.distanceTo(p) < PLATFORM_BOARD_VISIBLE_M)
    }
  })

  // Every stabling road's vertices, to keep the scatter off them (see
  // YARD_CLEAR_M). Flat array so the per-candidate test is a plain scan.
  const yardRoadPoints = useMemo(() => {
    const out: [number, number][] = []
    for (const roads of buildYardRoadTracks(network, projection, track).values()) {
      for (const road of roads) out.push(...road.points)
    }
    return out
  }, [network, projection, track])

  // Sparse procedural blocks around each station, off the rail corridor.
  const buildingInstances = useMemo(() => {
    const matrices: Matrix4[] = []
    const colors: Color[] = []
    const windows: Matrix4[] = []
    const lamps: Matrix4[] = []
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    stations.forEach((s, si) => {
      const rand = mulberry32(si * 7919 + 17)
      const nx = -Math.cos(s.angleRad)
      const nz = Math.sin(s.angleRad)
      const fx = Math.sin(s.angleRad)
      const fz = Math.cos(s.angleRad)
      const corridorHalf = (s.tracks * TRACK_SPACING_SCENE_M) / 2 + PLATFORM_W + 40
      for (let i = 0; i < LAMPS_PER_STATION; i++) {
        const side = rand() > 0.5 ? 1 : -1
        const lateral = corridorHalf + rand() * 900
        const along = (rand() - 0.5) * 2000
        const lx = s.x + nx * lateral * side + fx * along
        const lz = s.z + nz * lateral * side + fz * along
        const lground = heightfield.sceneY(lx, lz)
        if (lground < 2) continue
        lamps.push(
          new Matrix4().compose(
            new Vector3(lx, lground + LAMP_HEIGHT, lz),
            new Quaternion(),
            new Vector3(1, 1, 1),
          ),
        )
      }
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
        const clear = Math.hypot(w, d) / 2 + YARD_CLEAR_M
        if (yardRoadPoints.some((p) => Math.hypot(p[0] - x, p[1] - z) < clear)) continue
        q.setFromAxisAngle(up, s.angleRad + (rand() - 0.5) * 0.4)
        matrices.push(
          new Matrix4().compose(new Vector3(x, ground + h / 2, z), q.clone(), new Vector3(w, h, d)),
        )
        const shade = 0.55 + rand() * 0.25
        colors.push(new Color(shade, shade * 0.98, shade * 0.94))
        if (rand() > LIT_BUILDING_SHARE) continue
        const lit = 1 + Math.floor(rand() * WINDOWS_PER_BUILDING)
        for (let k = 0; k < lit; k++) {
          // One facade each, inset a hair so the quad never z-fights the wall.
          const face = Math.floor(rand() * 4)
          const u = (rand() - 0.5) * 0.7
          const wy = ground + h * (0.15 + rand() * 0.7)
          const half = { x: w / 2, z: d / 2 }
          const local: [number, number] =
            face === 0
              ? [u * w, half.z]
              : face === 1
                ? [u * w, -half.z]
                : face === 2
                  ? [half.x, u * d]
                  : [-half.x, u * d]
          const yaw = s.angleRad + (face < 2 ? 0 : Math.PI / 2)
          const cos = Math.cos(s.angleRad)
          const sin = Math.sin(s.angleRad)
          const wx = x + local[0] * cos + local[1] * sin
          const wz = z - local[0] * sin + local[1] * cos
          q.setFromAxisAngle(up, yaw)
          windows.push(
            new Matrix4().compose(
              new Vector3(wx, wy, wz),
              q.clone(),
              new Vector3(WINDOW_W, WINDOW_H, WINDOW_W),
            ),
          )
        }
      }
    })
    return { matrices, colors, windows, lamps }
  }, [stations, heightfield, yardRoadPoints])

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
      <instancedMesh
        visible={night > 0.03}
        args={[undefined, undefined, Math.max(1, buildingInstances.lamps.length)]}
        ref={applyMatrices(buildingInstances.lamps)}
        frustumCulled={false}
      >
        <sphereGeometry args={[LAMP_RADIUS, 6, 4]} />
        <meshStandardMaterial
          color="#0a0805"
          emissive={LAMP_COLOR}
          emissiveIntensity={night * 2.6}
          toneMapped={false}
        />
      </instancedMesh>
      {/* Drawn only after dark: by day these would be a speckle of grey dots
          on every facade, and unlike the rakes' window strips they have no
          daytime reading of their own. */}
      <instancedMesh
        visible={night > 0.03}
        args={[undefined, undefined, Math.max(1, buildingInstances.windows.length)]}
        ref={applyMatrices(buildingInstances.windows)}
        frustumCulled={false}
      >
        <planeGeometry args={[1, 1]} />
        {/* Unlit by tone mapping so the glow stays hot against a dark city
            and reads as a light source rather than a pale grey patch. */}
        <meshStandardMaterial
          color="#120d06"
          emissive={WINDOW_COLOR}
          emissiveIntensity={night * 2.2}
          toneMapped={false}
          side={DoubleSide}
        />
      </instancedMesh>
      <group ref={platformBoardsRef}>
        {platformBoards.map(({ key, station, position, yaw }) => (
          <group
            key={key}
            position={position}
            rotation={[0, yaw, 0]}
            scale={PLATFORM_BOARD_SCALE}
            onClick={(e) => {
              e.stopPropagation()
              onSelectStation(station.id)
            }}
          >
            <WRBoard name={station.name} nameMr={station.nameMr} night={night} />
            {/* Post, in the board's own scaled space. */}
            <mesh position={[0, -PLATFORM_BOARD_POST_H / PLATFORM_BOARD_SCALE / 2 - 28, 0]}>
              <boxGeometry
                args={[6, PLATFORM_BOARD_POST_H / PLATFORM_BOARD_SCALE, 6]}
              />
              <meshStandardMaterial color="#6b6f72" roughness={0.8} />
            </mesh>
          </group>
        ))}
      </group>
      {stations.map((s, i) => (
        <Billboard
          key={s.id}
          ref={(g: Group | null) => {
            boardRefs.current[i] = g
          }}
          position={[s.x, s.y + BOARD_Y, s.z]}
          onClick={(e) => {
            e.stopPropagation()
            onSelectStation(s.id)
          }}
        >
          <WRBoard name={s.name} nameMr={s.nameMr} night={night} />
        </Billboard>
      ))}
    </group>
  )
}
