/**
 * The running sim clock — single time authority for the render layer.
 * A mutable singleton read inside useFrame callbacks so per-frame time
 * updates don't re-render React. The clock UI (ticket #7) will own
 * speed/pause; until then it runs at 1x from SIM_START.
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
