/**
 * What a Rake sounds like: traction, rail joints, horn, brakes, flange squeal.
 *
 * Synthesised, not sampled, because all of it is a function of motion. Traction
 * pitch and joint rate follow speed continuously, and a recording pitch-shifted
 * to match sounds exactly like a recording pitch-shifted to match. The Bed
 * (#28) covers what is static; this covers what moves.
 *
 * The numbers are measured rather than invented. A 76-minute real-time cab run
 * Churchgate → Virar (data/audio-reference/, never shipped) gives:
 *
 *   horn      337 Hz and ~364 Hz sounded together — the beat between them is
 *             the growl — with the 2nd harmonic louder than the fundamental,
 *             partials out to 8x, and a 0.32 s blast
 *   traction  strongest partial sweeping 118-315 Hz across the ride
 *   joints    envelope rhythm 1.7 Hz at speed, which is 22 m/s over 13 m rail
 *             panels: the standard Indian jointed-track length, confirmed
 *   squeal    a resonance at 3.71-3.72 kHz recurring at seven separate points,
 *             20-48x above its usual level, with a second at 5.7 kHz
 *
 * One thing deliberately not modelled: a constant 1830 Hz tone runs through the
 * whole cab recording at 2000x the median level. It does not vary with speed,
 * so it is the recording rig rather than the train. Reproducing it would be
 * faithfully simulating someone's camera.
 */

/** Rail panel length on jointed track. The clack rate is speed divided by this. */
export const RAIL_PANEL_M = 13

/** Traction fundamental at a standstill and at line speed, from the cab run. */
const TRACTION_MIN_HZ = 110
const TRACTION_MAX_HZ = 320
/**
 * Where the traction sweep tops out. Real WR line speed rather than the
 * synthetic scheduler's cruise (VMAX_MPS): the real timetable's fast legs
 * genuinely run quicker than that, and clamping them all to one pitch loses
 * the difference between a fast and a slow.
 */
const TOP_SPEED_MPS = 25

/** Traction pitch for a speed: the sweep the cab recording shows, mapped onto
 * the stock's own speed range. */
export function tractionHzFor(speedMps: number): number {
  const fraction = Math.min(1, Math.max(0, speedMps / TOP_SPEED_MPS))
  return TRACTION_MIN_HZ + fraction * (TRACTION_MAX_HZ - TRACTION_MIN_HZ)
}

const HORN_F1 = 337
const HORN_F2 = 364
const HORN_BLAST_S = 0.55
const SQUEAL_HZ = 3715
const SQUEAL_SECOND_HZ = 5700

/**
 * One-shots, rendered once and reused. Each is cheap to build and identical
 * every time, so there is no reason to pay for it twice.
 */
const cache = new Map<string, AudioBuffer>()

function cached(key: string, build: () => AudioBuffer): AudioBuffer {
  const hit = cache.get(key)
  if (hit) return hit
  const made = build()
  cache.set(key, made)
  return made
}

/**
 * The horn: two tones a beat apart, harmonics weighted as measured — the 2nd
 * above the 1st, the 3rd nearly absent, the rest tailing off. That weighting is
 * what separates a train horn from an organ note.
 */
export function hornBuffer(ctx: AudioContext): AudioBuffer {
  return cached('horn', () => {
    const rate = ctx.sampleRate
    const length = Math.ceil(HORN_BLAST_S * rate)
    const buffer = ctx.createBuffer(1, length, rate)
    const out = buffer.getChannelData(0)
    // Measured partial levels, in dB below the loudest.
    const partials: [number, number][] = [
      [1, -1.5],
      [2, 0],
      [3, -20],
      [4, -2.4],
      [5, -8],
      [6, -8.7],
      [7, -12.6],
      [8, -9],
    ]
    for (let i = 0; i < length; i++) {
      const t = i / rate
      let v = 0
      for (const [n, db] of partials) {
        const gain = Math.pow(10, db / 20)
        v += gain * (Math.sin(2 * Math.PI * HORN_F1 * n * t) + Math.sin(2 * Math.PI * HORN_F2 * n * t))
      }
      // Quick on, held, released — a driver leaning on it, not a bell.
      const attack = Math.min(1, t / 0.02)
      const release = Math.min(1, (HORN_BLAST_S - t) / 0.08)
      out[i] = 0.12 * v * attack * Math.max(0, release)
    }
    return buffer
  })
}

