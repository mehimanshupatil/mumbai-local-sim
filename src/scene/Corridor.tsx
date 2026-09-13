import { useCallback, useMemo, useRef } from 'react'
import { Billboard } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Vector3, type Group } from 'three'
import { BufferStop } from './BufferStop'
import type { NetworkData } from '../data/network-types'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrackPolylines, terminusStub } from './track-geometry'
import { createTrackTexture } from './track-texture'
import { WRBoard } from './WRBoard'

/** Track ribbons float just above the rail formation to avoid z-fighting. */
const TRACK_LIFT = 0.6
/** A single track's visible width — real broad-gauge sleepers are ~2.6 m,
 * scaled by RENDER_EXAGGERATION (5x, see config.ts) to ~13 m. */
const TRACK_WIDTH_SCENE_M = 13
/**
 * Length of track covered by one texture tile (4 sleepers, see
 * track-texture.ts). True-to-scale sleeper spacing (~3 scene-m) would be a
 * few px on screen even at the station-focus camera distance (~2.3 km, see
 * CameraRig's STATION_UP_M/STATION_SOUTH_M) and mip down to a blur — sized
 * instead so each sleeper band is legible at that reference distance,
 * matching this project's render-vs-true-scale tradeoff elsewhere (see
 * config.ts's RENDER_EXAGGERATION comment).
 */
const TRACK_TILE_LENGTH_SCENE_M = 60
const STATION_COLOR = '#7b1fa2'
const FAST_HALT_COLOR = '#e0a020'
/** WRBoard's own text is sized for close-up reading (see StationDressing);
 * scaled up so the floating corridor-level label stays legible from afar. */
const LABEL_SCALE = 9
/**
 * Minimum on-screen separation between two visible station labels, as a
 * fraction of viewport height. Looking along a 124 km corridor puts a dozen
 * stations within a few degrees of the horizon, so distance-based sizing
 * alone can't stop them stacking into one unreadable yellow block — the
 * nearest label in a cluster wins and the rest yield.
 */
const LABEL_MIN_SEPARATION_X = 0.17
const LABEL_MIN_SEPARATION_Y = 0.05
/** Height of the floating label above its station marker. */
const LABEL_Y = 520

/**
 * A single running track as a textured ribbon (ballast+sleeper+rail, see
 * track-texture.ts) instead of a flat-colored line — width in scene metres,
 * UV.v scaled by along-track distance so the texture tiles realistically
 * regardless of a track's total length.
 */
