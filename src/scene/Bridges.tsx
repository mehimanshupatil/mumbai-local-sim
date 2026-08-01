import { useMemo } from 'react'
import type { NetworkData } from '../data/network-types'
import { trackRibbonGeometry } from './Corridor'
import { TRACK_SPACING_SCENE_M } from './config'
import type { Heightfield } from './heightfield'
import type { Projection } from './projection'
import { buildTrainTrack, poseAt, sectionAtChainage } from './track-geometry'

/**
 * Real water crossings on this corridor (ticket #19), as baked chainage
 * spans. The rail alignment already rides a constant embanked height above
 * whatever's beneath it (`railY` — unchanged by this file, see its own
 * comment), so these spans exist only to know where to draw a bridge
 * silhouette (piers reaching down to the real ground/water, a deck slab
 * filling the gap up to that unchanged rail height) instead of the implicit,
 * structureless embankment fill everywhere else.
 *
 * Chainage ranges found 2026-08-01 by sampling the baked terrain heightfield
 * (public/terrain/heights.bin) directly along the corridor: walking outward
 * from each crossing's local-minimum elevation point while height stays
 * within ~1-2m of that minimum. Mahim's and Vasai's minima dip to sea level
 * or below and taper cleanly; Vaitarna's surrounding area is a much broader,
 * gently-undulating salt marsh with no sharp minimum; its span is the
 * ~1km band of that marsh closest to the ticket's independently-verified
 * -1.4m reference point (72.824°E, 19.495°N — 525m off the corridor's own
 * path, since the deepest channel isn't necessarily right under the rail
 * alignment).
 */
const CROSSINGS = [
  { id: 'mahim', name: 'Mahim bay', fromM: 13470, toM: 13740 },
  { id: 'vasai', name: 'Vasai creek', fromM: 43934, toM: 45364 },
  { id: 'vaitarna', name: 'Vaitarna creek', fromM: 63800, toM: 64800 },
]

/**
 * Deck girder slab thickness, hung just beneath the (unchanged) rail height.
 * These are shallow tidal crossings, not deep water — real clearance between
 * the embanked rail height and the ground/water below is often only the
 * ~5 scene-m embankment itself (see heightfield.ts's EMBANKMENT_M), so this
 * has to stay well under that or the girder ends up planted in the ground
 * with no visible pier at all.
 */
const GIRDER_THICKNESS_M = 3
/** Piers always render at least this tall, even where the real clearance
 * above the ground/water is thin, so a shallow crossing still reads as a
 * bridge instead of a sliver fused into the terrain. */
const MIN_PIER_HEIGHT_M = 1.5
/** Extra width either side of the running tracks, like a real deck overhang. */
const DECK_MARGIN_M = 2 * TRACK_SPACING_SCENE_M
/** Along-track sampling for the deck ribbon — dense enough to follow the curve. */
const DECK_SAMPLE_STEP_M = 20
/** Along-track spacing between pier bents. */
const PIER_SPACING_M = 150
const PIER_THICKNESS_M = 14
const DECK_COLOR = '#8a8f92'
const PIER_COLOR = '#6b7075'

export function Bridges({
  network,
  projection,
  heightfield,
}: {
  network: NetworkData
  projection: Projection
  heightfield: Heightfield
}) {
  const centerTrack = useMemo(() => buildTrainTrack(network, projection, 0), [network, projection])

  const decks = useMemo(
    () =>
      CROSSINGS.map((c) => {
        const midChainageM = (c.fromM + c.toM) / 2
        const section = sectionAtChainage(network.sections, midChainageM)
        const deckWidth = section.tracks * TRACK_SPACING_SCENE_M + DECK_MARGIN_M
        const points: [number, number, number][] = []
        for (let m = c.fromM; m < c.toM; m += DECK_SAMPLE_STEP_M) {
          const pose = poseAt(centerTrack, m)
          points.push([pose.x, heightfield.railY(pose.x, pose.z) - GIRDER_THICKNESS_M, pose.z])
        }
        const lastPose = poseAt(centerTrack, c.toM)
        points.push([lastPose.x, heightfield.railY(lastPose.x, lastPose.z) - GIRDER_THICKNESS_M, lastPose.z])
        return { id: c.id, geo: trackRibbonGeometry(points, deckWidth) }
      }),
    [network, centerTrack, heightfield],
  )

  const piers = useMemo(
    () =>
      CROSSINGS.flatMap((c) => {
        const midChainageM = (c.fromM + c.toM) / 2
        const section = sectionAtChainage(network.sections, midChainageM)
        const deckWidth = section.tracks * TRACK_SPACING_SCENE_M + DECK_MARGIN_M
        const bents: { x: number; z: number; angleRad: number; top: number; height: number }[] = []
        for (let m = c.fromM; m <= c.toM; m += PIER_SPACING_M) {
          const pose = poseAt(centerTrack, m)
          const top = heightfield.railY(pose.x, pose.z) - GIRDER_THICKNESS_M
          const ground = heightfield.sceneY(pose.x, pose.z)
          const height = Math.max(MIN_PIER_HEIGHT_M, top - ground)
          bents.push({ x: pose.x, z: pose.z, angleRad: pose.angleRad, top, height })
        }
        return bents.map((b, i) => ({ id: `${c.id}-${i}`, bent: b, deckWidth }))
      }),
    [network, centerTrack, heightfield],
  )

  return (
    <group>
      {decks.map(({ id, geo }) => (
        <mesh key={id} geometry={geo}>
          <meshStandardMaterial color={DECK_COLOR} roughness={0.85} />
        </mesh>
      ))}
      {piers.map(({ id, bent, deckWidth }) => (
        <mesh
          key={id}
          position={[bent.x, bent.top - bent.height / 2, bent.z]}
          rotation={[0, bent.angleRad, 0]}
        >
          <boxGeometry args={[deckWidth * 0.7, bent.height, PIER_THICKNESS_M]} />
          <meshStandardMaterial color={PIER_COLOR} roughness={0.9} />
        </mesh>
      ))}
    </group>
  )
}