/**
 * One rail joint: a wideband knock, gone in a tenth of a second. Built once and
 * retriggered — the rhythm carries the speed, not the sound of a single clack.
 */
export function clackBuffer(ctx: AudioContext): AudioBuffer {
  return cached('clack', () => {
    const rate = ctx.sampleRate
    const length = Math.ceil(0.12 * rate)
    const buffer = ctx.createBuffer(1, length, rate)
    const out = buffer.getChannelData(0)
    // Deterministic noise: a fixed sequence, so every clack is the same clack
    // and the sim stays reproducible.
    let seed = 0x2f6e2b1
    const noise = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return (seed / 0xffffffff) * 2 - 1
    }
    let low = 0
    for (let i = 0; i < length; i++) {
      const t = i / rate
      const n = noise()
      // One-pole smoothing pulls the hiss down into the knock's band.
      low += (n - low) * 0.45
      const body = Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t / 0.012)
      out[i] = (low * 1.4 * Math.exp(-t / 0.035) + body * 0.5) * 0.5
    }
    return buffer
  })
}

/**
 * Brakes biting: the measured resonance and its partner, swelling as the shoes
 * load up and stopping when the train does.
 */
export function brakeBuffer(ctx: AudioContext): AudioBuffer {
  return cached('brake', () => {
    const rate = ctx.sampleRate
    const seconds = 1.6
    const length = Math.ceil(seconds * rate)
    const buffer = ctx.createBuffer(1, length, rate)
    const out = buffer.getChannelData(0)
    // Phase is integrated rather than computed as f*t, because the wobble makes
    // the frequency time-varying: multiplying a moving frequency by t deepens
    // the modulation the longer it runs, and a 0.8% waver turns into a siren.
    let phase = 0
    let phase2 = 0
    for (let i = 0; i < length; i++) {
      const t = i / rate
      const p = t / seconds
      // Squeal wanders slightly — a dead-steady tone reads as electronic.
      const wobble = 1 + 0.008 * Math.sin(2 * Math.PI * 6.5 * t)
      phase += (2 * Math.PI * SQUEAL_HZ * wobble) / rate
      phase2 += (2 * Math.PI * SQUEAL_SECOND_HZ * wobble) / rate
      const main = Math.sin(phase)
      const second = 0.35 * Math.sin(phase2)
      // In over half a second, out over the last third.
      const env = Math.min(1, p / 0.35) * Math.min(1, (1 - p) / 0.3)
      out[i] = 0.13 * (main + second) * env
    }
    return buffer
  })
}

/**
 * The continuous half: traction and rail joints for one Rake, pitched and paced
 * by its own speed, positioned wherever it currently is.
 *
 * Live nodes rather than a rendered buffer, because these never stop changing:
 * a rake accelerating out of Dadar sweeps its traction pitch and its joint rate
 * together, and that coupling is most of what makes it read as a train.
 */
