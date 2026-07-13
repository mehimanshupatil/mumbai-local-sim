/**
 * Pure simulation core types. This module and everything under src/sim/
 * must stay free of React and three.js imports — the rendering layer
 * consumes TrainState[] and nothing else crosses the seam.
 */
import type { SimTime } from './clock'

export type ServiceType = 'slow' | 'fast' | 'ac' | 'express'

/** Indian Railways convention: up = toward Churchgate, down = away. */
export type Direction = 'up' | 'down'

export interface TrainState {
  id: string
  serviceType: ServiceType
  direction: Direction
  /** 0-based running-track index within the section the train is on. */
  track: number
  /** Position along the corridor, metres from Churchgate. */
  chainageM: number
  /** Stopped at a station with doors open. */
  dwelling: boolean
  /** Station id of the next (or current, while dwelling) stop. */
  nextStopId: string
  speedMps: number
}

/** A single scheduled run. The synthetic scheduler emits these (ticket #6). */
export interface ServiceDef {
  id: string
  serviceType: ServiceType
  direction: Direction
  track: number
  /** Departure from the first stop. */
  departureTime: SimTime
  /** Ordered station ids the service halts at. */
  stopIds: string[]
}
