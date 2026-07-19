/**
 * Sim-clock lighting, ported from mumbai-lakes: morning-cool → noon →
 * golden evening → dusk-blue night, clamped for readability — night keeps a
 * cool moon key light so the map never goes black. The sim clock (not wall
 * time) is the only time source, so a 60x run sweeps dawn to dusk visibly.
 */
import { useEffect, useState } from 'react'
import { Color } from 'three'
import { simClock } from './sim-clock'

export interface Daylight {
  /** 0 = full day … 1 = full night */
  night: number
  /** Direction the key light comes from (unit-ish, scale as needed). */
  sunPos: [number, number, number]
  /** Where the sky's sun sits (dips below the horizon at night). */
  skySunPos: [number, number, number]
  sunColor: string
  sunIntensity: number
  ambientColor: string
  ambientIntensity: number
  /** Background color behind the sky. */
  skyColor: string
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

export function computeDaylight(hour: number): Daylight {
  // day window ~06:00–19:30; dayness fades at both ends
  const dayness = smooth(5.5, 7.2, hour) * (1 - smooth(18.2, 19.6, hour))
  const night = 1 - dayness

  const dayFrac = clamp01((hour - 6) / 13.5) // 0 sunrise … 1 sunset
  const elev = Math.sin(Math.PI * dayFrac) // 0..1..0

  // sun travels east → west (+x → −x), arcing through the southern sky (+z)
  const sunX = 130 - 260 * dayFrac
  const sunY = 25 + 135 * elev
  const sunZ = 55
  const moonPos: [number, number, number] = [-70, 110, -35]

  const mix = (a: number, b: number) => a * dayness + b * night
  const sunPos: [number, number, number] = [
    mix(sunX, moonPos[0]),
    mix(sunY, moonPos[1]),
    mix(sunZ, moonPos[2]),
  ]

  // warm at low sun, near-white at noon, cool moonlight at night
  const dayCol = new Color('#ffd9a8').lerp(new Color('#fff7ea'), elev)
  const sunColor = `#${dayCol.lerp(new Color('#a9c4e6'), night).getHexString()}`

  const ambient = new Color('#fff3e2').lerp(new Color('#7d94b5'), night)
  const sky = new Color('#79b1d3')
    .lerp(new Color('#3f7ea3'), 1 - elev * (1 - night)) // dimmer toward dawn/dusk
    .lerp(new Color('#081f30'), night)

  return {
    night,
    sunPos,
    skySunPos: [sunX, 25 + 160 * Math.sin(Math.PI * ((hour - 6) / 13.5)), sunZ],
    sunColor,
    sunIntensity: 1.55 * elev * dayness + 0.55 * night,
    ambientColor: `#${ambient.getHexString()}`,
    ambientIntensity: 0.62 * dayness + 0.4 * night,
    skyColor: `#${sky.getHexString()}`,
  }
}

/** Daylight for the current sim time, polled a few times a second. */
export function useSimDaylight(): Daylight {
  const [light, setLight] = useState(() => computeDaylight((simClock.t / 3600) % 24))
  useEffect(() => {
    let lastHour = -1
    const id = setInterval(() => {
      // Skip re-rendering the whole Canvas subtree while the clock is paused
      // or barely moved (sub-second at 1x changes nothing visible).
      const hour = (simClock.t / 3600) % 24
      if (Math.abs(hour - lastHour) < 0.001) return
      lastHour = hour
      setLight(computeDaylight(hour))
    }, 250)
    return () => clearInterval(id)
  }, [])
  return light
}
