/**
 * The voice budget: how many positional sounds may be alive at once, and who
 * loses when more are asked for.
 *
 * A real service day calls for far more sound than a browser should mix —
 * 08:40 has dozens of Services inside earshot, each with a horn, brakes and a
 * Platform Face announcing. Without a cap the mix turns to mush and the frame
 * rate goes with it. The cap is small on purpose, for the same reason coarse
 * pointers already get fewer pixels and fewer buildings.
 *
 * The one exemption is the Service being followed. It is what the viewer is
 * looking at, so it never loses its slot to nearer traffic — a horn from the
 * train you are riding matters more than a horn from one you are not.
 */
import { audioGraph } from './audio'
import { IS_COARSE_POINTER } from './config'

export const VOICE_BUDGET = IS_COARSE_POINTER ? 3 : 6

/**
 * Sounds carry a long way across open ground, but the scene is exaggerated
 * 5x sideways, so distances here are scene metres and the rolloff is tuned to
 * them rather than to real acoustics.
 */
const REF_DISTANCE = 120
const MAX_DISTANCE = 6000
const ROLLOFF = 1.1

interface Voice {
  source: AudioBufferSourceNode
  gain: GainNode
  /** Distance from the listener when it started, for deciding who is cut. */
  distance: number
  /** The followed Service's own sound, which is never cut. */
  keep: boolean
}

const voices = new Set<Voice>()

export interface VoiceRequest {
  buffer: AudioBuffer
  /**
   * Where it happens, in scene space — or null for a sound heard from inside
   * the train you are riding, which has no position relative to you.
   */
  position: [number, number, number] | null
  /** Distance from the listener, which the caller already knows. */
  distance: number
  /** True for the followed Service: exempt from culling. */
  keep?: boolean
  volume?: number
}

/**
 * Play a positional sound, or decline to. Returns false when the budget is
 * full of sounds that all beat this one — the caller does not retry, because
 * a Cue that lost its slot is a Cue that was too far away to matter.
 */
export function playVoice(req: VoiceRequest): boolean {
  const graph = audioGraph()
  if (!graph) return false
  if (voices.size >= VOICE_BUDGET && !makeRoom(req)) return false

  const { ctx, input } = graph
  let panner: PannerNode | null = null
  if (req.position) {
    panner = ctx.createPanner()
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    panner.refDistance = REF_DISTANCE
    panner.maxDistance = MAX_DISTANCE
    panner.rolloffFactor = ROLLOFF
    panner.positionX.value = req.position[0]
    panner.positionY.value = req.position[1]
    panner.positionZ.value = req.position[2]
  }

  const gain = ctx.createGain()
  gain.gain.value = req.volume ?? 1
  const source = ctx.createBufferSource()
  source.buffer = req.buffer
  source.connect(gain)
  if (panner) gain.connect(panner).connect(input)
  else gain.connect(input)

  const voice: Voice = { source, gain, distance: req.distance, keep: req.keep === true }
  voices.add(voice)
  source.onended = () => {
    voices.delete(voice)
    try {
      source.disconnect()
      gain.disconnect()
      panner?.disconnect()
    } catch {
      // Already torn down by a cull; nothing to do.
    }
  }
  source.start()
  return true
}

/**
 * Evict the most distant voice, if the newcomer is nearer than it. Distance
 * decides rather than age, so a horn right beside the camera can take a slot
 * from one half the line away, and a queue of far-off traffic can never crowd
 * out what is happening in front of the viewer.
 */
function makeRoom(req: VoiceRequest): boolean {
  let worst: Voice | null = null
  for (const voice of voices) {
    if (voice.keep) continue
    if (!worst || voice.distance > worst.distance) worst = voice
  }
  if (!worst) return false
  if (!req.keep && worst.distance <= req.distance) return false
  stop(worst)
  return true
}

function stop(voice: Voice): void {
  voices.delete(voice)
  const graph = audioGraph()
  if (graph) {
    // Ramp rather than cut: stopping a source mid-waveform clicks.
    const { ctx } = graph
    voice.gain.gain.cancelScheduledValues(ctx.currentTime)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime)
    voice.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05)
    voice.source.stop(ctx.currentTime + 0.06)
    return
  }
  voice.source.stop()
}

/** How many voices are sounding right now, for window.simAudio. */
export function liveVoices(): number {
  return voices.size
}

/** Silence everything positional — used when sound is muted. */
export function stopAllVoices(): void {
  for (const voice of [...voices]) stop(voice)
}
