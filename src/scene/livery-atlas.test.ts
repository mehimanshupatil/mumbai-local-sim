/**
 * Invariants over the committed Livery mask atlas (public/livery/rake-masks.png),
 * in the spirit of western.test.ts: the asset is committed, so the tests read
 * it, not a freshly baked one — a clone that never runs `pnpm bake:livery`
 * must still be running against an atlas that says what the layout says.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { renderAtlasPng } from '../../scripts/bake-livery-atlas'
import {
  ATLAS_PATH,
  ATLAS_SIZE,
  CHANNEL,
  COACH,
  REGION,
  REGION_CHANNELS,
  sideU,
  sideV,
  uvRect,
  type Channel,
  type Region,
  type RegionName,
} from './livery-atlas'

const FILE = join(process.cwd(), 'public', ATLAS_PATH)
const committed = readFileSync(FILE)
const atlas = PNG.sync.read(committed)

/** Mask value 0..255 at a texel of a region, in region-local (u, v). */
function texel(region: Region, channel: Channel, u: number, v: number): number {
  const x = region.x + Math.floor(u * region.w)
  const y = region.y + Math.floor(v * region.h)
  return atlas.data[(y * ATLAS_SIZE + x) * 4 + channel]
}

/** Share of a region's texels where this channel is painted at all. */
function coverage(region: Region, channel: Channel): number {
  let lit = 0
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      if (atlas.data[(y * ATLAS_SIZE + x) * 4 + channel] > 0) lit++
    }
  }
  return lit / (region.w * region.h)
}

const REGION_NAMES = Object.keys(REGION) as RegionName[]
const CHANNELS = Object.values(CHANNEL)

describe('the committed atlas', () => {
  it('is one 1024x1024 RGBA texture', () => {
    expect(atlas.width).toBe(ATLAS_SIZE)
    expect(atlas.height).toBe(ATLAS_SIZE)
    // Four channels, or the fourth mask has nowhere to live.
    expect(atlas.data.length).toBe(ATLAS_SIZE * ATLAS_SIZE * 4)
  })

  it('is byte-identical to a fresh bake', () => {
    expect(renderAtlasPng().equals(committed)).toBe(true)
  })

  it('lays every region inside the texture, with no two overlapping', () => {
    for (const name of REGION_NAMES) {
      const r = REGION[name]
      expect(r.x + r.w).toBeLessThanOrEqual(ATLAS_SIZE)
      expect(r.y + r.h).toBeLessThanOrEqual(ATLAS_SIZE)
      const { offset, scale } = uvRect(name)
      expect(offset[0] + scale[0]).toBeLessThanOrEqual(1)
      expect(offset[1] + scale[1]).toBeLessThanOrEqual(1)
    }
    for (const a of REGION_NAMES) {
      for (const b of REGION_NAMES) {
        if (a === b) continue
        const [p, q] = [REGION[a], REGION[b]]
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
        expect(apart, `${a} overlaps ${b}`).toBe(true)
      }
    }
  })

  it('carries every channel each region declares, and only those', () => {
    for (const name of REGION_NAMES) {
      const declared: readonly Channel[] = REGION_CHANNELS[name]
      for (const channel of CHANNELS) {
        const share = coverage(REGION[name], channel)
        if (declared.includes(channel)) {
          expect(share, `${name} channel ${channel} is empty`).toBeGreaterThan(0.005)
        } else {
          // A cab face has no doorway; a roof has no glass.
          expect(share, `${name} channel ${channel} should be empty`).toBe(0)
        }
      }
    }
  })
})

describe('the coach side', () => {
  const side = REGION.side
  /** Down the middle of the doorways, height-wise: floor to door head. */
  const midDoorV = (sideV(0) + sideV(COACH.doorHeightM)) / 2

  it('has four doorways, at the real spacing', () => {
    const runs: { from: number; to: number }[] = []
    let open: number | null = null
    for (let x = 0; x < side.w; x++) {
      const lit = texel(side, CHANNEL.DOORWAY, (x + 0.5) / side.w, midDoorV) > 127
      if (lit && open === null) open = x
      if (!lit && open !== null) {
        runs.push({ from: open / side.w, to: x / side.w })
        open = null
      }
    }
    if (open !== null) runs.push({ from: open / side.w, to: 1 })

    expect(runs).toHaveLength(COACH.doorsPerSide)
    runs.forEach((run, i) => {
      expect((run.from + run.to) / 2).toBeCloseTo(COACH.doorCentreFrac[i], 2)
      // ~1.25 m of clear doorway, in body lengths.
      expect(run.to - run.from).toBeCloseTo(sideU(COACH.doorWidthM), 2)
    })
  })

  it('puts no glass inside a doorway', () => {
    for (const centre of COACH.doorCentreFrac) {
      for (let v = sideV(COACH.doorHeightM); v < sideV(0); v += 0.02) {
        expect(texel(side, CHANNEL.WINDOW, centre, v)).toBe(0)
      }
    }
  })

  it('keeps the window band between sill and louvre, clear of the underframe', () => {
    // Glass at window height somewhere along the body...
    const atWindowHeight = Array.from({ length: side.w }, (_, x) =>
      texel(side, CHANNEL.WINDOW, (x + 0.5) / side.w, (sideV(COACH.windowSillM) + sideV(COACH.windowHeadM)) / 2),
    )
    expect(atWindowHeight.some((v) => v > 200)).toBe(true)
    // ...and none at all below the floor, where the body is solebar and kit.
    for (let v = sideV(0) + 0.02; v < 1; v += 0.02) {
      for (let u = 0.02; u < 1; u += 0.02) {
        expect(texel(side, CHANNEL.WINDOW, u, v)).toBe(0)
      }
    }
  })

  it('wears its dirt at the roof and the skirt, not across the waist', () => {
    const roofline = texel(side, CHANNEL.DIRT, 0.5, 0.01)
    const skirt = texel(side, CHANNEL.DIRT, 0.5, 0.99)
    // Between the doorways at waist height, where a body stays painted.
    const waist = texel(side, CHANNEL.DIRT, 0.26, sideV(COACH.windowSillM))
    expect(roofline).toBeGreaterThan(60)
    expect(skirt).toBeGreaterThan(60)
    expect(waist).toBeLessThan(roofline)
    expect(waist).toBeLessThan(skirt)
  })
})
