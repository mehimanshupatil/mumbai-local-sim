/**
 * Post-processing: bloom, a tilt-shift blur and a vignette, driven by where
 * the camera is and what time it is rather than set once. Costs ~8 fps of a
 * 60 fps budget at retina resolution, most of it the bloom.
 *
 * Neither effect may sample scene depth. The Canvas runs a logarithmic depth
 * buffer (see Scene) because 124 km of coastal plain viewed from 190 km
 * z-fights sea against low land in a standard buffer, and postprocessing's
 * depth-based effects — depth of field among them — read the buffer as if it
 * were linear. Tilt-shift is screen-space, so it gets the model-railway look
 * without touching depth at all.
 */
import { Bloom, EffectComposer, TiltShift2, Vignette } from '@react-three/postprocessing'
import { useFrame, useThree } from '@react-three/fiber'
import { useRef, useState } from 'react'
import type { Daylight } from './daylight'

/** Below this view distance the scene is a model on a table; above it, a map. */
const TILT_FULL_M = 3_000
const TILT_NONE_M = 14_000
const TILT_MAX_BLUR = 0.12
/** Lamps and lit windows are drawn unlit by tone mapping, so they sit well
 * above everything else in the frame and are what the threshold catches. */
const BLOOM_THRESHOLD = 0.62
const BLOOM_DAY = 0.35
const BLOOM_NIGHT = 1.25

/** Re-render only on meaningful change — these drive uniforms, not geometry. */
const QUANTUM = 0.02

export function Effects({ daylight }: { daylight: Daylight }) {
  const controls = useThree((s) => s.controls) as { target?: { x: number; y: number; z: number } } | null
  const [blur, setBlur] = useState(0)
  const last = useRef(0)

  useFrame(({ camera }) => {
    const t = controls?.target
    const dist = t
      ? Math.hypot(camera.position.x - t.x, camera.position.y - t.y, camera.position.z - t.z)
      : camera.position.y
    const k = Math.min(1, Math.max(0, (TILT_NONE_M - dist) / (TILT_NONE_M - TILT_FULL_M)))
    const next = k * TILT_MAX_BLUR
    if (Math.abs(next - last.current) < QUANTUM * TILT_MAX_BLUR) return
    last.current = next
    setBlur(next)
  })

  return (
    <EffectComposer enableNormalPass={false} multisampling={0}>
      <Bloom
        mipmapBlur
        resolutionScale={0.5}
        luminanceThreshold={BLOOM_THRESHOLD}
        luminanceSmoothing={0.25}
        intensity={BLOOM_DAY + (BLOOM_NIGHT - BLOOM_DAY) * daylight.night}
      />
      {/* Mounted only while it would actually blur something: the pass costs
          the same whether blur is 0 or not, and on the map view it is 0. */}
      {blur > 0.004 ? <TiltShift2 blur={blur} /> : <></>}
      <Vignette offset={0.32} darkness={0.34} />
    </EffectComposer>
  )
}
