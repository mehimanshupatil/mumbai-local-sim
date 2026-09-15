/**
 * One owner of "which Station name boards are visible this frame".
 *
 * A Station's name is drawn two ways: a board standing at the Station for
 * close views, and a larger board floating above it for corridor views. They
 * live in different components (StationDressing and Corridor) because they
 * belong to different scenery, but they are two renderings of one thing — and
 * while each decluttered its own population, a floating label could sit across
 * a *different* Station's close-up board with neither system able to see the
 * collision (#26).
 *
 * So neither decides any more. Both register here, and one pass per frame
 * picks a single representation per Station and then resolves overlaps across
 * every board on screen, whichever component drew it.
 */
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera, Group, PerspectiveCamera } from 'three'
import { Vector3 } from 'three'
import { BOARD_HEIGHT, BOARD_WIDTH } from './WRBoard'

export type LabelKind = 'board' | 'float'

interface Entry {
  group: Group | null
  /** Where the board hangs, in world space. */
  point: Vector3
  /** Scale at which this representation is drawn when it is chosen. */
  scale: number
  /** Minor Stations yield first when the far corridor gets crowded. */
  fastHalt: boolean
}

const entries = new Map<string, Partial<Record<LabelKind, Entry>>>()

/** Register (or clear) one representation of one Station's name board. */
export function registerLabel(
  stationId: string,
  kind: LabelKind,
  entry: { group: Group | null; point: Vector3; scale: number; fastHalt: boolean },
): void {
  const forStation = entries.get(stationId) ?? {}
  forStation[kind] = entry
  entries.set(stationId, forStation)
}

export function unregisterLabel(stationId: string, kind: LabelKind): void {
  const forStation = entries.get(stationId)
  if (!forStation) return
  delete forStation[kind]
  if (Object.keys(forStation).length === 0) entries.delete(stationId)
}

/**
 * Where a Station stops showing the board that stands at it and starts showing
 * the one floating above the corridor. A hard switch rather than a cross-fade:
 * fading one out as the other comes in means both populations exist at once
 * somewhere in any corridor view, which is the state that made #26
 * unresolvable no matter how the bands were tuned.
 */
const HANDOVER_M = 6000

/**
 * Below this the floating board is dropped entirely — the boards standing on
 * the platform have taken over, and a signboard several storeys tall hanging
 * over the station roof is not what a station looks like.
 */
const CLOSE_DROP_M = 700
const CLOSE_FADE_M = 1700

/** Past here a minor Station's name is not worth the pixels; interchanges stay. */
const MINOR_FADE_NEAR_M = 35000
const MINOR_FADE_FAR_M = 45000

/** Boards may touch this closely, as a fraction of their own size, before one yields. */
const CROWDING = 0.9

interface Candidate {
  group: Group
  kind: LabelKind
  dist: number
  scale: number
  x: number
  y: number
  halfW: number
  halfH: number
}

const ndc = new Vector3()

/**
 * Size and hide every Station name board for this frame. Called once, from
 * StationLabels, with nothing else touching these scales.
 */
