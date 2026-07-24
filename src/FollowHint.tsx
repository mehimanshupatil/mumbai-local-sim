import { useEffect, useState } from 'react'
import { network, timetables } from './app-data'
import { SERVICE_TYPE_LABEL } from './service-labels'
import { etaMinutes } from './sim/clock'
import type { ServiceType } from './sim/types'
import { simClock } from './scene/sim-clock'

const stationName = (id: string) => network.stations.find((s) => s.id === id)?.name ?? id

interface FollowInfo {
  serviceType: ServiceType
  terminusName: string
  nextStopName: string | null
  etaMin: number | null
}

/** Follow-cam hint: service type, destination, and next-stop ETA for the
 * train the camera is locked onto — same data shape as the arrivals board. */
export function FollowHint({ trainId }: { trainId: string }) {
  const [info, setInfo] = useState<FollowInfo | null>(null)

  useEffect(() => {
    const update = () => {
      const tt = timetables.find((t) => t.def.id === trainId)
      if (!tt) {
        setInfo(null)
        return
      }
      const next = tt.stops.find((s) => s.arriveT > simClock.t)
      setInfo({
        serviceType: tt.def.serviceType,
        terminusName: stationName(tt.stops[tt.stops.length - 1].id),
        nextStopName: next ? stationName(next.id) : null,
        etaMin: next ? etaMinutes(next.arriveT, simClock.t) : null,
      })
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [trainId])

  return (
    <div className="follow-hint">
      {info && (
        <>
          <span className={`svc svc-${info.serviceType}`}>{SERVICE_TYPE_LABEL[info.serviceType]}</span>{' '}
          {trainId} → {info.terminusName}
          {info.nextStopName && (
            <>
              {' '}
              · next {info.nextStopName} in {info.etaMin === 0 ? 'now' : `${info.etaMin} min`}
            </>
          )}
          {' · '}
        </>
      )}
      Esc or click away to release
    </div>
  )
}
