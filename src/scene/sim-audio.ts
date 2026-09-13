/**
 * The seam between the Cue stream and anything that makes a sound.
 *
 * The sim decides *what* the Timetable calls for and *when* (src/sim/cues.ts);
 * this drives it in real time, handing each crossed Cue to whoever is
 * listening. It makes no sound itself — ticket #29 adds no audio at all — so
 * the Bed (#28), Announcements (#31) and train sound (#32) each register here
 * rather than each learning to read a Timetable.
 */
import { useFrame } from '@react-three/fiber'
import { cueStream } from '../app-data'
import { cuesBetween, type Cue } from '../sim/cues'
import { simClock } from './sim-clock'

export type CueListener = (cue: Cue) => void

const listeners = new Set<CueListener>()

/** Listen for Cues as the clock crosses them. Returns an unsubscribe. */
export function onCue(fn: CueListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Above 1x the clock crosses a Halt's whole sequence inside one frame, and a
 * 60x day is 24 minutes of machine-gun audio. Discrete Cues stop; #28's Bed
 * keeps cross-fading, since that is continuous and has no such problem.
 */
const MAX_SPEED = 1
/**
 * A window wider than this is a jump, not playback — the tab was backgrounded,
 * or the clock was resynced to IST — and replaying everything it skipped would
 * dump minutes of Cues into one frame.
 */
const MAX_WINDOW_S = 5
/** How many recent Cues window.simAudio keeps for inspection. */
const RECENT_CAP = 60

/**
 * Dev affordance, like window.simClock and window.setFocus: audio has nothing
 * to look at, so this is how a Cue gets checked from the console without
 * listening to it.
 */
export const simAudio = {
  /** The Cues just crossed, newest last. */
  recent: [] as Cue[],
  /** Cues this run has crossed in total. */
  crossed: 0,
  /** Whether the stream has finished building (see below — it is deferred). */
  ready: () => stream !== null,
  /** Everything the service day calls for, built on demand. */
  stream: () => cueStream(),
}

declare global {
  interface Window {
    simAudio?: typeof simAudio
  }
}

let stream: Cue[] | null = null
let building = false

/**
 * Build off the critical path. The stream costs ~130 ms to expand, and doing
 * that on the first frame would trade a visible hitch for audio nobody has
 * asked for yet.
 */
function ensureStream(): void {
  if (stream || building) return
  building = true
  const build = () => {
    stream = cueStream()
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 4000 })
  else setTimeout(build, 0)
}

/** Mount once inside the Canvas, alongside SimClockDriver. */
export function CueDriver() {
  useFrame(() => {
    const toT = simClock.t
    const fromT = lastT
    lastT = toT
    // In production there is nothing to drive until something registers; in
    // DEV the console listing is reason enough to keep the stream warm.
    if (listeners.size === 0 && !import.meta.env.DEV) return
    ensureStream()
    if (!stream) return
    if (simClock.speed > MAX_SPEED) return
    if (!(toT > fromT) || toT - fromT > MAX_WINDOW_S) return
    for (const cue of cuesBetween(stream, fromT, toT)) {
      simAudio.crossed++
      simAudio.recent.push(cue)
      for (const fn of listeners) fn(cue)
    }
    if (simAudio.recent.length > RECENT_CAP) {
      simAudio.recent.splice(0, simAudio.recent.length - RECENT_CAP)
    }
  })
  return null
}

let lastT = simClock.t

if (import.meta.env.DEV && typeof window !== 'undefined') window.simAudio = simAudio
