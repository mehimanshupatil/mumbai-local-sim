/**
 * Which physical running line a service occupies, and where.
 *
 * This is sim, not rendering: the corridor genuinely narrows from six tracks
 * to two along its length, so on the two-track stretch north of Virar a fast
 * and a slow service in the same direction are on the *same rails*, whatever
 * their timetabled track says. Two trains sharing rails have to be kept apart
 * from each other (see MIN_SEPARATION_M), and that can only be decided here,
 * where the section's real track count is known.
 */
import type { TrackSection } from '../data/network-types'
import { TRACK_EXPRESS_DOWN, TRACK_EXPRESS_UP, TRACK_FAST_DOWN, TRACK_FAST_UP } from './types'

/** The track section containing a baked chainage. */
export function sectionAtChainage(sections: TrackSection[], chainageM: number): TrackSection {
  for (const s of sections) if (chainageM < s.toM) return s
  return sections[sections.length - 1]
}

/**
 * The running line a semantic track maps onto where a section has only so
 * many. Narrow sections fold expresses onto the fast pair (up direction
 * first, so opposing expresses never share a line), and the two-track stretch
 * folds everything onto the single up/down pair.
 */
export function physicalLane(track: number, sectionTracks: number): number {
  const isUp = track % 2 === 1 // all *_UP constants are odd by construction
  if (sectionTracks >= 6) return track
  if (track === TRACK_EXPRESS_DOWN || track === TRACK_EXPRESS_UP) {
    // A lone 5th line hosts down expresses; up expresses join the fast pair.
    if (sectionTracks === 5 && !isUp) return 4
    track = isUp ? TRACK_FAST_UP : TRACK_FAST_DOWN
  }
  if (sectionTracks <= 2) return isUp ? 1 : 0
  return Math.min(track, sectionTracks - 1)
}

/** The line a train is on at a given point, given the whole corridor. */
export function laneAtChainage(
  sections: TrackSection[],
  track: number,
  chainageM: number,
): number {
  return physicalLane(track, sectionAtChainage(sections, chainageM).tracks)
}
