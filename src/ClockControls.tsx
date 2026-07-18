import { useEffect, useState } from 'react'
import { formatSimTime, istSecondsSinceMidnight } from './sim/clock'
import { simClock } from './scene/sim-clock'

const SPEEDS = [
  { label: '⏸', value: 0 },
  { label: '1×', value: 1 },
  { label: '10×', value: 10 },
  { label: '60×', value: 60 },
]

/**
 * Header clock: display + speed controls + one-shot IST sync, all talking to
 * the simClock singleton the render loop reads. The display polls a few
 * times a second instead of re-rendering per frame.
 */
export function ClockControls() {
  const [display, setDisplay] = useState(() => formatSimTime(simClock.t))
  const [speed, setSpeed] = useState(simClock.speed)

  useEffect(() => {
    // Poll both time and speed: console pokes (window.simClock) stay in sync.
    const interval = setInterval(() => {
      setDisplay(formatSimTime(simClock.t))
      setSpeed(simClock.speed)
    }, 250)
    return () => clearInterval(interval)
  }, [])

  const setClockSpeed = (value: number) => {
    simClock.speed = value
    setSpeed(value)
  }

  return (
    <div className="clock-controls">
      <span className="clock-time">{display}</span>
      {SPEEDS.map(({ label, value }) => (
        <button
          key={value}
          className={speed === value ? 'speed-btn active' : 'speed-btn'}
          onClick={() => setClockSpeed(value)}
        >
          {label}
        </button>
      ))}
      <button
        className="speed-btn"
        title="Jump to current Mumbai time"
        onClick={() => {
          simClock.t = istSecondsSinceMidnight(Date.now())
          setDisplay(formatSimTime(simClock.t))
        }}
      >
        IST
      </button>
    </div>
  )
}
