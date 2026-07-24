import { useEffect, useState } from 'react'
import { network, timetables } from './app-data'
import { nextArrivals, type Arrival } from './sim/arrivals'
import { etaMinutes, formatSimTime } from './sim/clock'
import { simClock } from './scene/sim-clock'
import { SERVICE_TYPE_LABEL } from './service-labels'

const ARRIVALS_PER_DIRECTION = 4

const stationName = (id: string) => network.stations.find((s) => s.id === id)?.name ?? id

function ArrivalRow({ a }: { a: Arrival }) {
  const etaMin = etaMinutes(a.arriveT, simClock.t)
  return (
    <li>
      <span className={`svc svc-${a.serviceType}`}>{SERVICE_TYPE_LABEL[a.serviceType]}</span>
      <span className="arr-time">{formatSimTime(a.arriveT)}</span>
      <span className="arr-dest">→ {stationName(a.terminusId)}</span>
      <span className="arr-eta">{etaMin === 0 ? 'now' : `${etaMin} min`}</span>
    </li>
  )
}

function ArrivalList({ heading, arrivals }: { heading: string; arrivals: Arrival[] }) {
  return (
    <>
      <div className="arrivals-direction">{heading}</div>
      <ul className="arrivals">
        {arrivals.map((a) => (
          <ArrivalRow key={a.serviceId} a={a} />
        ))}
        {arrivals.length === 0 && <li className="arr-none">No more services today</li>}
      </ul>
    </>
  )
}

/** Station info card: name, halt badge, and the live arrivals board — split
 * by direction like a real WR platform board, each platform serving one. */
export function StationCard({ stationId, onClose }: { stationId: string; onClose: () => void }) {
  const station = network.stations.find((s) => s.id === stationId)
  const [down, setDown] = useState<Arrival[]>([])
  const [up, setUp] = useState<Arrival[]>([])

  useEffect(() => {
    const update = () => {
      setDown(nextArrivals(timetables, stationId, simClock.t, ARRIVALS_PER_DIRECTION, 'down'))
      setUp(nextArrivals(timetables, stationId, simClock.t, ARRIVALS_PER_DIRECTION, 'up'))
    }
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

      <ArrivalList heading="↓ Down — away from Churchgate" arrivals={down} />
      <ArrivalList heading="↑ Up — towards Churchgate" arrivals={up} />
    </aside>
  )
}
