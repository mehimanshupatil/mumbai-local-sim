/**
 * Station arrival board: upcoming halts at a station, derived straight from
 * the timetables the trains actually run — predictions can't drift from
 * behaviour. Pure sim-core module.
 */
import type { SimTime } from './clock'
import type { Timetable } from './simulate'
import type { Direction, ServiceType } from './types'

export interface Arrival {
  serviceId: string
  serviceType: ServiceType
  direction: Direction
  arriveT: SimTime
  departT: SimTime
  /** Final stop of the service, for the "towards X" line. */
  terminusId: string
}

export function nextArrivals(
  timetables: Timetable[],
  stationId: string,
  simTime: SimTime,
  count: number,
  direction?: Direction,
): Arrival[] {
  const out: Arrival[] = []
  for (const tt of timetables) {
    if (direction && tt.def.direction !== direction) continue
    const stop = tt.stops.find((s) => s.id === stationId)
    if (!stop || stop.departT <= simTime) continue
    out.push({
      serviceId: tt.def.id,
      serviceType: tt.def.serviceType,
      direction: tt.def.direction,
      arriveT: stop.arriveT,
      departT: stop.departT,
      terminusId: tt.stops[tt.stops.length - 1].id,
    })
  }
  return out.sort((a, b) => a.arriveT - b.arriveT).slice(0, count)
}
