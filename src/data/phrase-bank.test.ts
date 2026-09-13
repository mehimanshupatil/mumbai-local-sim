/**
 * Invariants over the committed Phrase Bank, in the same spirit as
 * western.test.ts: the bake runs on one machine with Piper installed, and
 * everyone else just gets the artefact, so the artefact has to answer for
 * itself.
 */
import { describe, expect, it } from 'vitest'
import phraseBankJson from './phrase-bank.json'
import westernJson from './western.json'
import type { NetworkData } from './network-types'

interface Language {
  file: string
  voice: string
  licence: string
  sampleRate: number
  /** key → [start, duration] in seconds within the sprite. */
  fragments: Record<string, number[]>
  templates: Record<string, string[]>
}
const bank = phraseBankJson as unknown as { languages: Record<string, Language> }
const network = westernJson as NetworkData
const languages = Object.entries(bank.languages)

describe('the Phrase Bank', () => {
  it('speaks Marathi and English, and says so', () => {
    expect(Object.keys(bank.languages).sort()).toEqual(['en', 'mr'])
    // The Marathi voice's training data is share-alike; losing track of that
    // is how a licence obligation quietly goes unmet.
    expect(bank.languages.mr.licence).toContain('CC BY-SA')
  })

  it('can say every Station, in both languages', () => {
    for (const [lang, data] of languages) {
      for (const station of network.stations) {
        const fragment = data.fragments[`station.${station.id}`]
        expect(fragment, `${lang}: ${station.name}`).toBeDefined()
        expect(fragment[1], `${lang}: ${station.name}`).toBeGreaterThan(0.2)
      }
    }
  })

  it('can say any minute of any hour', () => {
    for (const [lang, data] of languages) {
      for (let n = 0; n < 60; n++) {
        expect(data.fragments[`num.${n}`], `${lang}: ${n}`).toBeDefined()
      }
    }
  })

  it('asks only for fragments it has', () => {
    // Templates name fixed fragments directly and leave placeholders for the
    // rest; a template naming a word nobody baked is a silent gap in a
    // sentence, which is exactly what this catches.
    for (const [lang, data] of languages) {
      for (const [name, tokens] of Object.entries(data.templates)) {
        for (const token of tokens) {
          if (token.startsWith('{')) continue
          expect(data.fragments[`word.${token}`], `${lang} ${name}: ${token}`).toBeDefined()
        }
      }
    }
  })

  it('names every kind of Service a Cue can carry', () => {
    for (const [lang, data] of languages) {
      for (const type of ['slow', 'fast', 'ac']) {
        expect(data.fragments[`word.type-${type}`], `${lang}: ${type}`).toBeDefined()
      }
    }
  })

  it('lays its fragments out in one sprite, in order and without overlap', () => {
    for (const [lang, data] of languages) {
      const spans = Object.values(data.fragments).sort((a, b) => a[0] - b[0])
      let end = 0
      for (const [start, duration] of spans) {
        expect(start, lang).toBeGreaterThanOrEqual(end)
        expect(duration, lang).toBeGreaterThan(0)
        end = start + duration
      }
      expect(data.file, lang).toBe(`audio/speech/${lang}.m4a`)
    }
  })
})
