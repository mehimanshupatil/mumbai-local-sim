/**
 * Service scheduling. The Scheduler seam is a plain function so the v1
 * synthetic timetable can be swapped for a GTFS-backed one without touching
 * movement (simulate.ts) or rendering.
 */
import type { NetworkData, StationRecord } from '../data/network-types'
import { buildTimetable } from './simulate'
import {
  TRACK_EXPRESS_DOWN,
  TRACK_EXPRESS_UP,
  TRACK_FAST_DOWN,
  TRACK_FAST_UP,
  TRACK_SLOW_DOWN,
  TRACK_SLOW_UP,
  type ServiceDef,
} from './types'

export type Scheduler = (network: NetworkData) => ServiceDef[]

/** Peak service windows (IST hours) and headways per the parent spec. */
const PEAK_WINDOWS: [number, number][] = [
  [7, 11],
  [17, 21],
]
const HEADWAY_PEAK_S = 4 * 60
const HEADWAY_OFF_S = 8 * 60
const SERVICE_START_H = 4.5
const SERVICE_END_H = 24.5
/** Every Nth slow rake runs as the blue AC variant. */
const AC_EVERY = 5
/**
 * Turnback rotation, matching the real WR mix: Borivali locals dominate,
 * Virar and Andheri follow, the odd Bhayandar. Fasts run deep only.
 */
const SLOW_TERMINI = ['Borivali', 'Virar', 'Andheri', 'Borivali', 'Virar', 'Borivali', 'Bhayandar']
const FAST_TERMINI = ['Virar', 'Borivali']
/** Long-distance expresses per hour (each direction). */
const EXPRESS_INTERVAL_S = 3600
/** Virar–Dahanu shuttles run half-hourly all day. */
const SHUTTLE_INTERVAL_S = 1800

const isPeak = (t: number) =>
  PEAK_WINDOWS.some(([a, b]) => t >= a * 3600 && t < b * 3600)

const headwayAt = (t: number) => (isPeak(t) ? HEADWAY_PEAK_S : HEADWAY_OFF_S)

/** Departure instants over the service day at peak/off-peak headways. */
function departures(): number[] {
  const out: number[] = []
  for (let t = SERVICE_START_H * 3600; t < SERVICE_END_H * 3600; t += headwayAt(t)) {
    out.push(t)
  }
  return out
}

/**
 * The v1 synthetic timetable. Deliberately Western-line-shaped: it names the
 * corridor breakpoints (Virar, Mumbai Central) that a real timetable encodes
 * implicitly. A GTFS-backed Scheduler replaces this whole module; nothing
 * else in the sim knows these names.
 */
export const syntheticScheduler: Scheduler = (network) => {
  const stations = network.stations
  const virarIdx = stations.findIndex((s) => s.name === 'Virar')
  const bctIdx = stations.findIndex((s) => s.name === 'Mumbai Central')
  if (virarIdx < 0 || bctIdx < 0) throw new Error('network is missing Virar or Mumbai Central')

  const ids = (list: StationRecord[]) => list.map((s) => s.id)
  const localCorridor = stations.slice(0, virarIdx + 1)
  const shuttleStops = ids(stations.slice(virarIdx))
  const expressStops = [stations[bctIdx].id, stations[stations.length - 1].id]

  const indexOfName = (name: string) => {
    const i = stations.findIndex((s) => s.name === name)
    if (i < 0) throw new Error(`network is missing terminus ${name}`)
    return i
  }
  const slowStopsTo = (terminus: string) => ids(localCorridor.slice(0, indexOfName(terminus) + 1))
  const fastStopsTo = (terminus: string) =>
    ids(localCorridor.slice(0, indexOfName(terminus) + 1).filter((s) => s.fastHalt))

  const defs: ServiceDef[] = []
  /** End-to-end run seconds for a stop list, so up trains can be timed by arrival. */
  const runSecondsCache = new Map<string, number>()
  const runSeconds = (stopIds: string[]) => {
    const key = stopIds[stopIds.length - 1] + ':' + stopIds.length
    let s = runSecondsCache.get(key)
    if (s === undefined) {
      const tt = buildTimetable(network, {
        id: 'probe',
        serviceType: 'slow',
        direction: 'down',
        track: 0,
        departureTime: 0,
        stopIds,
      })
      s = tt.stops[tt.stops.length - 1].arriveT
      runSecondsCache.set(key, s)
    }
    return s
  }
  /**
   * Emit a down/up pair. The down service departs Churchgate at the slot
   * time; the up service is timed to ARRIVE Churchgate at the slot time, so
   * southbound spacing through the shared trunk stays even no matter which
   * terminus each train turned back from.
   */
  const pair = (
    idPrefix: string,
    i: number,
    template: Omit<ServiceDef, 'id' | 'direction' | 'track'> & { downTrack: number; upTrack: number },
  ) => {
    const { downTrack, upTrack, stopIds, departureTime, ...rest } = template
    defs.push(
      { ...rest, id: `${idPrefix}-DN-${i}`, direction: 'down', track: downTrack, departureTime, stopIds },
      {
        ...rest,
        id: `${idPrefix}-UP-${i}`,
        direction: 'up',
        track: upTrack,
        departureTime: departureTime - runSeconds(stopIds),
        stopIds: [...stopIds].reverse(),
      },
    )
  }

  departures().forEach((departureTime, i) => {
    // AC rakes slot into the slow sequence deterministically — no randomness,
    // so identical clocks always see identical fleets.
    const slowType = i % AC_EVERY === AC_EVERY - 1 ? ('ac' as const) : ('slow' as const)
    pair('S', i, {
      serviceType: slowType,
      departureTime,
      stopIds: slowStopsTo(SLOW_TERMINI[i % SLOW_TERMINI.length]),
      downTrack: TRACK_SLOW_DOWN,
      upTrack: TRACK_SLOW_UP,
    })
    // Fast departures interleave the slows: half a headway behind.
    pair('F', i, {
      serviceType: 'fast',
      departureTime: departureTime + headwayAt(departureTime) / 2,
      stopIds: fastStopsTo(FAST_TERMINI[i % FAST_TERMINI.length]),
      downTrack: TRACK_FAST_DOWN,
      upTrack: TRACK_FAST_UP,
    })
  })

  for (let t = SERVICE_START_H * 3600, i = 0; t < SERVICE_END_H * 3600; t += SHUTTLE_INTERVAL_S, i++) {
    pair('V', i, {
      serviceType: 'slow',
      departureTime: t,
      stopIds: shuttleStops,
      downTrack: TRACK_SLOW_DOWN,
      upTrack: TRACK_SLOW_UP,
    })
  }

  for (let t = SERVICE_START_H * 3600 + 900, i = 0; t < SERVICE_END_H * 3600; t += EXPRESS_INTERVAL_S, i++) {
    pair('E', i, {
      serviceType: 'express',
      departureTime: t,
      stopIds: expressStops,
      dwellS: 0,
      downTrack: TRACK_EXPRESS_DOWN,
      upTrack: TRACK_EXPRESS_UP,
    })
  }

  return defs
}
