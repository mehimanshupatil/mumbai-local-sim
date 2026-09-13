/**
 * What sound the Timetable calls for, and when.
 *
 * A Cue is a fact about the service day — "this Service announces its
 * approach at this Station's Platform Face at this second" — not a fact about
 * rendering. Deciding them here keeps timetable reasoning unit-testable
 * alongside the rest of the sim core; the scene asks for the window it just
 * crossed and plays what it is handed. Watching TrainState each frame and
 * inferring Cues would rebuild the same reasoning in the render layer, which
 * is the mistake ticket #24 finished deleting from Fleet.
 *
 * Pure and deterministic, like everything under src/sim/: no React, no
 * three.js, no Web Audio.
 */
import type { NetworkData } from '../data/network-types'
import type { SimTime } from './clock'
import { faceForHalt } from './platforms'
import type { Timetable } from './simulate'
import type { Direction, ServiceType } from './types'

export type CueKind =
  /** Platform PA: a Service is nearing this Halt. */
  | 'announce-approach'
  /** Platform PA: a Service is about to leave this Halt. */
  | 'announce-departure'
  /** In-Rake: naming the Halt it has just set off for. */
  | 'callout-departure'
  /** In-Rake: nearing that Halt. */
  | 'callout-approach'
  /** In-Rake: this is the last Halt, all change. */
  | 'callout-terminus'
  | 'horn'
  | 'brake'
  | 'door-close'

/**
 * The Cues that play at a Platform Face rather than at the Rake. The rest are
 * heard from the train itself, so the scene positions them from the Service's
 * live TrainState instead of from a Station.
 */
export const FACE_CUES: ReadonlySet<CueKind> = new Set<CueKind>([
  'announce-approach',
  'announce-departure',
])

export interface Cue {
  /** Seconds since midnight IST, on the same unwrapped scale as simClock.t. */
  t: SimTime
  kind: CueKind
  serviceId: string
  serviceType: ServiceType
  direction: Direction
  /** The Line the Service is booked on — see LINE_* in types.ts. */
  lineId: number
  /** The Halt this Cue is about: where an Announcement plays, or the Station a Callout names. */
  stationId: string
  chainageM: number
  /**
   * The Platform Face the Announcement plays at, as a Track index — Faces have
   * no numbers here, see ADR 0001. Null for Cues heard from the Rake.
   */
  faceTrack: number | null
  /** Final Halt of the Service, for "towards X". */
  terminusId: string
  /** The Service's booked time at stationId: arrival, or departure at the origin. */
  scheduledT: SimTime
}

/**
 * Lead times, in seconds before the moment they anticipate. Chosen so a Halt
 * plays in the order a platform actually sounds: approach PA, brakes, arrival,
 * departure PA, doors, horn, then the in-Rake callout as it pulls away.
 *
 * Every one of them is clamped inside the Service's own timings (see
 * cuesForStop), so a 0-second Dwell or a very short leg compresses the
 * sequence rather than firing a Cue before the train could be there.
 */
const APPROACH_ANNOUNCE_LEAD_S = 45
const APPROACH_CALLOUT_LEAD_S = 40
const TERMINUS_CALLOUT_LEAD_S = 40
const BRAKE_LEAD_S = 15
const DEPARTURE_ANNOUNCE_LEAD_S = 12
const DOOR_CLOSE_LEAD_S = 3
const DEPARTURE_CALLOUT_DELAY_S = 5

/** Ties broken the same way every time, so two Cues at one second keep a stable order. */
const KIND_ORDER: CueKind[] = [
  'announce-approach',
  'brake',
  'callout-approach',
  'callout-terminus',
  'announce-departure',
  'door-close',
  'horn',
  'callout-departure',
]
const kindRank = new Map(KIND_ORDER.map((k, i) => [k, i]))

/**
 * Every Cue the whole service day calls for, sorted by time.
 *
 * Built once, not per frame: expanding ~1,350 Services costs far too much to
 * redo 60 times a second, and the answer never changes. cuesBetween() then
 * takes a window out of it by binary search.
 */
