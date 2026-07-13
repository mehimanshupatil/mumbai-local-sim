import { describe, expect, it } from 'vitest'
import { haversineM } from './geo'
import type { NetworkData } from './network-types'
import westernJson from './western.json'

const network = westernJson as NetworkData

/** The 37 Western line stations, Churchgate → Dahanu Road. */
const EXPECTED_STATIONS = [
  'Churchgate',
  'Marine Lines',
  'Charni Road',
  'Grant Road',
  'Mumbai Central',
  'Mahalaxmi',
  'Lower Parel',
  'Prabhadevi',
  'Dadar',
  'Matunga Road',
  'Mahim Junction',
  'Bandra',
  'Khar Road',
  'Santacruz',
  'Vile Parle',
  'Andheri',
  'Jogeshwari',
  'Ram Mandir',
  'Goregaon',
  'Malad',
  'Kandivali',
  'Borivali',
  'Dahisar',
  'Mira Road',
  'Bhayandar',
  'Naigaon',
  'Vasai Road',
  'Nallasopara',
  'Virar',
  'Vaitarna',
  'Saphale',
  'Kelve Road',
  'Palghar',
  'Umroli',
  'Boisar',
  'Vangaon',
  'Dahanu Road',
]

/** Fast locals halt here, then at every station north of Borivali. */
const FAST_HALTS_SOUTH = [
  'Churchgate',
  'Mumbai Central',
  'Dadar',
  'Bandra',
  'Andheri',
  'Borivali',
]

function station(name: string) {
  const s = network.stations.find((s) => s.name === name)
  if (!s) throw new Error(`station not in data: ${name}`)
  return s
}

function tracksAt(chainageM: number): number {
  const section = network.sections.find(
    (s) => chainageM >= s.fromM && chainageM < s.toM,
  )
  if (!section) throw new Error(`no track section at ${chainageM}m`)
  return section.tracks
}

/** Track count at the midpoint between two stations. */
function tracksBetween(a: string, b: string): number {
  return tracksAt((station(a).chainageM + station(b).chainageM) / 2)
}

describe('stations', () => {
  it('lists the 37 Western line stations in order Churchgate → Dahanu Road', () => {
    expect(network.stations.map((s) => s.name)).toEqual(EXPECTED_STATIONS)
  })

  it('gives every station an English and a Marathi (Devanagari) name', () => {
    for (const s of network.stations) {
      expect(s.name).not.toBe('')
      expect(s.nameMr, `${s.name} nameMr`).toMatch(/[ऀ-ॿ]/)
    }
  })

  it('places every station inside the Mumbai corridor bounding box', () => {
    for (const s of network.stations) {
      expect(s.lat, s.name).toBeGreaterThan(18.9)
      expect(s.lat, s.name).toBeLessThan(20.1)
      expect(s.lon, s.name).toBeGreaterThan(72.6)
      expect(s.lon, s.name).toBeLessThan(73.0)
    }
  })
})

describe('chainage', () => {
  it('starts at 0 at Churchgate and is strictly monotonic', () => {
    expect(network.stations[0].chainageM).toBe(0)
    for (let i = 1; i < network.stations.length; i++) {
      expect(
        network.stations[i].chainageM,
        `${network.stations[i - 1].name} → ${network.stations[i].name}`,
      ).toBeGreaterThan(network.stations[i - 1].chainageM)
    }
  })

  it('matches known real-world distances within tolerance', () => {
    // Published WR distances from Churchgate, ±4 km tolerance.
    const known: [string, number][] = [
      ['Dadar', 9_000],
      ['Andheri', 21_500],
      ['Borivali', 34_000],
      ['Virar', 60_000],
      ['Dahanu Road', 123_500],
    ]
    for (const [name, km] of known) {
      expect(Math.abs(station(name).chainageM - km), name).toBeLessThan(4_000)
    }
  })

  it('ends near the corridor length', () => {
    const last = network.stations[network.stations.length - 1]
    expect(network.lengthM).toBeGreaterThan(115_000)
    expect(network.lengthM).toBeLessThan(132_000)
    expect(network.lengthM - last.chainageM).toBeGreaterThanOrEqual(0)
    expect(network.lengthM - last.chainageM).toBeLessThan(2_000)
  })
})

