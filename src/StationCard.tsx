import { useEffect, useState } from 'react'
import { network, timetables } from './app-data'
import { nextArrivals, type Arrival } from './sim/arrivals'
import { formatSimTime } from './sim/clock'
import { simClock } from './scene/sim-clock'

const TYPE_LABEL = { slow: 'S', fast: 'F', ac: 'AC', express: 'EXP' } as const

const stationName = (id: string) => network.stations.find((s) => s.id === id)?.name ?? id

/** Station info card: name, halt badge, and the live arrivals board. */
export function StationCard({ stationId, onClose }: { stationId: string; onClose: () => void }) {
  const station = network.stations.find((s) => s.id === stationId)
  const [arrivals, setArrivals] = useState<Arrival[]>([])

  useEffect(() => {
    const update = () => setArrivals(nextArrivals(timetables, stationId, simClock.t, 6))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [stationId])

  if (!station) return null
  return (
    <aside className="station-card">
      <header>
        <h2>{station.name}</h2>
        <span className={station.fastHalt ? 'halt-badge fast' : 'halt-badge'}>
          {station.fastHalt ? 'FAST HALT' : 'SLOW'}
        </span>
        <button className="card-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="card-sub">{station.nameMr}</div>
      <ul className="arrivals">
        {arrivals.map((a) => {
          const etaMin = Math.max(0, Math.round((a.arriveT - simClock.t) / 60))
          return (
            <li key={a.serviceId}>
              <span className={`svc svc-${a.serviceType}`}>{TYPE_LABEL[a.serviceType]}</span>
              <span className="arr-time">{formatSimTime(a.arriveT)}</span>
              <span className="arr-dest">→ {stationName(a.terminusId)}</span>
              <span className="arr-eta">{etaMin === 0 ? 'now' : `${etaMin} min`}</span>
            </li>
          )
        })}
        {arrivals.length === 0 && <li className="arr-none">No more services today</li>}
      </ul>
    </aside>
  )
}
