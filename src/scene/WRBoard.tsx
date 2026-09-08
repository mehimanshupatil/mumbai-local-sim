import { useMemo } from 'react'
import { Text } from '@react-three/drei'
import { Color } from 'three'
import { FONT_EN, FONT_MR } from './fonts'

const BOARD_W = 210
const BOARD_H = 56

/**
 * The board face is unlit (meshBasicMaterial), so it ignores the scene's
 * day/night lighting entirely. Left alone it blazes at full daytime yellow
 * against a near-black 21:00 scene, reading as a bug rather than a lit sign.
 * Real platform boards are illuminated after dark, so it dims toward a warm
 * lamp-lit yellow rather than going out.
 */
const BOARD_DAY = new Color('#f2c40f')
const BOARD_NIGHT = new Color('#8a6d10')

/** Classic WR yellow board: EN over Marathi, black on yellow. Caller
 * supplies position/billboarding/scale — this is just the board face. */
export function WRBoard({
  name,
  nameMr,
  night = 0,
}: {
  name: string
  nameMr: string
  /** 0 = full day, 1 = full night; see daylight.ts. */
  night?: number
}) {
  const boardColor = useMemo(
    () => BOARD_DAY.clone().lerp(BOARD_NIGHT, Math.min(1, Math.max(0, night))),
    [night],
  )
  return (
    <>
      <mesh>
        <planeGeometry args={[BOARD_W, BOARD_H]} />
        <meshBasicMaterial color={boardColor} />
      </mesh>
      <Text
        position={[0, 10, 0.5]}
        font={FONT_EN}
        fontSize={24}
        color="#151208"
        anchorY="middle"
        renderOrder={11}
        material-depthTest={false}
      >
        {name}
      </Text>
      <Text
        position={[0, -14, 0.5]}
        font={FONT_MR}
        fontSize={17}
        color="#151208"
        anchorY="middle"
        renderOrder={11}
        material-depthTest={false}
      >
        {nameMr}
      </Text>
    </>
  )
}
