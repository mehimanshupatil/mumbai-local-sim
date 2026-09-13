/**
 * Distance haze. The corridor is 124 km long and gets looked at from 150 m
 * and from 190 km, so a fixed fog density can't work: tuned for the station
 * view it erases the whole map on the landing view, and tuned for the map it
 * does nothing up close. Density is therefore keyed to how far the camera is
 * from what it's orbiting — haze always starts to bite a couple of view
 * distances out, whatever the scale.
 *
 * The sea has its own fog (see WaterMaterial) because it's a raw
 * ShaderMaterial; both take their colour from daylight.skyColor, so land,
 * sea and sky stay one atmosphere.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { FogExp2 } from 'three'

/**
 * Fog reaches ~50% opacity at 2.6 view-distances out (f = 1 - exp(-(d*k)^2)),
 * which leaves the subject clear and hazes the horizon behind it.
 */
const FOG_K = 0.42
/** Never so thin it does nothing, never so thick the subject fogs up. */
const MIN_DENSITY = 1.5e-6
const MAX_DENSITY = 2.4e-4

export function Atmosphere({ color }: { color: string }) {
  const fog = useRef<FogExp2>(null)
  useFrame(({ camera, controls }) => {
    if (!fog.current) return
    const target = (controls as { target?: { x: number; y: number; z: number } } | null)?.target
    const viewDist = target
      ? Math.hypot(camera.position.x - target.x, camera.position.y - target.y, camera.position.z - target.z)
      : camera.position.y
    fog.current.density = Math.min(
      MAX_DENSITY,
      Math.max(MIN_DENSITY, FOG_K / Math.max(1, viewDist)),
    )
  })
  return <fogExp2 ref={fog} attach="fog" args={[color, MIN_DENSITY]} />
}
