import { describe, expect, it } from 'vitest'
import { SECONDS_PER_DAY } from './clock'
import { crowding } from './crowding'

/** Sim time at a wall-clock hour, e.g. at(8, 45) = 08:45. */
const at = (h: number, m = 0) => h * 3600 + m * 60

describe('crowding', () => {
  it('peaks Up in the morning and Down in the evening', () => {
    expect(crowding(at(8, 45), 'up')).toBeGreaterThan(crowding(at(14), 'up'))
    expect(crowding(at(18, 45), 'down')).toBeGreaterThan(crowding(at(14), 'down'))
  })

  it('is not the same curve in both directions at the same hour', () => {
    // Into Churchgate at the morning peak, out of it at the evening one.
    expect(crowding(at(8, 45), 'up')).toBeGreaterThan(crowding(at(8, 45), 'down'))
    expect(crowding(at(18, 45), 'down')).toBeGreaterThan(crowding(at(18, 45), 'up'))
  })

  it('carries the counter-peak rather than running the other way empty', () => {
    // A Down working at the morning peak is the reverse commute: lighter than
    // the peak flow, heavier than the middle of the afternoon.
    const counter = crowding(at(8, 45), 'down')
    expect(counter).toBeLessThan(crowding(at(8, 45), 'up'))
    expect(counter).toBeGreaterThan(crowding(at(14), 'down'))
  })

  it('empties out overnight and fills again for the first trains', () => {
    for (const direction of ['up', 'down'] as const) {
      expect(crowding(at(3), direction)).toBeLessThan(crowding(at(6, 30), direction))
      expect(crowding(at(3), direction)).toBeLessThan(0.2)
    }
  })

  it('stays within an empty-to-crush 0..1', () => {
    for (let t = 0; t < SECONDS_PER_DAY; t += 300) {
      for (const direction of ['up', 'down'] as const) {
        const load = crowding(t, direction)
        expect(load).toBeGreaterThanOrEqual(0)
        expect(load).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is deterministic, and reads the same hour on the next sim day', () => {
    expect(crowding(at(8, 45), 'up')).toBe(crowding(at(8, 45), 'up'))
    expect(crowding(at(8, 45) + SECONDS_PER_DAY, 'up')).toBeCloseTo(crowding(at(8, 45), 'up'), 12)
    // Nothing happens to a service at midnight: the curve runs across it,
    // rather than treating 23:59 and 00:01 as twenty-three hours apart.
    expect(crowding(at(24) - 1, 'up')).toBeCloseTo(crowding(1, 'up'), 3)
  })
})
