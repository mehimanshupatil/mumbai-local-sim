import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import { trainStates, type Timetable } from '../sim/simulate'
import { COACH_GAP_SCENE_M, COACH_LENGTH_SCENE_M } from './config'
import { simClock } from './sim-clock'
import { poseAt, type TrainTrack } from './track-geometry'

const COACHES = 12
const BODY_W = 18
const BODY_H = 18

// WR white/purple livery. Variants (AC blue, express) arrive with ticket #6.
const BODY_COLOR = '#efecf1'
const STRIPE_COLOR = '#6d1ca3'

/**
 * A procedural low-poly 12-car EMU rake. Each coach is posed independently
 * on the track curve, so the rake snakes through bends. Swappable for a
 * detailed glTF model later — the sim seam only supplies TrainState.
 */
export function Train({ timetable, track }: { timetable: Timetable; track: TrainTrack }) {
  const rakeRef = useRef<Group>(null)
  const coachRefs = useRef<(Group | null)[]>([])

  // Scene metres from the rake front back to each coach centre.
  const coachOffsets = useMemo(
    () =>
      Array.from(
        { length: COACHES },
        (_, i) => i * (COACH_LENGTH_SCENE_M + COACH_GAP_SCENE_M) + COACH_LENGTH_SCENE_M / 2,
      ),
    [],
  )

  useFrame(() => {
    const rake = rakeRef.current
    if (!rake) return
    const state = trainStates([timetable], simClock.t)[0]
    rake.visible = state !== undefined
    if (!state) return
    // state.chainageM is the rake front; coaches trail opposite the direction
    // of travel (down = increasing chainage).
    const dirSign = state.direction === 'down' ? 1 : -1
    for (let i = 0; i < COACHES; i++) {
      const coach = coachRefs.current[i]
      if (!coach) continue
      const pose = poseAt(track, state.chainageM, -dirSign * coachOffsets[i])
      coach.position.set(pose.x, BODY_H / 2 + 2, pose.z)
      coach.rotation.y = pose.angleRad
    }
  })

  return (
    <group ref={rakeRef}>
      {Array.from({ length: COACHES }, (_, i) => (
        <group
          key={i}
          ref={(el) => {
            coachRefs.current[i] = el
          }}
        >
          <mesh>
            <boxGeometry args={[BODY_W, BODY_H, COACH_LENGTH_SCENE_M]} />
            <meshStandardMaterial color={BODY_COLOR} />
          </mesh>
          {/* waist-level livery band */}
          <mesh position={[0, -BODY_H * 0.15, 0]}>
            <boxGeometry args={[BODY_W + 1, BODY_H * 0.28, COACH_LENGTH_SCENE_M + 1]} />
            <meshStandardMaterial color={STRIPE_COLOR} />
          </mesh>
        </group>
      ))}
    </group>
  )
}
