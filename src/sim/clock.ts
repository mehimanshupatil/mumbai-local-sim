/** Simulation time is seconds since midnight IST on the sim day. */
export type SimTime = number

export const SECONDS_PER_DAY = 86400

export const SIM_START: SimTime = 8.5 * 3600 // 08:30, morning peak

export function formatSimTime(t: SimTime): string {
  const day = ((t % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY
  const h = Math.floor(day / 3600)
  const m = Math.floor((day % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
