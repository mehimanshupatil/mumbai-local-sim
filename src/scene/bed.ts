/**
 * The Bed: the continuous ambience under everything, at the listener rather
 * than anywhere in the world.
 *
 * Two things move it. The **hour** chooses the palette — birds before dawn,
 * street and traffic through the day, the turn at dusk, crickets at night —
 * and the palettes cross-fade into each other rather than switching. Live
 * **Service density** raises the crowd and traffic layers on top, so 08:40 in
 * the suburbs is audibly heaving and 02:00 is dead. That density is counted
 * off the real Timetable, not drawn as a curve: the sound thickens because
 * the trains are there.
 *
 * Each layer rotates through more than one recording, overlapping them at the
 * fades already baked into the clips (scripts/fetch-beds.sh), because a single
 * looping minute announces itself within about three passes.
 */
import { loadClip } from './audio'

const BASE = `${import.meta.env.BASE_URL}audio/beds/`

/** Hour palettes, in the order the day runs through them. */
const PALETTES = {
  dawn: ['dawn-birds', 'dawn-suburb'],
  day: ['day-street', 'day-traffic'],
  dusk: ['dusk-garden', 'dusk-turning'],
  night: ['night-crickets', 'night-alley'],
} as const

type Palette = keyof typeof PALETTES

/** Layers that ride on top of whatever palette is playing, driven by density. */
const CROWD = ['crowd-kharghar', 'crowd-kanpur']
const TRAFFIC = ['traffic-jam']

/**
 * Which palette an hour belongs to. Mumbai is close enough to the tropics
 * that the light — and the birds — keep nearly the same hours all year, which
 * is why these are fixed rather than tracking the daylight model.
 */
function paletteForHour(hour: number): Palette {
  if (hour < 5 || hour >= 21) return 'night'
  if (hour < 8) return 'dawn'
  if (hour < 17.5) return 'day'
  return 'dusk'
}

/** Real seconds a palette change takes. Long enough to be a turn of the day
 * rather than a switch, short enough to keep up at 60x. */
const PALETTE_FADE_S = 8
/** Density moves faster than the hour, so its layers follow faster. */
const LAYER_FADE_S = 3
/** Clips carry 2 s fades at both ends; overlapping by that much hides the seam. */
const OVERLAP_S = 2

const PALETTE_GAIN = 0.9
const CROWD_GAIN = 0.8
const TRAFFIC_GAIN = 0.55

/** Services within earshot for the crowd layer to reach full weight. */
const DENSE_SERVICES = 8

/**
 * One layer of the Bed: a gain the rest of the world sets, and behind it a
 * rotation of clips that keeps itself playing.
 */
class Layer {
  readonly gain: GainNode
  private index = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(
    private ctx: AudioContext,
    input: AudioNode,
    private slugs: readonly string[],
  ) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.gain.connect(input)
  }

  /** Ramp toward a weight, starting the clips the first time it is wanted. */
  setWeight(target: number, fadeS: number): void {
    const now = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(this.gain.gain.value, now)
    this.gain.gain.linearRampToValueAtTime(target, now + fadeS)
    // Nothing is fetched for a layer the hour has not reached yet: a visitor
    // who only ever watches the morning never downloads the crickets.
    if (target > 0 && !this.running) {
      this.running = true
      void this.playNext()
    }
  }

  private async playNext(): Promise<void> {
    if (!this.running) return
    const slug = this.slugs[this.index % this.slugs.length]
    this.index++
    let buffer: AudioBuffer
    try {
      buffer = await loadClip(this.ctx, `${BASE}${slug}.m4a`)
    } catch (err) {
      console.error(`bed layer ${slug} failed to load, staying silent:`, err)
      this.running = false
      return
    }
    if (!this.running) return
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    source.start()
    // Hand over before this clip's own fade-out finishes, so the two overlap
    // and the join is inaudible.
    const handoverMs = Math.max(1000, (buffer.duration - OVERLAP_S) * 1000)
    this.timer = setTimeout(() => void this.playNext(), handoverMs)
  }

  dispose(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.gain.disconnect()
  }
}

export class Bed {
  private palettes: Partial<Record<Palette, Layer>> = {}
  private crowd: Layer
  private traffic: Layer

  constructor(
    private ctx: AudioContext,
    private input: AudioNode,
  ) {
    this.crowd = new Layer(ctx, input, CROWD)
    this.traffic = new Layer(ctx, input, TRAFFIC)
  }

  /**
   * Follow the clock and the traffic. Called a few times a second rather than
   * per frame — nothing here moves fast enough to need more, and the ramps run
   * in the audio thread anyway.
   *
   * @param hour   sim hour, 0–24
   * @param nearby Services within earshot of the listener right now
   */
  update(hour: number, nearby: number): void {
    const wanted = paletteForHour(hour)
    if (!this.palettes[wanted]) {
      this.palettes[wanted] = new Layer(this.ctx, this.input, PALETTES[wanted])
    }
    for (const name of Object.keys(this.palettes) as Palette[]) {
      this.palettes[name]!.setWeight(name === wanted ? PALETTE_GAIN : 0, PALETTE_FADE_S)
    }

    const density = Math.min(1, nearby / DENSE_SERVICES)
    // Squared, because the ear hears a doubling of traffic as much less than
    // twice as much, and a linear map made 02:00 sound busier than it is.
    const weight = density * density
    this.crowd.setWeight(CROWD_GAIN * weight, LAYER_FADE_S)
    // Road traffic thins out at night whatever the trains are doing.
    const roadHour = wanted === 'night' ? 0.2 : wanted === 'day' ? 1 : 0.6
    this.traffic.setWeight(TRAFFIC_GAIN * roadHour * (0.35 + 0.65 * weight), LAYER_FADE_S)
  }

  dispose(): void {
    for (const layer of Object.values(this.palettes)) layer.dispose()
    this.crowd.dispose()
    this.traffic.dispose()
  }
}
