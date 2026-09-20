/**
 * Crowding: how full a Service is, given the hour and the direction it runs.
 *
 * A property of the Service, not of the Rake working it — the same Rake is
 * crushed Up at 08:00 and empty Down an hour later (CONTEXT.md, Crowding), so
 * this takes a Direction and never a TrainState. It is deliberately not a
 * field on TrainState either: that type answers "where is this Rake", and a
 * renderer that wants to know how full it is can ask here.
 *
 * It lives in the sim core so there is one definition of "peak" for everything
 * that needs one — Riders in the doorways today, Platform Face crowds later.
 *
 * Baked per-Route profiles in western.json are the right eventual home, and
 * the migration path when Central arrives; the shape of the working day is
 * close enough across the Mumbai suburban Routes that it is not worth the bake
 * churn while there is one Route.
 */
import { SECONDS_PER_DAY, type SimTime } from './clock'
import type { Direction } from './types'

/** Hour of the sim day, 0–24, wrapping cleanly either side of midnight. */
function hourOf(t: SimTime): number {
  return ((((t % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 3600)
}

/** Shortest distance between two hours around the 24-hour clock. */
function hoursApart(a: number, b: number): number {
  const d = Math.abs(a - b) % 24
  return Math.min(d, 24 - d)
}

/** A peak centred on an hour, falling off over `width` hours either side. */
function peak(hour: number, centre: number, width: number): number {
  const d = hoursApart(hour, centre) / width
  return Math.exp(-d * d)
}

/**
 * The peaks, as Mumbai works them: into town in the morning, out of it in the
 * evening. The counter-peak is real but much lighter — a Down service at 08:45
 * is carrying the people who work the other way round, not an empty rake.
 */
const MORNING_PEAK_H = 8.75
const EVENING_PEAK_H = 18.75
const PEAK_WIDTH_H = 1.7
const PEAK_LOAD = 0.72
const COUNTER_PEAK_LOAD = 0.22

/**
 * The floor under both curves: the service is never empty while the city is
 * awake, and nearly is between the last trains and the first.
 */
function baseLoad(hour: number): number {
  // Wound down from about 23:00, back up from about 05:00.
  const awake = 1 - peak(hour, 2.5, 3.2)
  return 0.08 + 0.24 * awake
}

/**
 * How full a Service in this Direction is at this time, 0 (empty) to 1
 * (crush). Pure and deterministic: same inputs, same number.
 */
export function crowding(t: SimTime, direction: Direction): number {
  const hour = hourOf(t)
  const up = direction === 'up'
  const morning = peak(hour, MORNING_PEAK_H, PEAK_WIDTH_H)
  const evening = peak(hour, EVENING_PEAK_H, PEAK_WIDTH_H)
  const withFlow = up ? morning : evening
  const againstFlow = up ? evening : morning
  const load = baseLoad(hour) + PEAK_LOAD * withFlow + COUNTER_PEAK_LOAD * againstFlow
  return Math.max(0, Math.min(1, load))
}
