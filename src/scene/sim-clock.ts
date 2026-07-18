/**
 * The running sim clock — single time authority for the render layer.
 * A mutable singleton read inside useFrame callbacks so per-frame time
 * updates don't re-render React. ClockControls owns speed/pause and the
 * one-shot IST sync; the sim opens at 08:30 (SIM_START).
 */
import { useFrame } from '@react-three/fiber'
import { SIM_START } from '../sim/clock'

export const simClock = {
  t: SIM_START,
  speed: 1,
}

// Dev affordance: poke the clock from the browser console
// (e.g. simClock.speed = 60).
declare global {
  interface Window {
    simClock?: typeof simClock
  }
}
if (typeof window !== 'undefined') window.simClock = simClock

/** Mount once inside the Canvas to advance the clock every frame. */
export function SimClockDriver() {
  useFrame((_, delta) => {
    simClock.t += delta * simClock.speed
  })
  return null
}
