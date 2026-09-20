/**
 * `window.setCamera` — a DEV-only affordance for parking the camera at an
 * exact pose, alongside `window.simClock` and `window.setFocus`.
 *
 * Rendering has no component tests by design (CLAUDE.md), so a rendering claim
 * is only ever as good as the view it was checked in. A bug reported as "at
 * camera [5060, 85, 30142], 1920x1080" — #26 is exactly that — cannot be
 * reproduced by dragging the mouse until it looks about right, and a fix
 * verified in some other view has not been verified at all.
 *
 * Free mode only: in follow or station mode the rig owns the camera and would
 * overwrite this on the next frame.
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { ControlsLike } from './CameraRig'

declare global {
  interface Window {
    setCamera?: (pose: {
      position: [number, number, number]
      target?: [number, number, number]
    }) => void
    /** Where the camera actually ended up — MapControls has the last word. */
    cameraPose?: () => { position: [number, number, number]; target: [number, number, number] }
  }
}

export function DevCamera({ controls }: { controls: React.RefObject<ControlsLike | null> }) {
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.setCamera = ({ position, target }) => {
      camera.position.set(...position)
      if (target) {
        controls.current?.target.set(...target)
        camera.lookAt(...target)
      }
      camera.updateMatrixWorld()
    }
    window.cameraPose = () => {
      const t = controls.current?.target
      return {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: t ? [t.x, t.y, t.z] : [0, 0, 0],
      }
    }
    return () => {
      delete window.setCamera
      delete window.cameraPose
    }
  }, [camera, controls])
  return null
}
