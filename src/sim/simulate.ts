/**
 * The simulation core seam: (network, services, simTime) → TrainState[].
 * Pure and deterministic; no React or three.js.
 *
 * A ServiceDef expands once into a Timetable (per-stop arrive/depart times
 * from the motion profile plus dwell); trainStates() then answers any
 * simTime from it. Same inputs always give the same states.
 */
import { haversineM } from '../data/geo'
import type { NetworkData } from '../data/network-types'
import type { SimTime } from './clock'
import { easedLegProfile, legProfile, type LegProfile } from './kinematics'
import type { Direction, ServiceDef, ServiceType, TrainState } from './types'

/**
 * EMU performance — one profile for all v1 service types. Calibrated against
 * real WR inter-station runtimes (data/Mumbai Local Train Dataset.csv):
 * effective cruise below the stock's 80 km/h top speed, gentle curves and
 * signal caution folded in. Total Churchgate→Dahanu within ~5% of published.
 */
const VMAX_MPS = 15.5 // ~56 km/h effective
const ACCEL_MPS2 = 0.5
const DECEL_MPS2 = 0.7
export const DWELL_S = 30

/**
 * Terminated-rake parking at a real yard (ticket #17), instead of vanishing
 * the instant a service ends. Bounded rather than for the rest of the sim
 * day: real yards cycle through far more stock than they can hold at once
 * (this line runs ~1,321 daily services through 4 yards), so an unbounded
 * park would eventually try to render nearly every service that ever ran
 * simultaneously. Capacity is resolved per yard in trainStates() — freshest
 * arrival first, same "vanish" fate as before ticket #17 for anything past
 * capacity, just delayed by up to PARK_DURATION_S.
 */
export const PARK_DURATION_S = 50 * 60
export const YARD_CAPACITY = 4

/** The real yard nearest a station, for routing a terminated service. */
function nearestYardId(network: NetworkData, stationId: string): string | null {
  const station = network.stations.find((s) => s.id === stationId)
  if (!station || network.yards.length === 0) return null
  let bestId: string | null = null
  let bestD = Infinity
  for (const y of network.yards) {
    const d = haversineM([station.lon, station.lat], [y.lon, y.lat])
    if (d < bestD) {
      bestD = d
      bestId = y.id
    }
  }
  return bestId
}

interface TimetableStop {
  id: string
  chainageM: number
  arriveT: SimTime
  departT: SimTime
}

/**
 * The only fields a built Timetable actually reads back out of its source
 * (see stateOf below) — deliberately narrower than ServiceDef so a
 * Timetable can be built from something that isn't one (a real schedule
 * already carries its own per-stop times, not a single departureTime +
 * stopIds to expand via kinematics).
 */
interface TrainIdentity {
  id: string
  serviceType: ServiceType
  direction: Direction
  track: number
  /** Real yard nearest this service's terminating station, for parking once
   * the run ends (ticket #17); null if no yard is within a sane distance. */
  homeYardId: string | null
  /** Real yard nearest this service's originating station, for parking
   * before departure (ticket #17) instead of teleporting onto the line. */
  originYardId: string | null
}

export interface Timetable {
  def: TrainIdentity
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
  const identity: TrainIdentity = {
    id: def.id,
    serviceType: def.serviceType,
    direction: def.direction,
    track: def.track,
    homeYardId: nearestYardId(network, def.stopIds[def.stopIds.length - 1]),
    originYardId: nearestYardId(network, def.stopIds[0]),
  }
  return { def: identity, stops, legs, endT: stops[stops.length - 1].departT }
}

export interface RealStop {
  stationId: string
  /** Departure at the origin / arrival everywhere else, from the real PTT. */
  t: SimTime
}

/**
 * Build a Timetable directly from a real timetable's known per-stop times
 * (src/data/western-real-timetable.json) — no kinematics involved, since we
 * already have the true inter-station duration for every leg. Follows the
 * same dwell convention as buildTimetable: the origin dwells before its
 * printed time (treated as departure); every other stop dwells after its
 * printed time (treated as arrival).
 */
