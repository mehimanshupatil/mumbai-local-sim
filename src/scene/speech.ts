/**
 * Saying the speech Cues out loud: the Phrase Bank (#30) meets the Cue stream
 * (#29).
 *
 * An Announcement is assembled here the way a real one is assembled on a real
 * platform — fragments end to end, Marathi first and then English, every time.
 * Word order comes out of the bank rather than out of this file: Marathi puts
 * the destination before the verb and English does not, and that is the
 * language's business, not the player's.
 *
 * What is never said is a platform number. ADR 0001 rules Face numbering out
 * of scope, and a voice claiming "platform number three" asserts far more than
 * a slab drawn on screen does.
 */
import phraseBankJson from '../data/phrase-bank.json'
import type { Cue, CueKind } from '../sim/cues'
import type { ServiceType } from '../sim/types'
import { loadClip } from './audio'

interface LanguageBank {
  file: string
  /** fragment key → [start, duration] in seconds within the sprite. */
  fragments: Record<string, number[]>
  templates: Record<string, string[]>
}

const BANK = (phraseBankJson as unknown as { languages: Record<string, LanguageBank> }).languages

/**
 * Marathi first, then English — the order every WR platform uses. Hindi
 * belongs between them and is absent for licensing reasons alone; see ADR
 * 0002. Adding it later means adding a bank, not changing this list.
 */
const LANGUAGES = ['mr', 'en'] as const

/** Cues this module knows how to say. */
const SPOKEN: ReadonlySet<CueKind> = new Set<CueKind>([
  'announce-approach',
  'announce-departure',
  'callout-departure',
  'callout-approach',
  'callout-terminus',
])

export function isSpoken(kind: CueKind): boolean {
  return SPOKEN.has(kind)
}

/** A beat between fragments, and a longer one between the two languages. */
const FRAGMENT_GAP_S = 0.07
const LANGUAGE_GAP_S = 0.55

/**
 * A breath before the first word, so an Announcement does not begin the
 * instant its Cue fires.
 *
 * This was room for a two-tone chime, on the assumption that a PA has one.
 * Checked against four real WR platform recordings and there is no chime on
 * the local network — the announcer simply starts talking. The gap stays,
 * much shorter, because the pause is real; the chime is not.
 */
const LEAD_IN_S = 0.25

const sprites = new Map<string, AudioBuffer>()

/**
 * Fetch both sprites. Two requests for the whole PA, and only once sound has
 * been turned on — nothing here runs for a muted visitor.
 */
export async function loadPhraseBank(ctx: AudioContext, baseUrl: string): Promise<void> {
  await Promise.all(
    LANGUAGES.map(async (lang) => {
      if (sprites.has(lang)) return
      sprites.set(lang, await loadClip(ctx, `${baseUrl}${BANK[lang].file}`))
    }),
  )
}

export function phraseBankReady(): boolean {
  return LANGUAGES.every((lang) => sprites.has(lang))
}

/**
 * The Service Type words the bank holds. A synthetic express runs on the
 * Through Lines and stops nowhere a local does, but to someone on a platform
 * it is simply the fast one going past, and the bank has no word of its own
 * for it.
 */
function typeKey(serviceType: ServiceType): string {
  return `word.type-${serviceType === 'express' ? 'fast' : serviceType}`
}

/**
 * Fragment keys for one Cue in one language, in the order the language says
 * them. A token the bank has no fragment for is dropped rather than faked:
 * English has no word for Marathi's "वाजून", and the template says so by
 * leaving the fragment empty.
 */
function keysFor(cue: Cue, lang: string): string[] {
  const bank = BANK[lang]
  const template = bank.templates[cue.kind]
  if (!template) return []
  const hour = Math.floor(cue.scheduledT / 3600) % 24
  const minute = Math.floor(cue.scheduledT / 60) % 60
  const keys: string[] = []
  for (const token of template) {
    let key: string
    switch (token) {
      case '{hour}':
        key = `num.${hour}`
        break
      case '{minute}':
        key = `num.${minute}`
        break
      case '{type}':
        key = typeKey(cue.serviceType)
        break
      case '{station}':
        // An Announcement names where the Service is going; a Callout names
        // the Halt it is about to reach.
        key = `station.${cue.kind.startsWith('announce') ? cue.terminusId : cue.stationId}`
        break
      default:
        key = `word.${token}`
    }
    if (bank.fragments[key]) keys.push(key)
  }
  return keys
}

/**
 * Cut the fragments out of the sprites and lay them end to end into one
 * buffer. One buffer rather than a scheduled chain of sources because the
 * voice budget then has a single thing to start, count and cut — a half-spoken
 * Announcement that loses its slot mid-sentence should stop, not leave three
 * orphaned words scheduled behind it.
 */
export function renderUtterance(ctx: AudioContext, cue: Cue): AudioBuffer | null {
  if (!phraseBankReady()) return null
  interface Part {
    sprite: AudioBuffer
    start: number
    duration: number
    /** Silence before this fragment: a beat between words, longer between languages. */
    gapS: number
  }
  const parts: Part[] = []
  let total = 0
  for (const lang of LANGUAGES) {
    const sprite = sprites.get(lang)
    if (!sprite) continue
    const keys = keysFor(cue, lang)
    for (const [i, key] of keys.entries()) {
      const [start, duration] = BANK[lang].fragments[key]
      // A breath before the first word; a language break ahead of the first
      // word of the second language.
      const gapS = parts.length === 0 ? LEAD_IN_S : i === 0 ? LANGUAGE_GAP_S : FRAGMENT_GAP_S
      parts.push({ sprite, start, duration, gapS })
      total += gapS + duration
    }
  }
  if (parts.length === 0) return null

  const rate = ctx.sampleRate
  const out = ctx.createBuffer(1, Math.ceil(total * rate), rate)
  const channel = out.getChannelData(0)
  let at = 0
  for (const part of parts) {
    at += Math.round(part.gapS * rate)
    const from = Math.round(part.start * rate)
    const count = Math.min(Math.round(part.duration * rate), part.sprite.length - from, channel.length - at)
    if (count > 0) {
      channel.set(part.sprite.getChannelData(0).subarray(from, from + count), at)
      at += count
    }
  }
  return out
}
