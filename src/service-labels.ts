import type { ServiceType } from './sim/types'

/** Short badge text for each service type, shared by the station card and follow-cam hint. */
export const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  slow: 'S',
  fast: 'F',
  ac: 'AC',
  express: 'EXP',
}