describe('corridor geometry', () => {
  it('is continuous — no gap between consecutive points beyond 100 m', () => {
    for (let i = 1; i < network.corridor.length; i++) {
      const gap = haversineM(network.corridor[i - 1], network.corridor[i])
      expect(gap, `gap at point ${i}`).toBeLessThan(100)
    }
  })

  it('starts at Churchgate and ends at Dahanu Road', () => {
    const first = network.corridor[0]
    const last = network.corridor[network.corridor.length - 1]
    const churchgate = station('Churchgate')
    const dahanu = station('Dahanu Road')
    expect(haversineM(first, [churchgate.lon, churchgate.lat])).toBeLessThan(500)
    expect(haversineM(last, [dahanu.lon, dahanu.lat])).toBeLessThan(500)
  })

  it('sums to the declared corridor length', () => {
    let total = 0
    for (let i = 1; i < network.corridor.length; i++) {
      total += haversineM(network.corridor[i - 1], network.corridor[i])
    }
    expect(Math.abs(total - network.lengthM)).toBeLessThan(network.lengthM * 0.01)
  })
})

describe('fast-halt flags', () => {
  it('marks the real fast pattern south of Borivali, all stops beyond', () => {
    const borivali = station('Borivali').chainageM
    for (const s of network.stations) {
      const expected =
        s.chainageM > borivali || FAST_HALTS_SOUTH.includes(s.name)
      expect(s.fastHalt, s.name).toBe(expected)
    }
  })

  it('has every fast-halt station present in the station list', () => {
    for (const name of FAST_HALTS_SOUTH) {
      expect(station(name).fastHalt, name).toBe(true)
    }
  })
})

describe('track sections', () => {
  it('tile the corridor contiguously from 0 to lengthM', () => {
    expect(network.sections[0].fromM).toBe(0)
    expect(network.sections[network.sections.length - 1].toM).toBe(
      network.lengthM,
    )
    for (let i = 1; i < network.sections.length; i++) {
      expect(network.sections[i].fromM).toBe(network.sections[i - 1].toM)
    }
    for (const s of network.sections) {
      expect(s.toM).toBeGreaterThan(s.fromM)
      expect(s.tracks).toBeGreaterThanOrEqual(2)
    }
  })

  it('matches the validated real-world track configuration', () => {
    // 4 Churchgate–Mumbai Central
    expect(tracksBetween('Marine Lines', 'Charni Road')).toBe(4)
    // 5–6 Mumbai Central–Borivali
    expect(tracksBetween('Mahalaxmi', 'Lower Parel')).toBeGreaterThanOrEqual(5)
    expect(tracksBetween('Mahalaxmi', 'Lower Parel')).toBeLessThanOrEqual(6)
    expect(tracksBetween('Santacruz', 'Vile Parle')).toBeGreaterThanOrEqual(5)
    expect(tracksBetween('Santacruz', 'Vile Parle')).toBeLessThanOrEqual(6)
    expect(tracksBetween('Malad', 'Kandivali')).toBeGreaterThanOrEqual(5)
    expect(tracksBetween('Malad', 'Kandivali')).toBeLessThanOrEqual(6)
    // 4 Borivali–Virar
    expect(tracksBetween('Mira Road', 'Bhayandar')).toBe(4)
    expect(tracksBetween('Vasai Road', 'Nallasopara')).toBe(4)
    // 2 Virar–Dahanu Road
    expect(tracksBetween('Saphale', 'Kelve Road')).toBe(2)
    expect(tracksBetween('Boisar', 'Vangaon')).toBe(2)
  })

  it('pins the known 4-track gaps OSM maps inside Mumbai Central–Borivali', () => {
    // The spec's "5–6 to Borivali" is the classic description; OSM — the
    // spec's declared ground truth — maps two 4-track stretches: Mahim–Khar
    // (the adjacent pair there is the Harbour line, a separate service) and
    // the Kandivali–Borivali approach (6th line still under construction).
    // Pinning them means a re-bake that changes reality fails loudly here.
    expect(tracksBetween('Mahim Junction', 'Bandra')).toBe(4)
    expect(tracksBetween('Kandivali', 'Borivali')).toBe(4)
  })
})

describe('provenance', () => {
  it('records line identity and bake metadata', () => {
    expect(network.line).toBe('western')
    expect(network.name).toMatch(/Western/)
    expect(network.bakedAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(network.source).toMatch(/OpenStreetMap/i)
  })
})
