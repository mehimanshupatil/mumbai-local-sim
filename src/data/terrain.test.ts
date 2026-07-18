import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NetworkData } from './network-types'
import westernJson from './western.json'

const network = westernJson as NetworkData

const dir = join(__dirname, '..', '..', 'public', 'terrain')
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
const bin = readFileSync(join(dir, 'heights.bin'))
const heights = new Int16Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength))

function heightAt(lon: number, lat: number): number {
  const x = Math.round(((lon - meta.west) / (meta.east - meta.west)) * (meta.width - 1))
  const y = Math.round(((meta.north - lat) / (meta.north - meta.south)) * (meta.height - 1))
  return heights[y * meta.width + x]
}

describe('baked terrain heightfield', () => {
  it('matches its declared dimensions', () => {
    expect(heights.length).toBe(meta.width * meta.height)
  })

  it('covers the whole rail corridor with margin', () => {
    for (const s of network.stations) {
      expect(s.lon).toBeGreaterThan(meta.west + 0.05)
      expect(s.lon).toBeLessThan(meta.east - 0.05)
      expect(s.lat).toBeGreaterThan(meta.south + 0.05)
      expect(s.lat).toBeLessThan(meta.north - 0.05)
    }
  })

  it('has sea west of the corridor and hills east of it', () => {
    // Arabian Sea off Marine Drive.
    expect(heightAt(72.7, 18.95)).toBeLessThanOrEqual(0)
    // Sanjay Gandhi National Park ridge.
    expect(heightAt(72.93, 19.22)).toBeGreaterThan(100)
  })

  it('keeps every station on plausible coastal-plain ground', () => {
    for (const s of network.stations) {
      const h = heightAt(s.lon, s.lat)
      expect(h, s.name).toBeGreaterThan(-8)
      expect(h, s.name).toBeLessThan(90)
    }
  })

  it('shows Mahim bay as water west of Mahim Junction', () => {
    expect(heightAt(72.83, 19.04)).toBeLessThanOrEqual(0)
  })

  it('shows the Vasai creek as water between Bhayandar and Naigaon', () => {
    const bhayandar = network.stations.find((s) => s.name === 'Bhayandar')!
    const naigaon = network.stations.find((s) => s.name === 'Naigaon')!
    const midLat = (bhayandar.lat + naigaon.lat) / 2
    // Sample the creek just west of the rail bridge.
    const creek = heightAt(72.83, midLat)
    expect(creek).toBeLessThanOrEqual(1)
  })
})
