/**
 * Pure simulation core types. This module and everything under src/sim/
 * must stay free of React and three.js imports — the rendering layer
 * consumes TrainState[] and nothing else crosses the seam.
 */
import type { SimTime } from './clock'

export type ServiceType = 'slow' | 'fast' | 'ac' | 'express'

/** Indian Railways convention: up = toward Churchgate, down = away. */
export type Direction = 'up' | 'down'

/**
 * The Lines a Service can be booked on — Slow / Fast / Through by Up / Down,
 * real WR usage. Shared by every scheduler implementation. How many physical
 * Tracks a Section has decides which Track a Line is drawn on there; that
 * mapping is trackForLine (src/sim/lines.ts), not this.
 */
export const LINE_SLOW_DOWN = 0
export const LINE_SLOW_UP = 1
export const LINE_FAST_DOWN = 2
export const LINE_FAST_UP = 3
export const LINE_THROUGH_DOWN = 4
export const LINE_THROUGH_UP = 5

export interface TrainState {
  id: string
  serviceType: ServiceType
  direction: Direction
  /** The Line this Service is booked on — one of the LINE_* constants. */
  lineId: number
  /** Position along the corridor, metres from Churchgate. */
  chainageM: number
  /** Stopped at a station with doors open. */
  dwelling: boolean
  /** Station id of the next (or current, while dwelling) stop. */
  nextStopId: string
  speedMps: number
  /**
   * Metres covered since departing the previous stop (0 while dwelling or at
   * the very start of a leg). Lets the render layer unwind a platform-nose
   * offset by distance travelled rather than by speed — speed-based unwind
   * regresses visibly, since a stopped train's speed rises from 0 far slower
   * than any reasonable offset can shrink (see Fleet.tsx's platformBlend).
   */
  legDistanceM: number
  /**
   * Set once a service's run has ended and it's within its bounded parking
   * window at a real yard (ticket #17); null while running, and null again
   * once the window has passed (the rake is considered stabled out of view)
   * or the yard was already at capacity when this service arrived.
   */
  parkedYardId: string | null
  /** Which siding slot (0 = nearest the junction) this rake occupies while
   * parked; null unless parkedYardId is set. */
  parkedSlot: number | null
}

/** A single scheduled run. The synthetic scheduler emits these (ticket #6). */
export interface ServiceDef {
  id: string
  serviceType: ServiceType
  direction: Direction
  /** The Line this Service is booked on — one of the LINE_* constants. */
  lineId: number
  /** Departure from the first stop. */
  departureTime: SimTime
  /** Ordered station ids the service halts at. */
  stopIds: string[]
  /** Seconds spent at each halt; defaults to the standard 30 s. 0 = nonstop passage points. */
  dwellS?: number
}
