import { useEffect, useState } from 'react'
import { network, timetables, type FollowView } from './app-data'
import { SERVICE_TYPE_LABEL } from './service-labels'
import { etaMinutes } from './sim/clock'
import type { ServiceType } from './sim/types'
import { simClock } from './scene/sim-clock'
import { IS_COARSE_POINTER } from './scene/config'

const stationName = (id: string) => network.stations.find((s) => s.id === id)?.name ?? id

interface FollowInfo {
  serviceType: ServiceType
  terminusName: string
  nextStopName: string | null
  etaMin: number | null
}

const VIEWS: { id: FollowView; label: string }[] = [
  { id: 'chase', label: 'Chase' },
  { id: 'cab', label: 'Cab' },
  { id: 'lineside', label: 'Lineside' },
]

/** Follow-cam hint: service type, destination, and next-stop ETA for the
 * train the camera is locked onto — same data shape as the arrivals board —
 * plus the camera-view switch (also on the C key, see App). */
export function FollowHint({
  trainId,
  view,
  onView,
}: {
  trainId: string
  view: FollowView
  onView: (v: FollowView) => void
}) {
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
      <span className="follow-views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`follow-view${v.id === view ? ' follow-view-on' : ''}`}
            onClick={() => onView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </span>
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
      {/* Name the gesture this device actually has: a phone has no C key and
          no Esc, but tapping the scene off the train releases the follow
          (Scene's onPointerMissed), and the view buttons above are the
          cycle. */}
      {IS_COARSE_POINTER ? 'tap the scene to release' : 'C to cycle view · Esc to release'}
    </div>
  )
}
