import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Billboard } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Vector3, type Group } from 'three'
import { BufferStop } from './BufferStop'
import type { NetworkData } from '../data/network-types'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrackPolylines, terminusStub } from './track-geometry'
import { registerLabel, unregisterLabel } from './station-labels'
import { createTrackTexture } from './track-texture'
import { WRBoard } from './WRBoard'

/** Track ribbons float just above the rail formation to avoid z-fighting. */
const TRACK_LIFT = 0.6
/** A single track's visible width — real broad-gauge sleepers are ~2.6 m,
 * scaled by RENDER_EXAGGERATION (5x, see config.ts) to ~13 m. */
export const TRACK_WIDTH_SCENE_M = 13
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
  const registerFloat = useCallback(
    (i: number, g: Group | null) => {
      registerLabel(network.stations[i].id, 'float', {
        group: g,
        point: labelPoints[i],
        scale: LABEL_SCALE,
        fastHalt: stationPoints[i].fastHalt,
      })
    },
    [network, labelPoints, stationPoints],
  )

  // Visibility is not decided here. Both this floating label and
  // StationDressing's close-up board are registered with station-labels.ts,
  // which picks one representation per Station and resolves overlaps across
  // every board on screen — neither component can see the other's, which is
  // how a floating label came to sit across a different Station's board (#26).
  useEffect(() => {
    const ids = network.stations.map((s) => s.id)
    return () => {
      for (const id of ids) unregisterLabel(id, 'float')
    }
  }, [network])

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
          labelRef={(g) => registerFloat(i, g)}
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
  /** station-labels.ts owns whether and how large this label draws. */
  labelRef: (g: Group | null) => void
}) {
  const color = fastHalt ? FAST_HALT_COLOR : STATION_COLOR
  const ref = useRef<Group>(null)
  useFrame(({ camera }) => {
    // Markers are sized for corridor-level views; shrink them as the camera
    // closes in (they stay as the station's click target, so never to zero).
    const g = ref.current
    if (!g) return
    const dist = camera.position.distanceTo(g.parent?.position ?? g.position)
    g.scale.setScalar(Math.min(1, Math.max(0.06, dist / 12000)))
  })
  return (
    <group
      position={[x, y, z]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      {/* Only the marker scales with distance. The label hangs outside it, so
          its size is the arbiter's alone rather than the product of two
          independent rules. */}
      <group ref={ref}>
        <mesh position={[0, 150, 0]}>
          <cylinderGeometry args={[18, 18, 300]} />
          <meshStandardMaterial color={color} />
        </mesh>
        {/* the marker head doubles as the platform lamp after dark */}
        <mesh position={[0, 330, 0]}>
          <sphereGeometry args={[55]} />
          <meshStandardMaterial color={color} emissive="#ffe9b0" emissiveIntensity={night * 1.6} />
        </mesh>
      </group>
      <Billboard ref={labelRef} position={[0, LABEL_Y, 0]}>
        <WRBoard name={name} nameMr={nameMr} night={night} />
      </Billboard>
    </group>
  )
}