export function arbitrateLabels(camera: Camera, aspect: number): void {
  const fov = ((camera as PerspectiveCamera).fov ?? 45) * (Math.PI / 180)
  const tanHalfFov = Math.tan(fov / 2)
  const candidates: Candidate[] = []

  for (const forStation of entries.values()) {
    // Distance is measured once per Station, not once per representation, so
    // the two can never disagree about which side of the handover they are on.
    const any = forStation.board ?? forStation.float
    if (!any) continue
    const dist = camera.position.distanceTo(any.point)
    const wanted: LabelKind = dist < HANDOVER_M ? 'board' : 'float'

    for (const kind of ['board', 'float'] as LabelKind[]) {
      const entry = forStation[kind]
      if (!entry?.group) continue
      if (kind !== wanted) {
        entry.group.scale.setScalar(0)
        continue
      }
      let scale = entry.scale
      if (kind === 'board') {
        // Fade out as the platform's own boards become readable.
        scale *= clamp01((dist - CLOSE_DROP_M) / (CLOSE_FADE_M - CLOSE_DROP_M))
      } else if (!entry.fastHalt) {
        scale *= clamp01((MINOR_FADE_FAR_M - dist) / (MINOR_FADE_FAR_M - MINOR_FADE_NEAR_M))
      }
      if (scale <= 0) {
        entry.group.scale.setScalar(0)
        continue
      }
      ndc.copy(entry.point).project(camera)
      if (ndc.z > 1) {
        entry.group.scale.setScalar(0)
        continue
      }
      // Apparent size from real size and distance, so a small board close up
      // and a large one far away compete on what they actually cover — the
      // fixed screen-space radius the old pass used only described one of the
      // two populations.
      const halfH = (BOARD_HEIGHT * scale) / 2 / (dist * tanHalfFov)
      const halfW = (BOARD_WIDTH * scale) / 2 / (dist * tanHalfFov * aspect)
      candidates.push({ group: entry.group, kind, dist, scale, x: ndc.x, y: ndc.y, halfW, halfH })
    }
  }

  // Nearest wins: what is in front of the viewer keeps its name, and what is
  // behind it yields.
  candidates.sort((a, b) => a.dist - b.dist)
  const kept: Candidate[] = []
  for (const c of candidates) {
    let crowded = false
    for (const k of kept) {
      if (
        Math.abs(c.x - k.x) < (c.halfW + k.halfW) * CROWDING &&
        Math.abs(c.y - k.y) < (c.halfH + k.halfH) * CROWDING
      ) {
        crowded = true
        break
      }
    }
    if (crowded) {
      c.group.scale.setScalar(0)
    } else {
      c.group.scale.setScalar(c.scale)
      kept.push(c)
    }
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/**
 * Every board currently showing, with the screen box it covers — the whole
 * point of #26 is a claim about overlap, and three plausible fixes were
 * falsified only by looking. This lets the claim be checked by arithmetic
 * instead: window.labelBoxes() in DEV, then intersect the boxes.
 */
export function labelBoxes(camera: Camera, aspect: number) {
  const fov = ((camera as PerspectiveCamera).fov ?? 45) * (Math.PI / 180)
  const tanHalfFov = Math.tan(fov / 2)
  const out: {
    stationId: string
    kind: LabelKind
    dist: number
    x: number
    y: number
    halfW: number
    halfH: number
  }[] = []
  for (const [stationId, forStation] of entries) {
    for (const kind of ['board', 'float'] as LabelKind[]) {
      const entry = forStation[kind]
      const scale = entry?.group?.scale.x ?? 0
      if (!entry?.group || scale <= 0) continue
      const dist = camera.position.distanceTo(entry.point)
      ndc.copy(entry.point).project(camera)
      out.push({
        stationId,
        kind,
        dist: Math.round(dist),
        x: ndc.x,
        y: ndc.y,
        halfW: (BOARD_WIDTH * scale) / 2 / (dist * tanHalfFov * aspect),
        halfH: (BOARD_HEIGHT * scale) / 2 / (dist * tanHalfFov),
      })
    }
  }
  return out
}

/**
 * Mount once inside the Canvas, after the components that register labels.
 * This is the only thing that writes a Station label's scale.
 */
declare global {
  interface Window {
    labelBoxes?: () => ReturnType<typeof labelBoxes>
  }
}

export function StationLabels() {
  const size = useThree((state) => state.size)
  const camera = useThree((state) => state.camera)
  useFrame(() => {
    arbitrateLabels(camera, size.width / Math.max(1, size.height))
  })
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.labelBoxes = () => labelBoxes(camera, size.width / Math.max(1, size.height))
    return () => {
      delete window.labelBoxes
    }
  }, [camera, size])
  return null
}
