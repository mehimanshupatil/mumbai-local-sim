/**
 * Riders: the people standing in a Rake's open doorways.
 *
 * The single most recognisable thing about a Mumbai local, and the other half
 * of the hole rake-visual cuts in the carbody — an open doorway with nobody in
 * it reads as a derelict train. Pure, like rake-visual: geometry and placement
 * only, no sim wiring and no per-frame work. Fleet instances what it is given.
 *
 * Stylised-real, same as the Rake: at the follow camera a Rider is a metre or
 * two of silhouette, so posture and stance carry it and nothing else would be
 * visible anyway.
 */
import { BufferAttribute, BufferGeometry, CapsuleGeometry, Color, SphereGeometry } from 'three'
import type { Direction } from '../sim/types'
import { crowding } from '../sim/crowding'
import type { SimTime } from '../sim/clock'
import { COACH_LENGTH_SCENE_M } from './config'
import { COACH, SIDE_HEIGHT_M } from './livery-atlas'
import { BODY_H, BODY_W } from './rake-visual'

/** A Rider's height in scene units — ~1.7 m against the body's real 3.9 m. */
const RIDER_H = (1.7 / SIDE_HEIGHT_M) * BODY_H
const RIDER_W = RIDER_H * 0.22

/** Floor height in body-local y, where a Rider stands. */
const FLOOR_Y = -BODY_H / 2 + (COACH.belowFloorM / SIDE_HEIGHT_M) * BODY_H

/** At most this many Riders to a doorway, at crush. */
export const MAX_PER_DOORWAY = 3

/**
 * One figure: a torso capsule with a head on it, merged so the whole fleet's
 * Riders are a single instanced draw. Facing is irrelevant at this distance —
 * a Rider is symmetric about its own axis, which is why a capsule does the job
 * a modelled body would not earn.
 */
export function buildRiderGeometry(): BufferGeometry {
  const torso = new CapsuleGeometry(RIDER_W / 2, RIDER_H * 0.62, 3, 6).toNonIndexed()
  const head = new SphereGeometry(RIDER_W * 0.42, 7, 5).toNonIndexed()
  head.translate(0, RIDER_H * 0.47, 0)
  return mergePositions([torso, head])
}

/** Concatenate geometries that carry the same attributes. */
function mergePositions(parts: BufferGeometry[]): BufferGeometry {
  const merged = new BufferGeometry()
  for (const name of ['position', 'normal'] as const) {
    const arrays = parts.map((p) => p.getAttribute(name).array as Float32Array)
    const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
    let at = 0
    for (const a of arrays) {
      out.set(a, at)
      at += a.length
    }
    merged.setAttribute(name, new BufferAttribute(out, 3))
  }
  return merged
}

/** Where one Rider stands, in coach-local coordinates (z along the body). */
export interface RiderSlot {
  x: number
  y: number
  z: number
  /** 0..1, for varying the figure's colour and lean. */
  variation: number
}

/** Deterministic hash of the things that decide a doorway's crowd. */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 2246822519)
  h = Math.imul(h ^ b, 3266489917)
  h = Math.imul(h ^ c, 668265263)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967295
}

/** Rake id → a stable number, so a Rake's crowd is its own every frame. */
export function rakeSeed(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) % 100000
}

/**
 * The Riders in one coach's doorways.
 *
 * Count is Crowding scaled, placement hashed off the Rake so the same coach of
 * the same service is filled the same way from frame to frame. Both sides of
 * the body are filled: at the follow camera you see the near side, and through
 * the near doorway you see the far one.
 */
export function riderSlots(seed: number, coach: number, load: number): RiderSlot[] {
  // Crowding moves over an hour, not over a frame, so the slots are cached
  // against a quantised load: without this, every near coach allocates a fresh
  // array of figures 60 times a second and the GC pays for it.
  const step = Math.round(load * LOAD_STEPS)
  const key = `${seed}:${coach}:${step}`
  const hit = slotCache.get(key)
  if (hit) return hit
  const slots = buildSlots(seed, coach, step / LOAD_STEPS)
  if (slotCache.size > SLOT_CACHE_MAX) slotCache.clear()
  slotCache.set(key, slots)
  return slots
}

/** Quantisation of the load, and how many coach-loads to keep before dropping. */
const LOAD_STEPS = 16
const SLOT_CACHE_MAX = 4096
const slotCache = new Map<string, RiderSlot[]>()

function buildSlots(seed: number, coach: number, load: number): RiderSlot[] {
  const slots: RiderSlot[] = []
  const doorHalfW = (COACH.doorWidthM / COACH.bodyLenM) * COACH_LENGTH_SCENE_M * 0.5
  for (let d = 0; d < COACH.doorCentreFrac.length; d++) {
    const z = (COACH.doorCentreFrac[d] - 0.5) * COACH_LENGTH_SCENE_M
    for (const side of [-1, 1]) {
      const roll = hash(seed, coach * 8 + d, side + 2)
      // A doorway fills one Rider at a time as the load climbs, and the last
      // place goes only at something near crush.
      const wanted = load * MAX_PER_DOORWAY * (0.55 + 0.75 * roll)
      const count = Math.min(MAX_PER_DOORWAY, Math.floor(wanted))
      for (let n = 0; n < count; n++) {
        const spread = count === 1 ? 0 : (n / (count - 1) - 0.5) * 2
        const jitter = hash(seed, coach * 32 + d * 4 + n, side) - 0.5
        slots.push({
          // A doorway is barely wider than two people, so a crowd in one
          // stacks in depth as well as across: the first Rider is out on the
          // edge of the opening and the ones behind stand back into the body,
          // which is exactly how a loaded local looks.
          x: side * (BODY_W / 2 - RIDER_W * (0.15 + n * 0.62)),
          y: FLOOR_Y + RIDER_H / 2,
          z: z + spread * (doorHalfW - RIDER_W * 0.55) * 0.5 + jitter * RIDER_W * 0.4,
          variation: hash(seed, coach * 64 + d * 8 + n, side + 7),
        })
      }
    }
  }
  return slots
}

/**
 * How full this Service's doorways are: the sim's Crowding curve, with the
 * top of the range held back so that even a crush leaves a doorway readable
 * rather than a solid block of figures.
 */
export function doorwayLoad(t: SimTime, direction: Direction): number {
  return Math.min(1, crowding(t, direction) * 0.95)
}

/**
 * Shirt colours. Mumbai's morning is not a uniform crowd, but at this distance
 * it is value that separates one Rider from the next, not hue — so these are
 * deliberately close in tone and varied in shade.
 */
const SHIRTS = [
  new Color('#5b6c88'),
  new Color('#8e7f71'),
  new Color('#adb2ba'),
  new Color('#667b6e'),
  new Color('#9a6259'),
  new Color('#454d5c'),
].map((c) => c.convertSRGBToLinear())

export function riderColor(variation: number): Color {
  return SHIRTS[Math.min(SHIRTS.length - 1, Math.floor(variation * SHIRTS.length))]
}
