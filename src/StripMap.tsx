/**
 * Live line diagram: the whole Western line as one vertical strip, with every
 * running service on it as a moving dot.
 *
 * The 3D scene can only ever show one part of a 124 km corridor at a time, so
 * nothing in the app showed the *operation* — how many trains are out, where
 * they bunch, how up and down services interleave. This is that view, and it
 * doubles as navigation: click a station or a train to fly the camera there.
 *
 * Reads the sim directly, like StationCard does. Nothing here touches the 3D
 * layer; trainStates is pure, so polling it is just arithmetic.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { network, timetables, type Focus } from './app-data'
import { isNarrowViewport, useIsNarrow } from './viewport'
import { simClock } from './scene/sim-clock'
import { trainStates } from './sim/simulate'
import { SERVICE_TYPE_LABEL } from './service-labels'
import type { ServiceType } from './sim/types'

/** Refresh rate. Fast enough to read as motion, far below the frame rate —
 * the dots move ~1 px a second at this scale even for a fast service. */
const REFRESH_MS = 250
/** Fraction of the strip's height the corridor occupies, leaving end margins. */
const TOP_PAD = 2
const BOTTOM_PAD = 2

interface Dot {
  id: string
  serviceType: ServiceType
  direction: 'up' | 'down'
  /** 0 = Churchgate … 100 = Dahanu Road, as a percentage down the strip. */
  pct: number
  dwelling: boolean
}

/**
 * Schematic spacing, not distance: stations sit at even intervals down the
 * strip the way a printed line diagram draws them. Scaled by chainage, half
 * the line's 37 stations pile into the first quarter of the strip — the
 * suburban section is that much denser — and the southern names and dots
 * become an unreadable smear. Trains interpolate within whichever station
 * gap they're in, so a dot still moves smoothly and still sits between the
 * right two stations.
 */
const stationPct = (i: number) =>
  TOP_PAD + (i / (network.stations.length - 1)) * (100 - TOP_PAD - BOTTOM_PAD)

function pctOf(chainageM: number): number {
  const stations = network.stations
  if (chainageM <= stations[0].chainageM) return stationPct(0)
  for (let i = 1; i < stations.length; i++) {
    if (chainageM > stations[i].chainageM) continue
    const span = stations[i].chainageM - stations[i - 1].chainageM || 1
    const t = (chainageM - stations[i - 1].chainageM) / span
    return stationPct(i - 1) + t * (stationPct(i) - stationPct(i - 1))
  }
  return stationPct(stations.length - 1)
}

export function StripMap({ focus, onFocus }: { focus: Focus; onFocus: (f: Focus) => void }) {
  const [dots, setDots] = useState<Dot[]>([])
  /**
   * Open by default on a desktop, closed on a phone. The diagram is a second
   * view of what the scene already shows, and at 393px it covers most of the
   * scene — landing on a train simulator whose trains are behind a panel is
   * the wrong first impression, and the panel is one tap away.
   */
  const [open, setOpen] = useState(() => !isNarrowViewport())
  const narrow = useIsNarrow()
  const openRef = useRef(open)
  openRef.current = open
  const focusedRef = useRef<HTMLButtonElement>(null)

  // Selecting a station elsewhere (in the scene, say) should not leave its row
  // scrolled out of sight in a strip too short to show the whole line.
  const focusedStationId = focus.mode === 'station' ? focus.stationId : null
  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focusedStationId, open])

  useEffect(() => {
    const tick = () => {
      if (!openRef.current) return
      setDots(
        trainStates(timetables, simClock.t)
          .filter((s) => !s.parkedYardId)
          .map((s) => ({
            id: s.id,
            serviceType: s.serviceType,
            direction: s.direction,
            pct: pctOf(s.chainageM),
            dwelling: s.dwelling,
          })),
      )
    }
    tick()
    const id = setInterval(tick, REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  if (!open) {
    return (
      <button className="strip-toggle strip-toggle-closed" onClick={() => setOpen(true)}>
        Line ▸
      </button>
    )
  }

  const focusedStation = focusedStationId
  const focusedTrain = focus.mode === 'follow' ? focus.trainId : null
  const running = dots.length

  /** On a phone the diagram covers the scene, so choosing something closes it:
   * the point of the choice is to look at what was chosen. */
  const select = (f: Focus) => {
    onFocus(f)
    if (narrow) setOpen(false)
  }

  return (
    <aside className="strip">
      <header className="strip-head">
        <span className="strip-title">Line</span>
        <span className="strip-count">{running} running</span>
        <button className="strip-toggle" onClick={() => setOpen(false)} aria-label="Hide line view">
          ◂
        </button>
      </header>
      {/* The diagram is laid out at a fixed pitch per station and scrolls when
          the panel is shorter than that needs — positioned purely as a
          percentage of the panel it squeezed 37 rows into whatever height was
          going, and on a short window the names landed on top of each other. */}
      <div className="strip-body">
        <div
          className="strip-scale"
          style={{ '--rows': network.stations.length } as CSSProperties}
        >
          <div className="strip-rail" />
          {network.stations.map((s) => {
            const top = pctOf(s.chainageM)
            const focused = focusedStation === s.id
            return (
              <button
                key={s.id}
                ref={focused ? focusedRef : undefined}
                className={`strip-stn${s.fastHalt ? ' strip-stn-fast' : ''}${focused ? ' strip-stn-on' : ''}`}
                style={{ top: `${top}%` }}
                onClick={() => select({ mode: 'station', stationId: s.id })}
                title={s.name}
              >
                <span className="strip-tick" />
                <span className="strip-name">{s.name}</span>
              </button>
            )
          })}
          {dots.map((d) => (
            <button
              key={d.id}
              className={[
                'strip-train',
                `strip-train-${d.serviceType}`,
                d.direction === 'up' ? 'strip-up' : 'strip-down',
                d.dwelling ? 'strip-dwell' : '',
                focusedTrain === d.id ? 'strip-train-on' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ top: `${d.pct}%` }}
              onClick={() => select({ mode: 'follow', trainId: d.id })}
              title={`${SERVICE_TYPE_LABEL[d.serviceType]} ${d.direction === 'up' ? '↑ Churchgate' : '↓ Dahanu'}`}
            />
          ))}
        </div>
      </div>
      <footer className="strip-foot">
        <span className="strip-dir">↑ up</span>
        <span className="strip-dir">down ↓</span>
      </footer>
    </aside>
  )
}
