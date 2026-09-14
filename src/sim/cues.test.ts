import { describe, expect, it } from 'vitest'
import westernJson from '../data/western.json'
import realTimetableJson from '../data/western-real-timetable.json'
import type { NetworkData } from '../data/network-types'
import { buildCueStream, cuesBetween, FACE_CUES, type Cue, type CueKind } from './cues'
import { faceForHalt } from './platforms'
import { buildRealTimetable, DWELL_S, type Timetable } from './simulate'
import { LINE_SLOW_UP, type Direction, type ServiceType } from './types'

const network = westernJson as NetworkData

interface RealServiceJson {
  id: string
  serviceType: ServiceType
  direction: Direction
  lineId: number
  stops: { stationId: string; t: number }[]
}
const realServices = (realTimetableJson as { services: RealServiceJson[] }).services
const timetables: Timetable[] = realServices.map((svc) =>
  buildRealTimetable(network, svc, svc.stops),
)
const stream = buildCueStream(network, timetables)

const nameOf = (id: string) => network.stations.find((s) => s.id === id)!.name
const idOf = (name: string) => network.stations.find((s) => s.name === name)!.id

/** Every Cue one Service calls for, in the order it calls for them. */
function cuesOf(tt: Timetable): Cue[] {
  return buildCueStream(network, [tt])
}

/**
 * The Cues a Halt itself sounds. A departure Callout names the Halt ahead, so
 * it carries that Halt's id while belonging to the departure from the one
 * before — it is listed with the Halt it is fired from, not the one it names.
 */
const kindsAt = (cues: Cue[], stationId: string): CueKind[] =>
  cues.filter((c) => c.stationId === stationId && c.kind !== 'callout-departure').map((c) => c.kind)

describe('a Service through one Halt', () => {
  // A long Up Slow with plenty of intermediate Halts, so origin, middle and
  // terminus are all genuinely different cases.
  const tt = timetables.find((t) => t.def.lineId === LINE_SLOW_UP && t.stops.length > 10)!
  const cues = cuesOf(tt)
  const middle = tt.stops[3]

  it('sounds a Halt in the order a platform actually sounds', () => {
    expect(kindsAt(cues, middle.id)).toEqual([
      'announce-approach',
      'callout-approach',
      'brake',
      'announce-departure',
      'horn',
    ])
  })

  it('announces at the Face its Line runs on, and nowhere else', () => {
    const announce = cues.find((c) => c.stationId === middle.id && c.kind === 'announce-approach')!
    expect(announce.faceTrack).toBe(faceForHalt(network, tt.def.lineId, middle.chainageM))
    for (const c of cues) {
      if (FACE_CUES.has(c.kind)) expect(c.faceTrack, c.kind).not.toBeNull()
      else expect(c.faceTrack, c.kind).toBeNull()
    }
  })

  it('keeps every Cue inside the Dwell it belongs to', () => {
    for (const c of cues.filter(
      (x) => x.stationId === middle.id && x.kind !== 'callout-departure',
    )) {
      expect(c.t, c.kind).toBeGreaterThanOrEqual(middle.arriveT - 60)
      expect(c.t, c.kind).toBeLessThanOrEqual(middle.departT)
    }
  })
})

describe('origin and terminus', () => {
  const tt = timetables.find((t) => t.stops.length > 10)!
  const cues = cuesOf(tt)
  const origin = tt.stops[0]
  const terminus = tt.stops[tt.stops.length - 1]

  it('does not announce a Service into the Halt it starts from', () => {
    expect(kindsAt(cues, origin.id)).toEqual(['announce-departure', 'horn'])
  })

  it('gives a Service arriving at its last Halt a terminus Callout and no departure', () => {
    const kinds = kindsAt(cues, terminus.id)
    expect(kinds).toContain('callout-terminus')
    expect(kinds).not.toContain('callout-approach')
    expect(kinds).not.toContain('horn')
    expect(kinds).not.toContain('announce-departure')
    // Nothing at all sounds once a Service has reached its last Halt: the
    // approach Announcement, the terminus Callout and the brakes are all it
    // has left, and the run is over on arrival.
    expect(cues[cues.length - 1].t).toBeLessThan(terminus.arriveT)
    // The terminus is still named on the way in, by the Callout fired when
    // the Service left the Halt before it.
    const naming = cues.filter((c) => c.kind === 'callout-departure' && c.stationId === terminus.id)
    expect(naming.length).toBe(1)
    expect(naming[0].t).toBeLessThan(terminus.arriveT)
  })

  it('names the next Halt in the departure Callout, not the one being left', () => {
    const callout = cues.find((c) => c.kind === 'callout-departure')!
    expect(callout.t).toBeGreaterThan(origin.departT)
    expect(callout.stationId).toBe(tt.stops[1].id)
    expect(callout.scheduledT).toBe(tt.stops[1].arriveT)
  })

  it('carries the terminus on every Cue, so an Announcement can say "towards X"', () => {
    for (const c of cues) expect(c.terminusId).toBe(terminus.id)
  })
})

