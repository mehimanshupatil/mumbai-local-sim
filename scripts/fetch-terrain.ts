/**
 * Bake the terrain heightfield from AWS Terrain Tiles (terrarium encoding).
 * Ported from the mumbai-lakes pipeline. One-time offline script: fetches
 * zoom-11 tiles covering the corridor (cached in scripts/.cache/terrain/),
 * decodes terrarium RGB to metres, downsamples 2x2, and writes
 * public/terrain/heights.bin (Int16LE) + meta.json. No runtime tile fetches.
 *
 * Usage: pnpm bake:terrain [--refresh]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(ROOT, 'scripts', '.cache', 'terrain')
const OUT_DIR = join(ROOT, 'public', 'terrain')
const REFRESH = process.argv.includes('--refresh')

// Coverage: corridor plus sea to the west and hills to the east.
const WEST = 72.5
const EAST = 73.15
const SOUTH = 18.8
const NORTH = 20.15
const ZOOM = 11
const DOWNSAMPLE = 2

const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z
const latToTileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
}
const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180
const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

async function fetchTile(z: number, x: number, y: number): Promise<Buffer> {
  const cacheFile = join(CACHE_DIR, `${z}-${x}-${y}.png`)
  if (!REFRESH && existsSync(cacheFile)) return readFileSync(cacheFile)
  const url = TILE_URL(z, x, y)
  console.log(`fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile, buf)
  return buf
}

async function main() {
  const x0 = Math.floor(lonToTileX(WEST, ZOOM))
  const x1 = Math.floor(lonToTileX(EAST, ZOOM))
  const y0 = Math.floor(latToTileY(NORTH, ZOOM)) // north = smaller tile y
  const y1 = Math.floor(latToTileY(SOUTH, ZOOM))
  const tilesX = x1 - x0 + 1
  const tilesY = y1 - y0 + 1
  console.log(`${tilesX}x${tilesY} tiles at z${ZOOM}`)

  // Stitch raw 256px tiles into one grid of metres.
  const rawW = tilesX * 256
  const rawH = tilesY * 256
  const raw = new Float32Array(rawW * rawH)
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const png = PNG.sync.read(await fetchTile(ZOOM, tx, ty))
      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const idx = (py * 256 + px) * 4
          const h =
            (png.data[idx] * 256 + png.data[idx + 1] + png.data[idx + 2] / 256) - 32768
          raw[((ty - y0) * 256 + py) * rawW + (tx - x0) * 256 + px] = h
        }
      }
    }
  }

  // Downsample by block average.
  const w = Math.floor(rawW / DOWNSAMPLE)
  const h = Math.floor(rawH / DOWNSAMPLE)
  const heights = new Int16Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < DOWNSAMPLE; dy++) {
        for (let dx = 0; dx < DOWNSAMPLE; dx++) {
          sum += raw[(y * DOWNSAMPLE + dy) * rawW + (x * DOWNSAMPLE + dx)]
        }
      }
      heights[y * w + x] = Math.round(sum / (DOWNSAMPLE * DOWNSAMPLE))
    }
  }

  // Geographic bounds of the stitched tile grid (exact, not the request box).
  const meta = {
    width: w,
    height: h,
    west: tileXToLon(x0, ZOOM),
    east: tileXToLon(x1 + 1, ZOOM),
    north: tileYToLat(y0, ZOOM),
    south: tileYToLat(y1 + 1, ZOOM),
    zoom: ZOOM,
    downsample: DOWNSAMPLE,
    encoding: 'int16-le metres, row 0 = north edge',
    source: 'AWS Terrain Tiles (terrarium), https://registry.opendata.aws/terrain-tiles/',
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'heights.bin'), Buffer.from(heights.buffer))
  writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2))
  console.log(`wrote ${w}x${h} heightfield (${((w * h * 2) / 1024 / 1024).toFixed(1)} MB)`)
  console.log(meta)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