export function trackRibbonGeometry(
  points: [number, number, number][],
  widthScene: number = TRACK_WIDTH_SCENE_M,
): BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const half = widthScene / 2
  let dist = 0
  for (let i = 0; i < points.length; i++) {
    const [x, y, z] = points[i]
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dx = next[0] - prev[0]
    const dz = next[2] - prev[2]
    const len = Math.hypot(dx, dz) || 1
    const nx = -dz / len
    const nz = dx / len
    if (i > 0) {
      const [px, , pz] = points[i - 1]
      dist += Math.hypot(x - px, z - pz)
    }
    const v = dist / TRACK_TILE_LENGTH_SCENE_M
    positions.push(x + nx * half, y, z + nz * half, x - nx * half, y, z - nz * half)
    uvs.push(1, v, 0, v)
    if (i > 0) {
      const a = (i - 1) * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

export function Corridor({
  network,
  projection,
  heightfield,
  night,
  onSelectStation,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
  night: number
  onSelectStation: (stationId: string) => void
}) {
  const { tracks, buffers } = useMemo(() => {
    const polylines = buildTrackPolylines(network, projection, TRACK_SPACING_SCENE_M)
    // Churchgate's tracks are always the first `tracks`-many polylines here,
    // since buildTrackPolylines walks sections in order starting at chainage 0.
    const churchgateTracks = network.sections[0].tracks
    const stubs = terminusStub(network, projection, TRACK_SPACING_SCENE_M, churchgateTracks)
    return {
      tracks: polylines.map((t, i) => {
        const stub = i < churchgateTracks ? stubs[i].points : []
        return [...stub, ...t.points].map(
          ([x, z]) => [x, heightfield.railY(x, z) + TRACK_LIFT, z] as [number, number, number],
        )
      }),
      buffers: stubs.map(({ buffer: [x, z], angleRad }) => ({
        position: [x, heightfield.railY(x, z), z] as [number, number, number],
        angleRad,
      })),
    }
  }, [network, projection, heightfield])
  const trackGeometries = useMemo(() => tracks.map((t) => trackRibbonGeometry(t)), [tracks])
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const trackTexture = useMemo(
    () => createTrackTexture(gl.capabilities.getMaxAnisotropy()),
    [gl],
  )

  const stationPoints = useMemo(
    () =>
      network.stations.map((s) => {
        const [x, z] = projection.toScene([s.lon, s.lat])
        return { x, y: heightfield.railY(x, z), z, fastHalt: s.fastHalt }
      }),
    [network, projection, heightfield],
  )
  /** World position of each label, for the declutter pass (see LABEL_Y). */
  const labelPoints = useMemo(
    () => stationPoints.map((p) => new Vector3(p.x, p.y + LABEL_Y, p.z)),
    [stationPoints],
  )
  const labelRefs = useRef<(Group | null)[]>([])
  const registerLabel = useCallback((i: number, g: Group | null) => {
    labelRefs.current[i] = g
  }, [])

  const ndc = useMemo(() => new Vector3(), [])
  const visible = useRef<{ x: number; y: number }[]>([])
  useFrame(({ camera }) => {
    const aspect = size.width / Math.max(1, size.height)
    // Size each label by distance first, then let the nearest of any
    // overlapping cluster win — sizing alone can't declutter a corridor seen
    // end-on, where a dozen stations project into the same few degrees.
    const candidates: { i: number; dist: number; x: number; y: number; scale: number }[] = []
    for (let i = 0; i < labelPoints.length; i++) {
      const label = labelRefs.current[i]
      if (!label) continue
      const p = labelPoints[i]
      const dist = camera.position.distanceTo(p)
      // Close up the yellow board takes over from the floating label; far out,
      // minor-station labels yield so the dense south corridor doesn't smear.
      const near = Math.min(1, Math.max(0, (dist - 4000) / 8000))
      const far = stationPoints[i].fastHalt
        ? 1
        : Math.min(1, Math.max(0, (45000 - dist) / 10000))
      const scale = near * far * LABEL_SCALE
      if (scale <= 0) {
        label.scale.setScalar(0)
        continue
      }
      ndc.copy(p).project(camera)
      if (ndc.z > 1) {
        label.scale.setScalar(0)
        continue
      }
      candidates.push({ i, dist, x: ndc.x, y: ndc.y, scale })
    }
    candidates.sort((a, b) => a.dist - b.dist)
    const kept = visible.current
    kept.length = 0
    for (const c of candidates) {
      const label = labelRefs.current[c.i]
      if (!label) continue
      let crowded = false
      for (const k of kept) {
        // NDC spans -1..1 on both axes; convert to fractions of viewport
        // height so the threshold means the same thing at any aspect ratio.
        // The test is elliptical, not circular: a board is ~3.75x wider than
        // it is tall, so a circle sized to clear them vertically still lets
        // two side-by-side boards overlap.
        const dx = ((c.x - k.x) * aspect) / 2 / LABEL_MIN_SEPARATION_X
        const dy = (c.y - k.y) / 2 / LABEL_MIN_SEPARATION_Y
        if (Math.hypot(dx, dy) < 1) {
          crowded = true
          break
        }
      }
      if (crowded) {
        label.scale.setScalar(0)
      } else {
        label.scale.setScalar(c.scale)
        kept.push({ x: c.x, y: c.y })
      }
    }
  })

  return (
    <group>
      {trackGeometries.map((geo, i) => (
        <mesh key={i} geometry={geo}>
          <meshStandardMaterial map={trackTexture} roughness={0.95} />
        </mesh>
      ))}
      {/* One buffer stop per platform road, square across the rails — what a
          terminus ends in, and what tells the eye the line stops here. */}
      {buffers.map(({ position, angleRad }, i) => (
        <BufferStop key={`buffer-${i}`} position={position} angleRad={angleRad} />
      ))}
      {network.stations.map((s, i) => (
        <StationMarker
          key={s.id}
          name={s.name}
          nameMr={s.nameMr}
          fastHalt={s.fastHalt}
          position={[stationPoints[i].x, stationPoints[i].y, stationPoints[i].z]}
          night={night}
          onSelect={() => onSelectStation(s.id)}
          labelRef={(g) => registerLabel(i, g)}
        />
      ))}
    </group>
  )
}

function StationMarker({
  name,
  nameMr,
  fastHalt,
  position: [x, y, z],
  night,
  onSelect,
  labelRef,
}: {
  name: string
  nameMr: string
  fastHalt: boolean
  position: [number, number, number]
  night: number
  onSelect: () => void
  /** Corridor sizes and declutters labels across all stations at once. */
  labelRef: (g: Group | null) => void
}) {
  const color = fastHalt ? FAST_HALT_COLOR : STATION_COLOR
  const ref = useRef<Group>(null)
  useFrame(({ camera }) => {
    // Markers are sized for corridor-level views; shrink them as the camera
    // closes in (they stay as the station's click target, so never to zero).
    const g = ref.current
    if (!g) return
    const dist = camera.position.distanceTo(g.position)
    g.scale.setScalar(Math.min(1, Math.max(0.06, dist / 12000)))
  })
  return (
    <group
      ref={ref}
      position={[x, y, z]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      <mesh position={[0, 150, 0]}>
        <cylinderGeometry args={[18, 18, 300]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* the marker head doubles as the platform lamp after dark */}
      <mesh position={[0, 330, 0]}>
        <sphereGeometry args={[55]} />
        <meshStandardMaterial color={color} emissive="#ffe9b0" emissiveIntensity={night * 1.6} />
      </mesh>
      <Billboard ref={labelRef} position={[0, LABEL_Y, 0]}>
        <WRBoard name={name} nameMr={nameMr} night={night} />
      </Billboard>
    </group>
  )
}
