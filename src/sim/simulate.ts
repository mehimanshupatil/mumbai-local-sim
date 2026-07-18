/**
 * The simulation core seam: (network, services, simTime) → TrainState[].
 * Pure and deterministic; no React or three.js.
 *
 * A ServiceDef expands once into a Timetable (per-stop arrive/depart times
 * from the motion profile plus dwell); trainStates() then answers any
 * simTime from it. Same inputs always give the same states.
 */
import type { NetworkData } from '../data/network-types'
import type { SimTime } from './clock'
import { legProfile, type LegProfile } from './kinematics'
import type { ServiceDef, TrainState } from './types'

/** EMU performance — one profile for all v1 service types. */
const VMAX_MPS = 22 // ~80 km/h
const ACCEL_MPS2 = 0.7
const DECEL_MPS2 = 0.9
export const DWELL_S = 30

interface TimetableStop {
  id: string
  chainageM: number
  arriveT: SimTime
  departT: SimTime
}

export interface Timetable {
  def: ServiceDef
  stops: TimetableStop[]
  /** Motion profile of the leg leaving stop i. */
  legs: LegProfile[]
  endT: SimTime
}

export function buildTimetable(network: NetworkData, def: ServiceDef): Timetable {
  const byId = new Map(network.stations.map((s) => [s.id, s]))
  const stops: TimetableStop[] = []
  const legs: LegProfile[] = []
  const dwellS = def.dwellS ?? DWELL_S
  // The rake dwells at the origin platform before departureTime, so the
  // actual departure from the first stop is exactly def.departureTime.
  let t = def.departureTime - dwellS
  for (let i = 0; i < def.stopIds.length; i++) {
    const station = byId.get(def.stopIds[i])
    if (!station) throw new Error(`unknown station id: ${def.stopIds[i]}`)
    const arriveT = t
    const departT = arriveT + dwellS
    stops.push({ id: station.id, chainageM: station.chainageM, arriveT, departT })
    if (i < def.stopIds.length - 1) {
      const next = byId.get(def.stopIds[i + 1])
      if (!next) throw new Error(`unknown station id: ${def.stopIds[i + 1]}`)
      const leg = legProfile(
        Math.abs(next.chainageM - station.chainageM),
        VMAX_MPS,
        ACCEL_MPS2,
        DECEL_MPS2,
      )
      legs.push(leg)
      t = departT + leg.durationS
    }
  }
  return { def, stops, legs, endT: stops[stops.length - 1].departT }
}

/** All trains' states at simTime. Services outside their run window vanish. */
export function trainStates(timetables: Timetable[], simTime: SimTime): TrainState[] {
  const out: TrainState[] = []
  for (const tt of timetables) {
    const state = stateOf(tt, simTime)
    if (state) out.push(state)
  }
  return out
}

function stateOf(tt: Timetable, simTime: SimTime): TrainState | null {
  const { def, stops, legs } = tt
  if (simTime < stops[0].arriveT || simTime >= tt.endT) return null

  const sign = def.direction === 'down' ? 1 : -1
  const base = {
    id: def.id,
    serviceType: def.serviceType,
    direction: def.direction,
    track: def.track,
  }
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]
    if (simTime < stop.departT) {
      // Dwelling (or waiting to depart the origin) at stop i.
      return {
        ...base,
        chainageM: stop.chainageM,
        dwelling: simTime >= stop.arriveT,
        nextStopId: stop.id,
        speedMps: 0,
      }
    }
    const isLast = i === stops.length - 1
    if (!isLast && simTime < stops[i + 1].arriveT) {
      // On the leg between stop i and stop i+1.
      const { distanceM, speedMps } = legs[i].at(simTime - stop.departT)
      return {
        ...base,
        chainageM: stop.chainageM + sign * distanceM,
        dwelling: false,
        nextStopId: stops[i + 1].id,
        speedMps,
      }
    }
  }
  return null
}
