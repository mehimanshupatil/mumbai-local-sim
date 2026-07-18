import { describe, expect, it } from 'vitest'
import { formatSimTime, istSecondsSinceMidnight, SIM_START } from './clock'

describe('formatSimTime', () => {
  it('formats the sim start as 08:30', () => {
    expect(formatSimTime(SIM_START)).toBe('08:30')
  })

  it('wraps past midnight', () => {
    expect(formatSimTime(86400 + 60)).toBe('00:01')
  })

  it('handles negative times by wrapping backwards', () => {
    expect(formatSimTime(-60)).toBe('23:59')
  })
})

describe('istSecondsSinceMidnight', () => {
  it('converts a known UTC instant to IST wall-clock seconds', () => {
    // 2026-07-18T03:00:00Z = 08:30 IST (UTC+5:30)
    expect(istSecondsSinceMidnight(Date.UTC(2026, 6, 18, 3, 0, 0))).toBe(8.5 * 3600)
  })

  it('wraps IST past-midnight instants into the same day', () => {
    // 2026-07-18T20:00:00Z = 01:30 IST next day
    expect(istSecondsSinceMidnight(Date.UTC(2026, 6, 18, 20, 0, 0))).toBe(1.5 * 3600)
  })
})
