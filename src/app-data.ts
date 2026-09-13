/**
 * Data shared by the scene and the HTML overlay: the baked network, the
 * expanded service day, and the camera-focus state shape.
 */
import westernJson from './data/western.json'
import realTimetableJson from './data/western-real-timetable.json'
import type { NetworkData } from './data/network-types'
import { syntheticScheduler } from './sim/scheduler'
import { buildRealTimetable, buildTimetable, type Timetable } from './sim/simulate'
import type { ServiceType } from './sim/types'

export const network = westernJson as NetworkData

interface RealServiceJson {
  id: string
  serviceType: ServiceType
  direction: 'up' | 'down'
  lineId: number
  stops: { stationId: string; t: number }[]
}

// Real Western Railway Public Time Tables cover every slow/fast/AC local
// (src/data/western-real-timetable.json — see CLAUDE.md for the bake
// pipeline). They don't cover long-distance mail/express services — real
// suburban PTTs never carry those — so the synthetic scheduler still
// supplies the occasional nonstop express on the 5th/6th lines per the v1
// spec; everything else now runs on real, authoritative timetables.
const realTimetables: Timetable[] = (realTimetableJson as { services: RealServiceJson[] }).services.map(
  (svc) => buildRealTimetable(network, svc, svc.stops),
)
const syntheticExpresses: Timetable[] = syntheticScheduler(network)
  .filter((def) => def.serviceType === 'express')
  .map((def) => buildTimetable(network, def))

export const timetables: Timetable[] = [...realTimetables, ...syntheticExpresses]

/**
 * How the camera rides a followed service. Chase keeps the whole rake in
 * frame; cab sits at the driver's eye on the Rake's own Track; lineside plants
 * the camera by the track ahead and lets the train come past it.
 */
export type FollowView = 'chase' | 'cab' | 'lineside'

export type Focus =
  | { mode: 'free' }
  | { mode: 'follow'; trainId: string; view?: FollowView }
  | { mode: 'station'; stationId: string }
