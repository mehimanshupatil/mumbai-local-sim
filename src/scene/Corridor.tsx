import { useMemo, useRef } from 'react'
import { Billboard } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, type Group } from 'three'
import type { NetworkData } from '../data/network-types'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrackPolylines, terminusFanStub } from './track-geometry'
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
  const tracks = useMemo(() => {
    const polylines = buildTrackPolylines(network, projection, TRACK_SPACING_SCENE_M)
    // Churchgate's tracks are always the first `tracks`-many polylines here,
    // since buildTrackPolylines walks sections in order starting at chainage 0.
    const churchgateTracks = network.sections[0].tracks
    const fan = terminusFanStub(network, projection, TRACK_SPACING_SCENE_M, churchgateTracks)
    return polylines.map((t, i) => {
      const stub = i < churchgateTracks ? fan[i] : []
      return [...stub, ...t.points].map(
        ([x, z]) => [x, heightfield.railY(x, z) + TRACK_LIFT, z] as [number, number, number],
      )
    })
  }, [network, projection, heightfield])
  const trackGeometries = useMemo(() => tracks.map((t) => trackRibbonGeometry(t)), [tracks])
  const trackTexture = useMemo(() => createTrackTexture(), [])
  return (
    <group>
      {trackGeometries.map((geo, i) => (
        <mesh key={i} geometry={geo}>
          <meshStandardMaterial map={trackTexture} roughness={0.95} />
        </mesh>
      ))}
      {network.stations.map((s) => {
        const [x, z] = projection.toScene([s.lon, s.lat])
        return (
          <StationMarker
            key={s.id}
            name={s.name}
            nameMr={s.nameMr}
            fastHalt={s.fastHalt}
            position={[x, heightfield.railY(x, z), z]}
            night={night}
            onSelect={() => onSelectStation(s.id)}
          />
        )
      })}
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
}: {
  name: string
  nameMr: string
  fastHalt: boolean
  position: [number, number, number]
  night: number
  onSelect: () => void
}) {
  const color = fastHalt ? FAST_HALT_COLOR : STATION_COLOR
  const ref = useRef<Group>(null)
  const labelRef = useRef<Group>(null)
  useFrame(({ camera }) => {
    // Markers are sized for corridor-level views; shrink them as the camera
    // closes in (they stay as the station's click target, so never to zero).
    const g = ref.current
    if (!g) return
    const dist = camera.position.distanceTo(g.position)
    g.scale.setScalar(Math.min(1, Math.max(0.06, dist / 12000)))
    // Close up the yellow board takes over from the floating label; far out,
    // minor-station labels yield so the dense south corridor doesn't smear.
    const label = labelRef.current
    if (label) {
      const near = Math.min(1, Math.max(0, (dist - 4000) / 8000))
      const far = fastHalt ? 1 : Math.min(1, Math.max(0, (45000 - dist) / 10000))
      label.scale.setScalar(near * far * LABEL_SCALE)
    }
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
      <Billboard ref={labelRef} position={[0, 520, 0]}>
        <WRBoard name={name} nameMr={nameMr} />
      </Billboard>
    </group>
  )
}