describe('doors', () => {
  it('never closes a door, because a Mumbai local never does', () => {
    // The doorways stay open the whole run, by design rather than neglect, so
    // the sound that ends a Dwell on other railways has no Cue here.
    for (const cue of stream) expect(cue.kind).not.toContain('door')
  })
})

describe('the whole service day', () => {
  it('announces an Up Service at an Up Face, never a Down one', () => {
    for (const c of stream) {
      if (c.faceTrack === null) continue
      const isUp = c.lineId % 2 === 1
      if (isUp) expect(c.faceTrack % 2, nameOf(c.stationId)).toBe(1)
      else expect(c.faceTrack % 2, nameOf(c.stationId)).toBe(0)
    }
  })

  it('is sorted, and a Cue never precedes its Service arriving anywhere', () => {
    for (let i = 1; i < stream.length; i++)
      expect(stream[i].t).toBeGreaterThanOrEqual(stream[i - 1].t)
  })

  it('gives Dadar a busy peak hour and a quiet small hour', () => {
    const dadar = idOf('Dadar')
    const at = (fromT: number) =>
      cuesBetween(stream, fromT, fromT + 3600).filter((c) => c.stationId === dadar).length
    expect(at(9 * 3600)).toBeGreaterThan(at(2 * 3600) + 100)
  })

  it('answers the same way every time it is asked', () => {
    const again = buildCueStream(network, timetables)
    expect(again.length).toBe(stream.length)
    const window = (s: Cue[]) => JSON.stringify(cuesBetween(s, 9 * 3600, 9 * 3600 + 120))
    expect(window(again)).toBe(window(stream))
  })
})

describe('windows', () => {
  const FROM = 9 * 3600

  it('drops nothing and repeats nothing across adjacent windows', () => {
    const whole = cuesBetween(stream, FROM, FROM + 600)
    const pieces: Cue[] = []
    for (let t = FROM; t < FROM + 600; t += 17)
      pieces.push(...cuesBetween(stream, t, Math.min(t + 17, FROM + 600)))
    expect(pieces).toEqual(whole)
  })

  it('splits a Dwell across a window boundary without losing the Cues inside it', () => {
    // Land a boundary in the middle of a real Dwell and check the Halt's Cues
    // arrive exactly once between the two windows.
    const tt = timetables.find((t) => t.stops.length > 10)!
    const stop = tt.stops[3]
    const mid = stop.arriveT + DWELL_S / 2
    const own = cuesOf(tt).filter((c) => c.stationId === stop.id && c.kind !== 'callout-departure')
    const before = cuesBetween(cuesOf(tt), stop.arriveT - 60, mid)
    const after = cuesBetween(cuesOf(tt), mid, stop.departT + 1)
    const seen = [...before, ...after].filter(
      (c) => c.stationId === stop.id && c.kind !== 'callout-departure',
    )
    expect(seen).toEqual(own)
  })

  it('yields nothing for a window that stands still or runs backwards', () => {
    expect(cuesBetween(stream, FROM, FROM)).toEqual([])
    expect(cuesBetween(stream, FROM, FROM - 60)).toEqual([])
  })

  it('costs nothing to ask for a frame of Cues', () => {
    // 60 fps means this runs 60 times a second: it must be a binary search on
    // a prebuilt stream, not a scan of ~1,350 Services.
    const start = performance.now()
    for (let i = 0; i < 2000; i++) cuesBetween(stream, FROM + i * 0.016, FROM + (i + 1) * 0.016)
    expect(performance.now() - start).toBeLessThan(50)
  })
})
