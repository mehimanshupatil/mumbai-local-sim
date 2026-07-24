import { Text } from '@react-three/drei'
import { FONT_EN, FONT_MR } from './fonts'

const BOARD_W = 210
const BOARD_H = 56

/** Classic WR yellow board: EN over Marathi, black on yellow. Caller
 * supplies position/billboarding/scale — this is just the board face. */
export function WRBoard({ name, nameMr }: { name: string; nameMr: string }) {
  return (
    <>
      <mesh>
        <planeGeometry args={[BOARD_W, BOARD_H]} />
        <meshBasicMaterial color="#f2c40f" />
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
