import { describe, expect, it } from 'vitest'
import { formatSimTime, SIM_START } from './clock'

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
