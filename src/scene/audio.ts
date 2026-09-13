/**
 * The audio graph everything else hangs off: one listener on the camera, one
 * master gain, and a mute that means it.
 *
 * Sound starts muted and nothing is fetched until it is unmuted — browsers
 * refuse to start audio before a user gesture anyway, so the toggle is forced
 * rather than a preference, and it doubles as the promise that a visitor who
 * never presses it pays nothing for the sound layer. The choice survives a
 * reload; the audio graph is built the first time it is turned on and then
 * simply muted and unmuted, because a context created per toggle would be a
 * new one every time and lose whatever was playing.
 */
import type { Camera } from 'three'
import { AudioListener } from 'three'

const STORAGE_KEY = 'mumbai-local-sim:sound'

/** Master volume when unmuted. One knob: a per-category mixer can wait until
 * the mix proves it needs one. */
const DEFAULT_VOLUME = 0.7

/** A mute or unmute is a level change, never a hard cut — 150 ms is short
 * enough to feel instant and long enough not to click. */
const FADE_S = 0.15

function storedMuted(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(STORAGE_KEY) !== 'on'
}

let listener: AudioListener | null = null
const watchers = new Set<() => void>()

export const sound = {
  muted: storedMuted(),
  volume: DEFAULT_VOLUME,

  setMuted(muted: boolean) {
    sound.muted = muted
    try {
      localStorage.setItem(STORAGE_KEY, muted ? 'off' : 'on')
    } catch {
      // Private browsing refuses writes; the toggle still works for this visit.
    }
    applyGain()
    for (const w of watchers) w()
  },

  /** Fires when the mute state changes, so the toggle button and the Bed
   * both hear about it without either owning the other. */
  watch(fn: () => void): () => void {
    watchers.add(fn)
    return () => {
      watchers.delete(fn)
    }
  },
}

function applyGain(): void {
  if (!listener) return
  const ctx = listener.context
  const target = sound.muted ? 0 : sound.volume
  const gain = listener.getInput().gain
  gain.cancelScheduledValues(ctx.currentTime)
  gain.setValueAtTime(gain.value, ctx.currentTime)
  gain.linearRampToValueAtTime(target, ctx.currentTime + FADE_S)
}

/**
 * The listener, built on demand. Attaching it to the camera is what makes
 * positional sound work at all: three keeps the AudioContext's listener pose
 * in step with the camera as it flies, so a horn heard from the lineside pans
 * past on its own.
 */
export function ensureListener(camera: Camera): AudioListener {
  if (!listener) {
    listener = new AudioListener()
    listener.getInput().gain.value = sound.muted ? 0 : sound.volume
  }
  if (listener.parent !== camera) camera.add(listener)
  resumeContext(listener.context as AudioContext)
  return listener
}

/**
 * Browsers hand back a suspended context when it was created outside a user
 * gesture. The unmute click is one, so the usual path resumes immediately —
 * but a returning visitor arrives already unmuted, having gestured on a
 * previous visit and not yet on this one, and their sound would otherwise
 * never start. Wait for the next click or key instead of asking them to
 * toggle something they have already set.
 */
function resumeContext(ctx: AudioContext): void {
  if (ctx.state !== 'suspended') return
  void ctx.resume()
  const onGesture = () => {
    void ctx.resume()
    window.removeEventListener('pointerdown', onGesture)
    window.removeEventListener('keydown', onGesture)
  }
  window.addEventListener('pointerdown', onGesture)
  window.addEventListener('keydown', onGesture)
}

/** The live graph, or null while sound has never been turned on. */
export function audioGraph(): { ctx: AudioContext; input: GainNode } | null {
  if (!listener) return null
  return { ctx: listener.context as AudioContext, input: listener.getInput() }
}

/**
 * Fetch and decode one asset. Deliberately not called until unmute: the
 * promise this ticket makes is that time to first frame is untouched, and a
 * prefetched Bed would break it however small it is.
 */
const decoded = new Map<string, Promise<AudioBuffer>>()

export function loadClip(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const cached = decoded.get(url)
  if (cached) return cached
  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.arrayBuffer()
    })
    .then((bytes) => ctx.decodeAudioData(bytes))
    .catch((err) => {
      // A missing clip silences one layer; it must never take the scene down.
      decoded.delete(url)
      throw err
    })
  decoded.set(url, promise)
  return promise
}

/** Assets fetched so far, for the "nothing downloads until unmute" check. */
export function loadedClips(): string[] {
  return [...decoded.keys()]
}
