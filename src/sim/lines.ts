/**
 * Which physical Track a Line runs on, and where.
 *
 * This is sim, not rendering: the Route genuinely narrows from six Tracks to
 * two along its length, so on the two-Track stretch north of Virar a Fast and
 * a Slow Service in the same direction are on the *same rails*, whatever
 * Lines they are booked on. Only this layer knows a Section's real Track
 * count, so only this layer can say so.
 */
import type { TrackSection } from '../data/network-types'
import { LINE_FAST_DOWN, LINE_FAST_UP, LINE_THROUGH_DOWN, LINE_THROUGH_UP } from './types'

/** The track section containing a baked chainage. */
export function sectionAtChainage(sections: TrackSection[], chainageM: number): TrackSection {
  for (const s of sections) if (chainageM < s.toM) return s
  return sections[sections.length - 1]
}

/**
 * The Track a Line runs on where a Section has only so many. Narrow Sections
 * fold the Through Lines onto the Fast pair (Up first, so opposing Through
 * Services never share a Track), and the two-Track stretch folds everything
 * onto the single Up/Down pair.
 */
export function trackForLine(lineId: number, sectionTracks: number): number {
  const isUp = lineId % 2 === 1 // every *_UP constant is odd by construction
  if (sectionTracks >= 6) return lineId
  if (lineId === LINE_THROUGH_DOWN || lineId === LINE_THROUGH_UP) {
    // A lone 5th Track hosts Down Through Services; Up ones join the Fast pair.
    if (sectionTracks === 5 && !isUp) return 4
    lineId = isUp ? LINE_FAST_UP : LINE_FAST_DOWN
  }
  if (sectionTracks <= 2) return isUp ? 1 : 0
  return Math.min(lineId, sectionTracks - 1)
}

/** The Track a Line is on at a given Chainage, given the whole Route. */
export function trackForLineAt(
  sections: TrackSection[],
  lineId: number,
  chainageM: number,
): number {
  return trackForLine(lineId, sectionAtChainage(sections, chainageM).tracks)
}
