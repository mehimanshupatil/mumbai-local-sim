import { ClockControls } from './ClockControls'
import { Scene } from './scene/Scene'

export function App() {
  return (
    <div className="app">
      <header className="header">
        <h1>Mumbai Local</h1>
        <span className="line-badge">Western Line</span>
        <ClockControls />
      </header>
      <Scene />
    </div>
  )
}
