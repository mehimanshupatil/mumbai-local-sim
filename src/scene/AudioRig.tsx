/**
 * Mounts the sound layer inside the Canvas: puts the listener on the camera,
 * keeps the Bed following the hour and the traffic, and answers for what is
 * audible from the console.
 *
 * Nothing here plays a discrete Cue — those arrive in #31 and #32 through
 * onCue and the voice budget. This is the part that has to exist first.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { trainStates, type Timetable } from '../sim/simulate'
import { audioGraph, ensureListener, loadedClips, sound } from './audio'
import { Bed } from './bed'
import { simAudio } from './sim-audio'
import { simClock } from './sim-clock'
import { projectOnTrack, type TrainTrack } from './track-geometry'
import { liveVoices, stopAllVoices } from './voices'

/**
 * How far along the corridor counts as "here" when weighing how busy it
 * sounds. Three kilometres either side of wherever the camera is looking is
 * about two stations' worth on the dense southern stretch, which is what a
 * platform's own noise floor really answers to.
 */
const EARSHOT_M = 3000

/** The Bed has nothing that moves faster than this; per-frame would be waste. */
const UPDATE_INTERVAL_S = 0.5

export function AudioRig({
  timetables,
  track,
}: {
  timetables: Timetable[]
  track: TrainTrack
}) {
  const camera = useThree((state) => state.camera)
  const bed = useRef<Bed | null>(null)
  const sinceUpdate = useRef(0)

  useEffect(() => {
    const sync = () => {
      if (sound.muted) {
        // Positional sound stops dead; the Bed only drops to silent gain, so
        // unmuting resumes the same ambience rather than restarting it.
        stopAllVoices()
        return
      }
      const listener = ensureListener(camera)
      if (!bed.current) {
        const graph = audioGraph()
        if (graph) bed.current = new Bed(graph.ctx, listener.getInput())
      }
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
    const hour = ((simClock.t / 3600) % 24 + 24) % 24
    bed.current.update(hour, nearby)
    simAudio.nearby = nearby
    simAudio.hour = hour
  })

  return null
}
