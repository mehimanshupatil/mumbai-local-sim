import { useEffect, useState } from 'react'
import type { Focus } from './app-data'

declare global {
  interface Window {
    setFocus?: (f: Focus) => void
  }
}
import { ClockControls } from './ClockControls'
import { Scene } from './scene/Scene'
import { StationCard } from './StationCard'

export function App() {
  const [focus, setFocus] = useState<Focus>({ mode: 'free' })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus({ mode: 'free' })
    }
    window.addEventListener('keydown', onKey)
    // Dev affordance, like window.simClock: drive focus from the console.
    if (import.meta.env.DEV) window.setFocus = setFocus
    return () => {
      window.removeEventListener('keydown', onKey)
      delete window.setFocus
    }
  }, [])

  return (
    <div className="app">
      <header className="header">
        <h1>Mumbai Local</h1>
        <span className="line-badge">Western Line</span>
        <ClockControls />
      </header>
      <Scene focus={focus} onFocus={setFocus} />
      {focus.mode === 'station' && (
        <StationCard stationId={focus.stationId} onClose={() => setFocus({ mode: 'free' })} />
      )}
      {focus.mode === 'follow' && (
        <div className="follow-hint">Following {focus.trainId} — Esc or click away to release</div>
      )}
    </div>
  )
}
