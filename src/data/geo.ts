/** A WGS84 coordinate as [lon, lat]. */
export type LonLat = [number, number]

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversineM(a: LonLat, b: LonLat): number {
  const R = 6371000
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLon = (b[0] - a[0]) * toRad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