export function buildRealTimetable(
  network: NetworkData,
  identity: Omit<TrainIdentity, 'homeYardId' | 'originYardId'>,
  realStops: RealStop[],
  dwellS = DWELL_S,
): Timetable {
  const byId = new Map(network.stations.map((s) => [s.id, s]))
  const stops: TimetableStop[] = realStops.map((s, i) => {
    const station = byId.get(s.stationId)
    if (!station) throw new Error(`unknown station id: ${s.stationId}`)
    return i === 0
      ? { id: station.id, chainageM: station.chainageM, arriveT: s.t - dwellS, departT: s.t }
      : { id: station.id, chainageM: station.chainageM, arriveT: s.t, departT: s.t + dwellS }
  })
  const legs = stops.slice(0, -1).map((stop, i) => {
    const next = stops[i + 1]
    // Guard only — PTT times are printed to the minute, so a tight real gap
    // is possible in principle, but none of the 19,494 legs in the current
    // baked data actually reach this floor (checked directly against
    // src/data/western-real-timetable.json).
    const durationS = Math.max(5, next.arriveT - stop.departT)
    return easedLegProfile(Math.abs(next.chainageM - stop.chainageM), durationS)
  })
  const def: TrainIdentity = {
    ...identity,
    homeYardId: nearestYardId(network, realStops[realStops.length - 1].stationId),
    originYardId: nearestYardId(network, realStops[0].stationId),
  }
  return { def, stops, legs, endT: stops[stops.length - 1].departT }
}

/**
 * All trains' states at simTime. Services outside their run window vanish —
 * unless they end within reach of a real yard, in which case they park for
 * up to PARK_DURATION_S (see stateOf), bounded per yard to YARD_CAPACITY
 * concurrent rakes: this second pass resolves that capacity across every
 * timetable at once (stateOf only sees its own), freshest arrival first.
 */
export function trainStates(timetables: Timetable[], simTime: SimTime): TrainState[] {
  const raw: { state: TrainState; parkedAt: SimTime }[] = []
  for (const tt of timetables) {
    const state = stateOf(tt, simTime)
    if (!state) continue
    // The moment this rake entered the yard: for a terminated run that's
    // when it stopped running (tt.endT); for a not-yet-departed run it's
    // the start of its bounded pre-departure window. Either way, higher =
    // more recently parked.
    const parkedAt = simTime < tt.stops[0].arriveT ? tt.stops[0].arriveT - PARK_DURATION_S : tt.endT
    raw.push({ state, parkedAt })
  }

  const byYard = new Map<string, typeof raw>()
  for (const r of raw) {
    if (!r.state.parkedYardId) continue
    const group = byYard.get(r.state.parkedYardId)
    if (group) group.push(r)
    else byYard.set(r.state.parkedYardId, [r])
  }
  const slotById = new Map<string, number>()
  for (const group of byYard.values()) {
    group.sort((a, b) => b.parkedAt - a.parkedAt) // most recently parked first
    group.slice(0, YARD_CAPACITY).forEach((r, i) => slotById.set(r.state.id, i))
  }

  const out: TrainState[] = []
  for (const { state } of raw) {
    if (!state.parkedYardId) {
      out.push(state)
      continue
    }
    const slot = slotById.get(state.id)
    if (slot === undefined) continue // past yard capacity — vanishes, as before #17
    out.push({ ...state, parkedSlot: slot })
  }
  return out
}

function stateOf(tt: Timetable, simTime: SimTime): TrainState | null {
  const { def, stops, legs } = tt
  const sign = def.direction === 'down' ? 1 : -1
  const base = {
    id: def.id,
    serviceType: def.serviceType,
    direction: def.direction,
    track: def.track,
  }
  if (simTime < stops[0].arriveT) {
    if (!def.originYardId || simTime < stops[0].arriveT - PARK_DURATION_S) return null
    const first = stops[0]
    return {
      ...base,
      chainageM: first.chainageM,
      dwelling: true,
      nextStopId: first.id,
      speedMps: 0,
      legDistanceM: 0,
      parkedYardId: def.originYardId,
      parkedSlot: null, // resolved across services by trainStates()
    }
  }
  if (simTime >= tt.endT) {
    if (!def.homeYardId || simTime >= tt.endT + PARK_DURATION_S) return null
    const last = stops[stops.length - 1]
    return {
      ...base,
      chainageM: last.chainageM,
      dwelling: true,
      nextStopId: last.id,
      speedMps: 0,
      legDistanceM: 0,
      parkedYardId: def.homeYardId,
      parkedSlot: null, // resolved across services by trainStates()
    }
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
        legDistanceM: 0,
        parkedYardId: null,
        parkedSlot: null,
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
        legDistanceM: distanceM,
        parkedYardId: null,
        parkedSlot: null,
      }
    }
  }
  return null
}