export class RunningSound {
  private traction: OscillatorNode
  private harmonic: OscillatorNode
  private tractionGain: GainNode
  private harmonicGain: GainNode
  private flange: OscillatorNode
  private flangeGain: GainNode
  private panner: PannerNode
  private master: GainNode
  private nextClackAt: number
  private stopped = false

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
    private clack: AudioBuffer,
  ) {
    this.panner = ctx.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.panner.refDistance = 150
    this.panner.maxDistance = 4000
    this.panner.rolloffFactor = 1.3

    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(this.panner).connect(destination)

    this.traction = ctx.createOscillator()
    this.traction.type = 'sawtooth'
    this.tractionGain = ctx.createGain()
    this.tractionGain.gain.value = 0.18
    this.traction.connect(this.tractionGain).connect(this.master)

    // A second partial an octave up, which is where the measured traction
    // energy actually sits at speed.
    this.harmonic = ctx.createOscillator()
    this.harmonic.type = 'triangle'
    this.harmonicGain = ctx.createGain()
    this.harmonicGain.gain.value = 0.08
    this.harmonic.connect(this.harmonicGain).connect(this.master)

    this.flange = ctx.createOscillator()
    this.flange.type = 'sine'
    this.flange.frequency.value = SQUEAL_HZ
    this.flangeGain = ctx.createGain()
    this.flangeGain.gain.value = 0
    this.flange.connect(this.flangeGain).connect(this.master)

    this.traction.start()
    this.harmonic.start()
    this.flange.start()
    this.nextClackAt = ctx.currentTime
  }

  /**
   * Follow one Rake for a frame.
   *
   * @param position  where it is, in scene space
   * @param speedMps  its own speed, straight from the sim
   * @param curvature heading change per metre of track under it, for flange squeal
   * @param volume    0 while inaudible, up to 1 riding it
   */
  update(
    position: [number, number, number],
    speedMps: number,
    curvature: number,
    volume: number,
  ): void {
    if (this.stopped) return
    const now = this.ctx.currentTime
    const ramp = 0.08
    this.panner.positionX.setTargetAtTime(position[0], now, ramp)
    this.panner.positionY.setTargetAtTime(position[1], now, ramp)
    this.panner.positionZ.setTargetAtTime(position[2], now, ramp)

    const fraction = Math.min(1, Math.max(0, speedMps / TOP_SPEED_MPS))
    const hz = tractionHzFor(speedMps)
    this.traction.frequency.setTargetAtTime(hz, now, 0.12)
    this.harmonic.frequency.setTargetAtTime(hz * 2, now, 0.12)
    // A standing rake is not silent, but it is close; everything grows with speed.
    this.master.gain.setTargetAtTime(volume * (0.25 + 0.75 * fraction), now, 0.15)

    // Flange squeal comes out of the geometry the track is drawn from, not a
    // list of stations with curves. Below walking-pace curvature does nothing,
    // and a stationary rake never squeals.
    const squeal = Math.min(1, Math.max(0, (curvature - 0.0018) / 0.004)) * fraction
    this.flangeGain.gain.setTargetAtTime(0.05 * squeal, now, 0.25)

    this.scheduleClacks(speedMps, now)
  }

  /**
   * Joints arrive at speed ÷ 13 m. Scheduled a little ahead of the clock so the
   * rhythm is sample-accurate rather than frame-accurate — at line speed a
   * frame's jitter is audible as a stumble.
   */
  private scheduleClacks(speedMps: number, now: number): void {
    if (speedMps < 1.5) {
      this.nextClackAt = Math.max(this.nextClackAt, now)
      return
    }
    const interval = RAIL_PANEL_M / speedMps
    const horizon = now + 0.35
    while (this.nextClackAt < horizon) {
      if (this.nextClackAt < now) this.nextClackAt = now
      const source = this.ctx.createBufferSource()
      source.buffer = this.clack
      const gain = this.ctx.createGain()
      // Louder and sharper the faster it runs.
      gain.gain.value = 0.35 + 0.65 * Math.min(1, speedMps / TOP_SPEED_MPS)
      source.connect(gain).connect(this.master)
      source.start(this.nextClackAt)
      source.onended = () => {
        source.disconnect()
        gain.disconnect()
      }
      this.nextClackAt += interval
    }
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(this.master.gain.value, now)
    this.master.gain.linearRampToValueAtTime(0, now + 0.12)
    for (const osc of [this.traction, this.harmonic, this.flange]) osc.stop(now + 0.15)
    setTimeout(() => {
      this.master.disconnect()
      this.panner.disconnect()
    }, 300)
  }
}
