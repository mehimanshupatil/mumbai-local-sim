/**
 * Mounts the sound layer inside the Canvas: puts the listener on the camera,
 * keeps the Bed following the hour and the traffic, and speaks the Cues the
 * sim hands over.
 *
 * Announcements are positional, at the Platform Face. That is the whole rule —
 * there is no "which Station announces" logic anywhere, because distance does
 * the filtering: a Station three kilometres away is inaudible, and walking the
 * camera down the Corridor passes out of one Station's PA and into the next.
 *
 * Callouts are the opposite. They are heard inside the Rake, so they play only
 * while riding one — cab or chase — and are silent from the lineside, where
 * you are standing outside the train watching it go by.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Focus } from '../app-data'
import type { NetworkData } from '../data/network-types'
import type { Cue } from '../sim/cues'
import { sectionAtChainage } from '../sim/lines'
import { trainStates, type Timetable } from '../sim/simulate'
import { audioGraph, ensureListener, loadedClips, sound } from './audio'
import { Bed } from './bed'
import { trackLateralM } from './rake-geometry'
import { noteSpeech, onCue, simAudio } from './sim-audio'
import { simClock } from './sim-clock'
import { isSpoken, loadPhraseBank, phraseBankReady, renderUtterance } from './speech'
import { poseAt, projectOnTrack, type TrainTrack } from './track-geometry'
import { liveVoices, playVoice, stopAllVoices } from './voices'

/**
 * How far along the corridor counts as "here" when weighing how busy it
 * sounds. Three kilometres either side of wherever the camera is looking is
 * about two stations' worth on the dense southern stretch, which is what a
 * platform's own noise floor really answers to.
 */
const EARSHOT_M = 3000

/** The Bed has nothing that moves faster than this; per-frame would be waste. */
const UPDATE_INTERVAL_S = 0.5

/**
 * Beyond this a Station's PA is not worth a voice slot. Not a hearing limit —
 * the rolloff has it near-inaudible well before here — but a budget one: an
 * Announcement runs ten seconds or more, and six slots held by Stations
 * kilometres away is a platform standing silent while distant ones mumble.
 */
const ANNOUNCE_RANGE_M = 2200

/** A PA is loud; a Callout is a speaker above your head in a moving coach. */
const ANNOUNCE_VOLUME = 1
const CALLOUT_VOLUME = 0.85

export function AudioRig({
  network,
  timetables,
  track,
  focus,
}: {
  network: NetworkData
  timetables: Timetable[]
  track: TrainTrack
  focus: Focus
}) {
  const camera = useThree((state) => state.camera)
  const bed = useRef<Bed | null>(null)
  const sinceUpdate = useRef(0)
  // Read inside the Cue callback, which outlives any one render.
  const focusRef = useRef(focus)
  focusRef.current = focus

  useEffect(() => {
    const sync = () => {
      if (sound.muted) {
        // Positional sound stops dead; the Bed only drops to silent gain, so
        // unmuting resumes the same ambience rather than restarting it.
        stopAllVoices()
        return
      }
      const listener = ensureListener(camera)
      const graph = audioGraph()
      if (!graph) return
      if (!bed.current) bed.current = new Bed(graph.ctx, listener.getInput())
      // Two requests for the entire PA, and only once sound is on.
      void loadPhraseBank(graph.ctx, import.meta.env.BASE_URL).catch((err) =>
        console.error('phrase bank failed to load, the PA stays silent:', err),
      )
    }
    sync()
    return sound.watch(sync)
  }, [camera])

  useEffect(() => {
    return () => {
      bed.current?.dispose()
      bed.current = null
      stopAllVoices()
    }
  }, [])

  useEffect(
    () =>
      onCue((cue) => {
        if (sound.muted || !isSpoken(cue.kind) || !phraseBankReady()) return
        const graph = audioGraph()
        if (!graph) return
        const spot = cue.faceTrack === null ? null : facePosition(network, track, cue)
        const followed = focusRef.current
        const riding =
          followed.mode === 'follow' &&
          followed.trainId === cue.serviceId &&
          (followed.view ?? 'chase') !== 'lineside'

        if (spot) {
          const distance = Math.hypot(camera.position.x - spot[0], camera.position.z - spot[2])
          if (distance > ANNOUNCE_RANGE_M) return
          const buffer = renderUtterance(graph.ctx, cue)
          if (!buffer) return
          const played = playVoice({
            buffer,
            position: spot,
            distance,
            volume: ANNOUNCE_VOLUME,
            keep: riding,
          })
          noteSpeech(cue, buffer.duration, distance, played)
          return
        }
        // A Callout is heard from inside the Rake, so it has no position — and
        // no reason to play at all unless the viewer is in that Rake.
        if (!riding) return
        const buffer = renderUtterance(graph.ctx, cue)
        if (!buffer) return
        const played = playVoice({
          buffer,
          position: null,
          distance: 0,
          volume: CALLOUT_VOLUME,
          keep: true,
        })
        noteSpeech(cue, buffer.duration, 0, played)
      }),
    [camera, network, track],
  )

  useFrame((_, delta) => {
    sinceUpdate.current += delta
    if (sinceUpdate.current < UPDATE_INTERVAL_S) return
    sinceUpdate.current = 0
    simAudio.voices = liveVoices()
    simAudio.clips = loadedClips().length
    if (sound.muted || !bed.current) return

    // Where the camera is looking, in chainage, so density is local: the
    // suburbs at 08:40 and Dahanu at 08:40 are not the same place.
    const { alongM } = projectOnTrack(track, camera.position.x, camera.position.z)
    const here = alongM / track.scale
    let nearby = 0
    for (const state of trainStates(timetables, simClock.t)) {
      if (state.parkedYardId) continue
      if (Math.abs(state.chainageM - here) <= EARSHOT_M) nearby++
    }
    const hour = (((simClock.t / 3600) % 24) + 24) % 24
    bed.current.update(hour, nearby)
    simAudio.nearby = nearby
    simAudio.hour = hour
  })

  return null
}

/**
 * Where an Announcement comes from: the Platform Face itself, beside the Track
 * the Service is booked on, rather than a point at the middle of the Station.
 * On a six-Track Section the far Face is 125 scene metres across, which is
 * audible as a pan when the camera stands between them.
 */
function facePosition(
  network: NetworkData,
  track: TrainTrack,
  cue: Cue,
): [number, number, number] {
  const pose = poseAt(track, cue.chainageM)
  const tracks = sectionAtChainage(network.sections, cue.chainageM).tracks
  const lateral = trackLateralM(cue.faceTrack ?? 0, tracks)
  // Same normal convention as the track geometry: left of travel.
  return [pose.x - Math.cos(pose.angleRad) * lateral, 0, pose.z + Math.sin(pose.angleRad) * lateral]
}
