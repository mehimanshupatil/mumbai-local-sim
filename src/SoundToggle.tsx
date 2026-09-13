import { useEffect, useState } from 'react'
import { sound } from './scene/audio'

/**
 * The speaker beside the clock. Sound starts off and the choice is remembered,
 * so this is the only thing in the UI that persists between visits — a page
 * that makes noise on load without being asked is a page people close.
 */
export function SoundToggle() {
  const [muted, setMuted] = useState(sound.muted)
  useEffect(() => sound.watch(() => setMuted(sound.muted)), [])

  return (
    <button
      className={muted ? 'speed-btn' : 'speed-btn active'}
      title={muted ? 'Sound on' : 'Sound off'}
      aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
      aria-pressed={!muted}
      onClick={() => sound.setMuted(!muted)}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  )
}
