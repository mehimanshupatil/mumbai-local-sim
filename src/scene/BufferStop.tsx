/**
 * The block at the end of a dead-end track. Shared by Churchgate's platform
 * roads and the yards' stabling roads — both stop rather than continue, and
 * the buffer is what tells the eye so.
 *
 * Sized to read from the station camera rather than to scale, like the rest
 * of the trackside dressing.
 */
const BUFFER_W = 16
const BUFFER_H = 9
const BUFFER_D = 5
const BUFFER_COLOR = '#5a3a34'

export function BufferStop({
  position: [x, y, z],
  angleRad,
  width = BUFFER_W,
}: {
  /** Rail-level position at the end of the track. */
  position: [number, number, number]
  /** Heading of the track it caps, as poseAt reports it. */
  angleRad: number
  width?: number
}) {
  return (
    <mesh position={[x, y + BUFFER_H / 2, z]} rotation={[0, angleRad, 0]}>
      <boxGeometry args={[width, BUFFER_H, BUFFER_D]} />
      <meshStandardMaterial color={BUFFER_COLOR} roughness={0.85} />
    </mesh>
  )
}