export function buildCueStream(network: NetworkData, timetables: Timetable[]): Cue[] {
  const cues: Cue[] = []
  for (const tt of timetables) {
    const terminusId = tt.stops[tt.stops.length - 1].id
    for (let i = 0; i < tt.stops.length; i++) {
      cuesForStop(network, tt, i, terminusId, cues)
    }
  }
  cues.sort(
    (a, b) =>
      a.t - b.t ||
      kindRank.get(a.kind)! - kindRank.get(b.kind)! ||
      (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0),
  )
  return cues
}

function cuesForStop(
  network: NetworkData,
  tt: Timetable,
  i: number,
  terminusId: string,
  out: Cue[],
): void {
  const { def, stops } = tt
  const stop = stops[i]
  const isOrigin = i === 0
  const isTerminus = i === stops.length - 1
  // An arriving Cue must not sound before the Service left the Halt before it,
  // and a departing one must not sound before this Halt's own arrival.
  const earliestArrival = isOrigin ? stop.arriveT : stops[i - 1].departT
  const arriving = (lead: number) => Math.max(earliestArrival, stop.arriveT - lead)
  const departing = (lead: number) => Math.max(stop.arriveT, stop.departT - lead)

  const base = {
    serviceId: def.id,
    serviceType: def.serviceType,
    direction: def.direction,
    lineId: def.lineId,
    stationId: stop.id,
    chainageM: stop.chainageM,
    terminusId,
    // The Service's booked time here is its arrival, except at the origin,
    // where the printed time is the departure and the Dwell precedes it.
    scheduledT: isOrigin ? stop.departT : stop.arriveT,
  }
  const face = faceForHalt(network, def.lineId, stop.chainageM)

  // Arriving. The origin is not an arrival: the rake starts there, so nobody
  // announces it in and nothing brakes.
  if (!isOrigin) {
    out.push({
      ...base,
      kind: 'announce-approach',
      t: arriving(APPROACH_ANNOUNCE_LEAD_S),
      faceTrack: face,
    })
    out.push({
      ...base,
      kind: 'brake',
      t: arriving(BRAKE_LEAD_S),
      faceTrack: null,
    })
    out.push({
      ...base,
      kind: isTerminus ? 'callout-terminus' : 'callout-approach',
      t: arriving(isTerminus ? TERMINUS_CALLOUT_LEAD_S : APPROACH_CALLOUT_LEAD_S),
      faceTrack: null,
    })
  }

  // Departing. The terminus is not a departure: the run is over there.
  if (isTerminus) return
  out.push({
    ...base,
    kind: 'announce-departure',
    t: departing(DEPARTURE_ANNOUNCE_LEAD_S),
    faceTrack: face,
  })
  out.push({
    ...base,
    kind: 'door-close',
    t: departing(DOOR_CLOSE_LEAD_S),
    faceTrack: null,
  })
  out.push({ ...base, kind: 'horn', t: stop.departT, faceTrack: null })
  // The in-Rake callout names where it is going, so it carries the *next*
  // Halt, not this one, and sounds once the train is moving.
  const next = stops[i + 1]
  out.push({
    ...base,
    kind: 'callout-departure',
    t: stop.departT + DEPARTURE_CALLOUT_DELAY_S,
    stationId: next.id,
    chainageM: next.chainageM,
    scheduledT: next.arriveT,
    faceTrack: null,
  })
}

/**
 * The Cues in [fromT, toT) — half-open, so a consumer feeding one frame's
 * window straight into the next neither drops a Cue on the boundary nor plays
 * one twice.
 *
 * A window that runs backwards (the clock was dragged back) or does not move
 * yields nothing. Sim speed is not this function's business: above 1x the
 * consumer simply stops asking, which is the whole reason the seam is a
 * window rather than a subscription.
 */
export function cuesBetween(stream: Cue[], fromT: SimTime, toT: SimTime): Cue[] {
  if (!(toT > fromT)) return []
  return stream.slice(lowerBound(stream, fromT), lowerBound(stream, toT))
}

/** First index with t >= target. */
function lowerBound(stream: Cue[], target: SimTime): number {
  let lo = 0
  let hi = stream.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stream[mid].t < target) lo = mid + 1
    else hi = mid
  }
  return lo
}
