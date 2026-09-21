/**
 * Where the layout stops being a desktop layout.
 *
 * One number, in one place, because two things have to agree about it: the
 * stylesheet, which moves the panels, and the components, which decide what is
 * open to begin with. A phone that lands with the line diagram covering half
 * the scene has a responsive stylesheet and an unresponsive app.
 *
 * Keep NARROW_MAX_PX in step with the `max-width` in styles.css — CSS cannot
 * read a TS constant, so this is stated twice and commented on both sides.
 */
import { useEffect, useState } from 'react'

/** Phones and small tablets in portrait. */
export const NARROW_MAX_PX = 720

const QUERY = `(max-width: ${NARROW_MAX_PX}px)`

export function isNarrowViewport(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(QUERY).matches
}

/**
 * Narrow now, and again whenever it changes — a phone rotated into landscape
 * is a different layout, and so is a desktop window dragged narrow.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrowViewport)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(QUERY)
    const onChange = () => setNarrow(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}
