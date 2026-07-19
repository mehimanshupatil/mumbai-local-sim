/**
 * Data shared by the scene and the HTML overlay: the baked network, the
 * expanded service day, and the camera-focus state shape.
 */
import westernJson from './data/western.json'
import type { NetworkData } from './data/network-types'
import { syntheticScheduler } from './sim/scheduler'
import { buildTimetable, type Timetable } from './sim/simulate'

export const network = westernJson as NetworkData

export const timetables: Timetable[] = syntheticScheduler(network).map((def) =>
  buildTimetable(network, def),
)

export type Focus =
  | { mode: 'free' }
  | { mode: 'follow'; trainId: string }
  | { mode: 'station'; stationId: string }
