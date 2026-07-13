/**
 * Closed-form stop-to-stop motion profile: accelerate, cruise, brake.
 * Short legs that never reach cruise speed get a triangular profile.
 * Pure math — deterministic for a given leg.
 */

export interface LegProfile {
  /** Total leg time in seconds. */
  durationS: number
  /** Distance covered (m) and speed (m/s) at time tS into the leg. */
  at: (tS: number) => { distanceM: number; speedMps: number }
}

export function legProfile(distanceM: number, vmaxMps: number, accel: number, decel: number): LegProfile {
  if (distanceM <= 0) {
    return { durationS: 0, at: () => ({ distanceM: 0, speedMps: 0 }) }
  }
  // Peak speed actually reached (may be below vmax on short legs).
  const vPeak = Math.min(vmaxMps, Math.sqrt((2 * distanceM * accel * decel) / (accel + decel)))
  const tAccel = vPeak / accel
  const tDecel = vPeak / decel
  const dAccel = (vPeak * vPeak) / (2 * accel)
  const dDecel = (vPeak * vPeak) / (2 * decel)
  const dCruise = Math.max(0, distanceM - dAccel - dDecel)
  const tCruise = dCruise / vPeak
  const durationS = tAccel + tCruise + tDecel

  const at = (tS: number) => {
    const t = Math.max(0, Math.min(durationS, tS))
    if (t <= tAccel) {
      return { distanceM: 0.5 * accel * t * t, speedMps: accel * t }
    }
    if (t <= tAccel + tCruise) {
      return { distanceM: dAccel + vPeak * (t - tAccel), speedMps: vPeak }
    }
    const tb = t - tAccel - tCruise
    return {
      distanceM: dAccel + dCruise + vPeak * tb - 0.5 * decel * tb * tb,
      speedMps: vPeak - decel * tb,
    }
  }
  return { durationS, at }
}
