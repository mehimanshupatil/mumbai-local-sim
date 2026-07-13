import { Canvas } from '@react-three/fiber'
import { OrbitControls, Sky } from '@react-three/drei'

export function Scene() {
  return (
    <Canvas camera={{ position: [0, 180, 800], fov: 45, near: 1, far: 20000 }}>
      <Sky sunPosition={[100, 60, 100]} distance={15000} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[500, 800, 300]} intensity={1.2} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[4000, 4000]} />
        <meshStandardMaterial color="#8a9a6b" />
      </mesh>
      {/* placeholder rake stand-in until the corridor renders */}
      <mesh position={[0, 15, 0]}>
        <boxGeometry args={[200, 30, 30]} />
        <meshStandardMaterial color="#efeaf0" />
      </mesh>
      <OrbitControls
        makeDefault
        maxPolarAngle={Math.PI / 2.1}
        minDistance={20}
        maxDistance={5000}
      />
    </Canvas>
  )
}
