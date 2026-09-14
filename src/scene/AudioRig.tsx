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
import type { TrainState } from '../sim/types'
import { trackForLineAt } from '../sim/lines'
import { audioGraph, ensureListener, loadedClips, sound } from './audio'
import { Bed } from './bed'
import { IS_COARSE_POINTER } from './config'
import { trackLateralM } from './rake-geometry'
import { noteSpeech, onCue, simAudio } from './sim-audio'
import { simClock } from './sim-clock'
import { isSpoken, loadPhraseBank, phraseBankReady, renderUtterance } from './speech'
import {
  brakeBuffer,
  clackBuffer,
  hornBuffer,
  RAIL_PANEL_M,
  RunningSound,
  tractionHzFor,
} from './train-sound'
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

/**
 * How many Rakes get a continuously synthesised voice at once. Separate from
 * the discrete voice budget: these never stop, so the cap is on how many
 * oscillator sets are alive rather than on how many sounds are in flight. The
 * followed Service always holds one; the other goes to whatever is nearest the
 * camera, which is what makes a lineside pass-by work.
 */
const MAX_RUNNING = IS_COARSE_POINTER ? 1 : 2

/** Past this a Rake is not worth synthesising; the rolloff has it inaudible. */
const RUNNING_RANGE_M = 3000

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
  const running = useRef(new Map<string, RunningSound>())
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
    const voices = running.current
    return () => {
      bed.current?.dispose()
      bed.current = null
      for (const voice of voices.values()) voice.dispose()
      voices.clear()
      stopAllVoices()
    }
  }, [])

  useEffect(
    () =>
      onCue((cue) => {
        if (sound.muted) return
        const graph = audioGraph()
        if (!graph) return
        const followed = focusRef.current
        const ridingThis =
          followed.mode === 'follow' &&
          followed.trainId === cue.serviceId &&
          (followed.view ?? 'chase') !== 'lineside'

        // The horn and the brakes happen at the Rake, which at both of these
        // moments is at the Halt the Cue names.
        if (cue.kind === 'horn' || cue.kind === 'brake') {
          const at = railPosition(network, track, cue.chainageM, cue.lineId)
          const distance = Math.hypot(camera.position.x - at[0], camera.position.z - at[2])
          if (distance > RUNNING_RANGE_M) return
          const buffer = cue.kind === 'horn' ? hornBuffer(graph.ctx) : brakeBuffer(graph.ctx)
          playVoice({ buffer, position: at, distance, keep: ridingThis })
          return
        }

        if (!isSpoken(cue.kind) || !phraseBankReady()) return
        const spot = cue.faceTrack === null ? null : facePosition(network, track, cue)
        const riding = ridingThis

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

  // Traction and rail joints, for the Rakes worth synthesising. Every frame
  // rather than twice a second: the whole point is that pitch and rhythm track
  // the train continuously, and a stepped sweep is audible as steps.
  useFrame(() => {
    const voices = running.current
    const graph = audioGraph()
    if (sound.muted || !graph) {
      if (voices.size) {
        for (const voice of voices.values()) voice.dispose()
        voices.clear()
      }
      return
    }

    const followed = focusRef.current
    const states = trainStates(timetables, simClock.t)
    const wanted = pickRunning(states, followed, camera.position.x, camera.position.z, network, track)

    for (const [id, voice] of voices) {
      if (!wanted.has(id)) {
        voice.dispose()
        voices.delete(id)
      }
    }
    for (const [id, pick] of wanted) {
      let voice = voices.get(id)
      if (!voice) {
        voice = new RunningSound(graph.ctx, graph.input, clackBuffer(graph.ctx))
        voices.set(id, voice)
      }
      voice.update(pick.position, pick.speedMps, pick.curvature, 1)
    }
    simAudio.running = voices.size
    simAudio.runningInfo = [...wanted].map(([id, pick]) => ({
      id,
      speedMps: Math.round(pick.speedMps * 10) / 10,
      tractionHz: Math.round(tractionHzFor(pick.speedMps)),
      clackHz: Math.round((pick.speedMps / RAIL_PANEL_M) * 100) / 100,
      curvature: Math.round(pick.curvature * 1e5) / 1e5,
    }))
  })

  return null
}

/**
 * Which Rakes get a continuously synthesised voice: the one being followed,
 * always, plus whatever is nearest the camera. Distance is measured along the
 * Corridor first, which is cheap, and only the handful that survive that get
 * their world position worked out.
 */
function pickRunning(
  states: TrainState[],
  focus: Focus,
  camX: number,
  camZ: number,
  network: NetworkData,
  track: TrainTrack,
): Map<string, { position: [number, number, number]; speedMps: number; curvature: number }> {
  const here = projectOnTrack(track, camX, camZ).alongM / track.scale
  const candidates = states
    .filter((s) => !s.parkedYardId)
    .map((s) => ({
      state: s,
      rank:
        focus.mode === 'follow' && focus.trainId === s.id
          ? -1 // the followed Service outranks everything
          : Math.abs(s.chainageM - here),
    }))
    .filter((c) => c.rank < RUNNING_RANGE_M)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_RUNNING)

  const out = new Map<string, { position: [number, number, number]; speedMps: number; curvature: number }>()
  for (const { state } of candidates) {
    out.set(state.id, {
      position: railPosition(network, track, state.chainageM, state.lineId),
      speedMps: state.speedMps,
      curvature: curvatureAt(track, state.chainageM),
    })
  }
  return out
}

/** Where a Rake is: on its own Track, not on the corridor centreline. */
function railPosition(
  network: NetworkData,
  track: TrainTrack,
  chainageM: number,
  lineId: number,
): [number, number, number] {
  const pose = poseAt(track, chainageM)
  const tracks = sectionAtChainage(network.sections, chainageM).tracks
  const lateral = trackLateralM(trackForLineAt(network.sections, lineId, chainageM), tracks)
  return [pose.x - Math.cos(pose.angleRad) * lateral, 0, pose.z + Math.sin(pose.angleRad) * lateral]
}

/**
 * How sharply the track turns under a Rake, in radians per metre. Flange squeal
 * comes out of this rather than a list of Stations with curves, so the Mahim
 * curves sing because they are drawn bent, not because anyone said so.
 */
function curvatureAt(track: TrainTrack, chainageM: number): number {
  const span = 40
  const before = poseAt(track, chainageM - span / 2).angleRad
  const after = poseAt(track, chainageM + span / 2).angleRad
  let delta = after - before
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  return Math.abs(delta) / span
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
