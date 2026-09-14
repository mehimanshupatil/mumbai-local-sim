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
import { audioGraph, sound } from './audio'
import { simClock } from './sim-clock'
import { brakeBuffer, clackBuffer, hornBuffer } from './train-sound'
import { playVoice, VOICE_BUDGET } from './voices'

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

  /** Sound on or off, same switch as the speaker button. */
  muted: () => sound.muted,
  setMuted: (muted: boolean) => sound.setMuted(muted),
  /** Positional sounds alive right now, against the budget. */
  voices: 0,
  /** Rakes currently being synthesised continuously (traction, joints). */
  running: 0,
  /**
   * What each of those Rakes is doing right now: its own speed, the traction
   * pitch that speed produces, the rail-joint rate, and the curvature under it.
   * Everything in #32 is a function of motion, so this is the only way to check
   * that the function is actually being applied.
   */
  runningInfo: [] as {
    id: string
    speedMps: number
    tractionHz: number
    clackHz: number
    curvature: number
  }[],
  budget: VOICE_BUDGET,
  /** Audio assets fetched so far — zero until the first unmute, by design. */
  clips: 0,
  /** What the Bed is answering to: Services within earshot, and the sim hour. */
  nearby: 0,
  hour: 0,

  /** Speech this run: what was said, how long it ran, and whether it got a slot. */
  spoken: 0,
  lastSpeech: null as null | {
    kind: string
    serviceId: string
    stationId: string
    faceTrack: number | null
    seconds: number
    distance: number
    played: boolean
  },

  /**
   * What is actually coming out, as RMS over a short sample. Sound is the one
   * layer with nothing to look at, so this is the equivalent of a screenshot:
   * it answers "is the Bed audible" without anyone having to listen.
   */
  async level(ms = 300): Promise<number> {
    const graph = audioGraph()
    if (!graph) return 0
    const { ctx, input } = graph
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    input.connect(analyser)
    await new Promise((resolve) => setTimeout(resolve, ms))
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    input.disconnect(analyser)
    let sum = 0
    for (const v of samples) sum += v * v
    return Math.sqrt(sum / samples.length)
  },

  /**
   * Play one synthesised train sound on its own, at the listener, so its own
   * spectrum can be read without the Bed and the traction on top of it.
   */
  preview(kind: 'horn' | 'brake' | 'clack'): boolean {
    const graph = audioGraph()
    if (!graph || sound.muted) return false
    const build = { horn: hornBuffer, brake: brakeBuffer, clack: clackBuffer }[kind]
    return playVoice({ buffer: build(graph.ctx), position: null, distance: 0 })
  },

  /**
   * The loudest partials coming out, in Hz. Sound has nothing to look at, and
   * level() only says how much — this says what, which is how a traction pitch
   * that should track speed gets checked without ears.
   */
  async spectrum(ms = 300, count = 6): Promise<{ hz: number; rel: number }[]> {
    const graph = audioGraph()
    if (!graph) return []
    const { ctx, input } = graph
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 8192
    analyser.smoothingTimeConstant = 0.6
    input.connect(analyser)
    await new Promise((resolve) => setTimeout(resolve, ms))
    const bins = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(bins)
    input.disconnect(analyser)
    const hzPerBin = ctx.sampleRate / analyser.fftSize
    const peaks: { hz: number; rel: number }[] = []
    for (let i = 2; i < bins.length - 1; i++) {
      if (bins[i] > bins[i - 1] && bins[i] >= bins[i + 1]) {
        peaks.push({ hz: Math.round(i * hzPerBin), rel: Math.round(bins[i] * 10) / 10 })
      }
    }
    return peaks.sort((a, b) => b.rel - a.rel).slice(0, count)
  },

  /**
   * Fire n positional test sounds at increasing distances and report how many
   * the budget let through. Audio has nothing to look at, so this is how the
   * cap gets verified without counting horns by ear.
   */
  testVoices(n = 10): number {
    const graph = audioGraph()
    if (!graph || sound.muted) return 0
    const { ctx } = graph
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin((i / ctx.sampleRate) * 2 * Math.PI * 440) * 0.05
    }
    let played = 0
    for (let i = 0; i < n; i++) {
      const distance = 200 + i * 400
      if (playVoice({ buffer, position: [distance, 0, 0], distance })) played++
    }
    return played
  },
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

/**
 * Record what the PA just said, for the console. Audio leaves no trace on
 * screen, so without this there is no way to check that the right Service
 * announced at the right Face at the right second.
 */
export function noteSpeech(cue: Cue, seconds: number, distance: number, played: boolean): void {
  if (played) simAudio.spoken++
  simAudio.lastSpeech = {
    kind: cue.kind,
    serviceId: cue.serviceId,
    stationId: cue.stationId,
    faceTrack: cue.faceTrack,
    seconds: Math.round(seconds * 100) / 100,
    distance: Math.round(distance),
    played,
  }
}
