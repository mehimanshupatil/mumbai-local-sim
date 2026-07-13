/**
 * Bake the Western line network JSON from OpenStreetMap.
 *
 * One-time offline script: fetches rail ways and station nodes from Overpass
 * (cached under scripts/.cache/), derives the corridor centerline, station
 * chainage, and per-section track counts, validates against known reality,
 * and writes src/data/western.json. The site never calls Overpass at runtime.
 *
 * Usage: pnpm bake [--refresh]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { haversineM, type LonLat } from '../src/data/geo'
import type { NetworkData, StationRecord, TrackSection } from '../src/data/network-types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(ROOT, 'scripts', '.cache')
const OUT_PATH = join(ROOT, 'src', 'data', 'western.json')
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const USER_AGENT = 'mumbai-local-sim-bake/0.1 (https://github.com/mehimanshupatil/mumbai-local-sim)'
const REFRESH = process.argv.includes('--refresh')

// Corridor bounding boxes (south,west,north,east): Churchgate→Virar and Virar→Dahanu Road.
const BBOX_SOUTH = '18.92,72.79,19.48,72.90'
const BBOX_NORTH = '19.44,72.60,20.06,72.92'

// Route relations whose member ways must not count as Western line tracks:
// Harbour line shares the corridor Mahim→Goregaon, and the Western DFC runs
// parallel north of Vasai.
const EXCLUDED_RELATION_QUERY =
  'relation["route"="train"]["name"~"Harbour",i](around:80000,19.1,72.87);relation(12145132);'

// Western Line (slow): Churchgate => Virar — its member ways anchor the
// centerline to the WR corridor where parallel lines share the alignment.
const WR_RELATION_ID = 11511060

/**
 * The 37 Western line stations Churchgate → Dahanu Road. OSM is ground truth
 * for positions and names; this list pins order, expected count, fast-halt
 * flags, and a Marathi fallback for nodes missing name:mr.
 *
 * Fast halts (south of Borivali): the real WR fast pattern. North of
 * Borivali every service stops everywhere, so fastHalt is true there.
 */
const STATIONS: { name: string; nameMr: string; fastHalt: boolean }[] = [
  { name: 'Churchgate', nameMr: 'चर्चगेट', fastHalt: true },
  { name: 'Marine Lines', nameMr: 'मरीन लाइन्स', fastHalt: false },
  { name: 'Charni Road', nameMr: 'चर्नी रोड', fastHalt: false },
  { name: 'Grant Road', nameMr: 'ग्रँट रोड', fastHalt: false },
  { name: 'Mumbai Central', nameMr: 'मुंबई सेंट्रल', fastHalt: true },
  { name: 'Mahalaxmi', nameMr: 'महालक्ष्मी', fastHalt: false },
  { name: 'Lower Parel', nameMr: 'लोअर परळ', fastHalt: false },
  { name: 'Prabhadevi', nameMr: 'प्रभादेवी', fastHalt: false },
  { name: 'Dadar', nameMr: 'दादर', fastHalt: true },
  { name: 'Matunga Road', nameMr: 'माटुंगा रोड', fastHalt: false },
  { name: 'Mahim Junction', nameMr: 'माहीम जंक्शन', fastHalt: false },
  { name: 'Bandra', nameMr: 'वांद्रे', fastHalt: true },
  { name: 'Khar Road', nameMr: 'खार रोड', fastHalt: false },
  { name: 'Santacruz', nameMr: 'सांताक्रूझ', fastHalt: false },
  { name: 'Vile Parle', nameMr: 'विलेपार्ले', fastHalt: false },
  { name: 'Andheri', nameMr: 'अंधेरी', fastHalt: true },
  { name: 'Jogeshwari', nameMr: 'जोगेश्वरी', fastHalt: false },
  { name: 'Ram Mandir', nameMr: 'राम मंदिर', fastHalt: false },
  { name: 'Goregaon', nameMr: 'गोरेगाव', fastHalt: false },
  { name: 'Malad', nameMr: 'मालाड', fastHalt: false },
  { name: 'Kandivali', nameMr: 'कांदिवली', fastHalt: false },
  { name: 'Borivali', nameMr: 'बोरिवली', fastHalt: true },
  { name: 'Dahisar', nameMr: 'दहिसर', fastHalt: true },
  { name: 'Mira Road', nameMr: 'मीरा रोड', fastHalt: true },
  { name: 'Bhayandar', nameMr: 'भाईंदर', fastHalt: true },
  { name: 'Naigaon', nameMr: 'नायगाव', fastHalt: true },
  { name: 'Vasai Road', nameMr: 'वसई रोड', fastHalt: true },
  { name: 'Nallasopara', nameMr: 'नालासोपारा', fastHalt: true },
  { name: 'Virar', nameMr: 'विरार', fastHalt: true },
  { name: 'Vaitarna', nameMr: 'वैतरणा', fastHalt: true },
  { name: 'Saphale', nameMr: 'सफाळे', fastHalt: true },
  { name: 'Kelve Road', nameMr: 'केळवे रोड', fastHalt: true },
  { name: 'Palghar', nameMr: 'पालघर', fastHalt: true },
  { name: 'Umroli', nameMr: 'उमरोळी', fastHalt: true },
  { name: 'Boisar', nameMr: 'बोईसर', fastHalt: true },
  { name: 'Vangaon', nameMr: 'वाणगाव', fastHalt: true },
  { name: 'Dahanu Road', nameMr: 'डहाणू रोड', fastHalt: true },
]

/** Known real-world track counts, validated against what OSM yields. */
const EXPECTED_TRACKS: { from: string; to: string; min: number; max: number }[] = [
  { from: 'Churchgate', to: 'Mumbai Central', min: 4, max: 4 },
  // Spec story 11: 4–6 south of Borivali. Mahim–Bandra is genuinely 4 WR
  // running lines (the adjacent pair there is the Harbour line, excluded).
  { from: 'Mumbai Central', to: 'Borivali', min: 4, max: 6 },
  { from: 'Borivali', to: 'Virar', min: 4, max: 4 },
  { from: 'Virar', to: 'Dahanu Road', min: 2, max: 2 },
]

interface OsmNode {
  type: 'node'
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}
interface OsmWay {
  type: 'way'
  id: number
  nodes: number[]
  geometry: { lat: number; lon: number }[]
  tags?: Record<string, string>
}
interface OsmRelation {
  type: 'relation'
  id: number
  members: { type: string; ref: number; role: string }[]
  tags?: Record<string, string>
}
type OsmElement = OsmNode | OsmWay | OsmRelation

async function overpass(name: string, body: string): Promise<OsmElement[]> {
  const cacheFile = join(CACHE_DIR, `${name}.json`)
  if (!REFRESH && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')).elements
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length]
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt))
    console.log(`fetching ${name} from ${new URL(endpoint).host}…`)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(`[out:json][timeout:250];${body}`)}`,
      })
      if (!res.ok) throw new Error(`Overpass ${name}: HTTP ${res.status}`)
      const text = await res.text()
      // Parse before caching so a truncated/HTML body never poisons the cache.
      const elements = JSON.parse(text).elements
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(cacheFile, text)
      return elements
    } catch (err) {
      lastError = err
      console.warn(String(err))
    }
  }
  throw lastError
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z]/g, '')

/** Local equirectangular projection to metres around a reference latitude. */
function toXY(p: LonLat, refLat: number): [number, number] {
  const mPerDegLat = 111_320
  const mPerDegLon = 111_320 * Math.cos((refLat * Math.PI) / 180)
  return [p[0] * mPerDegLon, p[1] * mPerDegLat]
}

// ---------------------------------------------------------------------------
// Graph + shortest path (centerline)
// ---------------------------------------------------------------------------

class MinHeap {
  private items: [number, number][] = [] // [dist, nodeId]
  get size() {
    return this.items.length
  }
  push(dist: number, id: number) {
    const a = this.items
    a.push([dist, id])
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): [number, number] {
    const a = this.items
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

function shortestPath(
  adjacency: Map<number, [number, number][]>,
  start: number,
  goal: number,
): number[] {
  const dist = new Map<number, number>([[start, 0]])
  const prev = new Map<number, number>()
  const done = new Set<number>()
  const heap = new MinHeap()
  heap.push(0, start)
  while (heap.size > 0) {
    const [d, u] = heap.pop()
    if (done.has(u)) continue
    done.add(u)
    if (u === goal) break
    for (const [v, w] of adjacency.get(u) ?? []) {
      const nd = d + w
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd)
        prev.set(v, u)
        heap.push(nd, v)
      }
    }
  }
  if (!done.has(goal)) throw new Error('no rail path between termini — graph disconnected')
  const path: number[] = []
  for (let u: number | undefined = goal; u !== undefined; u = prev.get(u)) path.push(u)
  return path.reverse()
}

// ---------------------------------------------------------------------------
// Polyline helpers
// ---------------------------------------------------------------------------

function cumulative(points: LonLat[]): number[] {
  const out = [0]
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + haversineM(points[i - 1], points[i]))
  }
  return out
}

/** Chainage of, and distance to, the closest point on the polyline to p. */
function projectChainage(
  points: LonLat[],
  chain: number[],
  p: LonLat,
): { chainageM: number; distanceM: number } {
  const [px, py] = toXY(p, p[1])
  let best = Infinity
  let bestChain = 0
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = toXY(points[i - 1], p[1])
    const [bx, by] = toXY(points[i], p[1])
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const qx = ax + t * dx
    const qy = ay + t * dy
    const d2 = (px - qx) ** 2 + (py - qy) ** 2
    if (d2 < best) {
      best = d2
      bestChain = chain[i - 1] + t * (chain[i] - chain[i - 1])
    }
  }
  return { chainageM: bestChain, distanceM: Math.sqrt(best) }
}

/** Point + unit tangent at a given chainage (clamped to the polyline). */
function pointAt(points: LonLat[], chain: number[], m: number): { p: LonLat; tangent: [number, number] } {
  let i = 1
  while (i < chain.length - 1 && chain[i] < m) i++
  const t = Math.max(0, Math.min(1, (m - chain[i - 1]) / (chain[i] - chain[i - 1] || 1)))
  const a = points[i - 1]
  const b = points[i]
  const p: LonLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
  const [ax, ay] = toXY(a, p[1])
  const [bx, by] = toXY(b, p[1])
  const len = Math.hypot(bx - ax, by - ay) || 1
  return { p, tangent: [(bx - ax) / len, (by - ay) / len] }
}

/** Slice the polyline between two chainages (interpolating the cut points). */
function slicePolyline(points: LonLat[], chain: number[], fromM: number, toM: number): LonLat[] {
  const out: LonLat[] = [pointAt(points, chain, fromM).p]
  for (let i = 0; i < points.length; i++) {
    if (chain[i] > fromM && chain[i] < toM) out.push(points[i])
  }
  out.push(pointAt(points, chain, toM).p)
  return out
}

/** Douglas-Peucker simplification (epsilon in metres), then cap gaps at maxGapM. */
function simplify(points: LonLat[], epsilonM: number, maxGapM: number): LonLat[] {
  const refLat = points[0][1]
  const xy = points.map((p) => toXY(p, refLat))
  const keep = new Array(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [s, e] = stack.pop()!
    const [ax, ay] = xy[s]
    const [bx, by] = xy[e]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    let maxD = 0
    let maxI = -1
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((xy[i][0] - ax) * dy - (xy[i][1] - ay) * dx) / len
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > epsilonM && maxI > 0) {
      keep[maxI] = true
      stack.push([s, maxI], [maxI, e])
    }
  }
  const kept = points.filter((_, i) => keep[i])
  // Re-densify long straights so consumers can rely on bounded point spacing.
  const out: LonLat[] = [kept[0]]
  for (let i = 1; i < kept.length; i++) {
    const gap = haversineM(kept[i - 1], kept[i])
    const steps = Math.ceil(gap / maxGapM)
    for (let s = 1; s <= steps; s++) {
      out.push([
        kept[i - 1][0] + ((kept[i][0] - kept[i - 1][0]) * s) / steps,
        kept[i - 1][1] + ((kept[i][1] - kept[i - 1][1]) * s) / steps,
      ])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Track counting
// ---------------------------------------------------------------------------

/** Spatial grid of way segments for fast perpendicular-intersection queries. */
class SegmentIndex {
  private cells = new Map<string, { wayId: number; a: LonLat; b: LonLat }[]>()
  private cellDeg = 0.003 // ~330 m

  add(wayId: number, a: LonLat, b: LonLat) {
    for (const key of this.keysFor(a, b)) {
      let cell = this.cells.get(key)
      if (!cell) this.cells.set(key, (cell = []))
      cell.push({ wayId, a, b })
    }
  }

  /** Cells along the whole segment — long bridge segments span many cells. */
  private keysFor(a: LonLat, b: LonLat): string[] {
    const keys = new Set<string>()
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (this.cellDeg / 2)),
    )
    for (let s = 0; s <= steps; s++) {
      const lon = a[0] + ((b[0] - a[0]) * s) / steps
      const lat = a[1] + ((b[1] - a[1]) * s) / steps
      const x = Math.floor(lon / this.cellDeg)
      const y = Math.floor(lat / this.cellDeg)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) keys.add(`${x + dx},${y + dy}`)
    }
    return [...keys]
  }

  near(p: LonLat): { wayId: number; a: LonLat; b: LonLat }[] {
    const x = Math.floor(p[0] / this.cellDeg)
    const y = Math.floor(p[1] / this.cellDeg)
    return this.cells.get(`${x},${y}`) ?? []
  }
}

function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
  if (d === 0) return false
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/** Number of distinct running-track ways crossing the perpendicular at chainage m. */
function countTracksAt(
  centerline: LonLat[],
  chain: number[],
  m: number,
  index: SegmentIndex,
  halfWidthM: number,
): number {
  const { p, tangent } = pointAt(centerline, chain, m)
  const refLat = p[1]
  const [px, py] = toXY(p, refLat)
  const normal: [number, number] = [-tangent[1], tangent[0]]
  const e1: [number, number] = [px + normal[0] * halfWidthM, py + normal[1] * halfWidthM]
  const e2: [number, number] = [px - normal[0] * halfWidthM, py - normal[1] * halfWidthM]
  const hit = new Set<number>()
  for (const seg of index.near(p)) {
    if (hit.has(seg.wayId)) continue
    const a = toXY(seg.a, refLat)
    const b = toXY(seg.b, refLat)
    if (segmentsIntersect(e1, e2, a, b)) hit.add(seg.wayId)
  }
  return hit.size
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

async function main() {
  // Fetched sequentially on purpose — Overpass rate-limits parallel queries.
  const railSouth = await overpass('rail-south', `way["railway"="rail"](${BBOX_SOUTH});out geom;`)
  const railNorth = await overpass('rail-north', `way["railway"="rail"](${BBOX_NORTH});out geom;`)
  const stationNodes = await overpass(
    'stations',
    `(node["railway"="station"](${BBOX_SOUTH});node["railway"="station"](${BBOX_NORTH}););out;`,
  )
  const excludeRels = await overpass('exclude-rels', `(${EXCLUDED_RELATION_QUERY});out;`)
  const wrRels = await overpass('wr-relation', `relation(${WR_RELATION_ID});out;`)

  const ways = new Map<number, OsmWay>()
  for (const el of [...railSouth, ...railNorth]) {
    if (el.type === 'way') ways.set(el.id, el)
  }
  console.log(`${ways.size} rail ways`)

  const excludedWayIds = new Set<number>()
  for (const el of excludeRels) {
    if (el.type !== 'relation') continue
    console.log(`excluding tracks of: ${el.tags?.name}`)
    for (const m of el.members) if (m.type === 'way') excludedWayIds.add(m.ref)
  }
  const wrWayIds = new Set<number>()
  for (const el of wrRels) {
    if (el.type === 'relation') for (const m of el.members) if (m.type === 'way') wrWayIds.add(m.ref)
  }

  // --- rail graph over every fetched way (breadth keeps it connected) ---
  // Edge weights bias the shortest path onto the WR corridor: parallel
  // Harbour/DFC tracks and yard links stay routable but expensive, so the
  // centerline never drifts onto them where lines share the alignment.
  const PARALLEL_LINE_PENALTY = 5
  const SERVICE_TRACK_PENALTY = 3
  const WR_CORRIDOR_BONUS = 0.98
  const wayCost = (way: OsmWay): number => {
    if (excludedWayIds.has(way.id)) return PARALLEL_LINE_PENALTY
    if (way.tags?.service) return SERVICE_TRACK_PENALTY
    if (wrWayIds.has(way.id)) return WR_CORRIDOR_BONUS
    return 1
  }
  const nodeCoord = new Map<number, LonLat>()
  const adjacency = new Map<number, [number, number][]>()
  for (const way of ways.values()) {
    const cost = wayCost(way)
    for (let i = 0; i < way.nodes.length; i++) {
      nodeCoord.set(way.nodes[i], [way.geometry[i].lon, way.geometry[i].lat])
    }
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1]
      const b = way.nodes[i]
      const w = haversineM(nodeCoord.get(a)!, nodeCoord.get(b)!) * cost
      if (!adjacency.has(a)) adjacency.set(a, [])
      if (!adjacency.has(b)) adjacency.set(b, [])
      adjacency.get(a)!.push([b, w])
      adjacency.get(b)!.push([a, w])
    }
  }

  // --- match curated stations to OSM nodes ---
  const candidates = stationNodes.filter(
    (el): el is OsmNode =>
      el.type === 'node' && !['subway', 'monorail', 'light_rail'].includes(el.tags?.station ?? ''),
  )
  const matched = STATIONS.map((s) => {
    const norm = normalize(s.name)
    let found = candidates.filter((c) => normalize(c.tags?.name ?? '') === norm)
    const suburban = found.filter((c) => c.tags?.network === 'Mumbai Suburban Railway')
    if (suburban.length > 0) found = suburban
    if (found.length === 0) {
      throw new Error(
        `no OSM station matches "${s.name}" — nearby names: ${candidates
          .map((c) => c.tags?.name)
          .filter((n) => n && normalize(n).includes(norm.slice(0, 4)))
          .join(', ')}`,
      )
    }
    return { ...s, osm: found }
  })

  // --- centerline: shortest rail path Churchgate → Dahanu Road ---
  const nearestGraphNode = (p: LonLat): number => {
    let best = Infinity
    let bestId = -1
    for (const [id, c] of nodeCoord) {
      const d = haversineM(p, c)
      if (d < best) {
        best = d
        bestId = id
      }
    }
    return bestId
  }
  const churchgateNode = matched[0].osm[0]
  const dahanuNode = matched[matched.length - 1].osm[0]
  const path = shortestPath(
    adjacency,
    nearestGraphNode([churchgateNode.lon, churchgateNode.lat]),
    nearestGraphNode([dahanuNode.lon, dahanuNode.lat]),
  )
  let centerline = path.map((id) => nodeCoord.get(id)!)
  let chain = cumulative(centerline)
  console.log(`centerline: ${centerline.length} pts, ${(chain[chain.length - 1] / 1000).toFixed(1)} km`)

  // --- stations: pick nearest matched node to centerline, project chainage ---
  const rawStations = matched.map((s) => {
    const byDist = s.osm
      .map((c) => ({ c, proj: projectChainage(centerline, chain, [c.lon, c.lat]) }))
      .sort((a, b) => a.proj.distanceM - b.proj.distanceM)
    const pick = byDist[0]
    if (pick.proj.distanceM > 600) {
      throw new Error(`"${s.name}" matched node is ${pick.proj.distanceM.toFixed(0)} m off-corridor`)
    }
    return {
      ...s,
      lat: pick.c.lat,
      lon: pick.c.lon,
      nameMr: pick.c.tags?.['name:mr'] ?? s.nameMr,
      chainageM: pick.proj.chainageM,
    }
  })

  // --- rebase: chainage 0 at Churchgate, corridor trimmed to the termini ---
  const startM = rawStations[0].chainageM
  const endM = rawStations[rawStations.length - 1].chainageM
  centerline = slicePolyline(centerline, chain, startM, endM)
  chain = cumulative(centerline)
  const lengthM = Math.round(chain[chain.length - 1])
  const stations: StationRecord[] = rawStations.map((s, i) => ({
    id: normalize(s.name),
    name: s.name,
    nameMr: s.nameMr,
    lat: Number(s.lat.toFixed(6)),
    lon: Number(s.lon.toFixed(6)),
    chainageM: i === 0 ? 0 : i === rawStations.length - 1 ? lengthM : Math.round(s.chainageM - startM),
    fastHalt: s.fastHalt,
  }))
  for (let i = 1; i < stations.length; i++) {
    if (stations[i].chainageM <= stations[i - 1].chainageM) {
      throw new Error(`chainage not monotonic at ${stations[i].name}`)
    }
  }

  // --- track counting: running tracks only, Harbour/DFC excluded ---
  const index = new SegmentIndex()
  for (const way of ways.values()) {
    const t = way.tags ?? {}
    if (excludedWayIds.has(way.id)) continue
    // Yard/siding/spur/crossover links are not running tracks — but a few WR
    // running lines carry both usage=main and a service tag near yards.
    if (t.service && t.usage !== 'main') continue
    if (['industrial', 'military', 'tourism', 'test'].includes(t.usage ?? '')) continue
    for (let i = 1; i < way.geometry.length; i++) {
      index.add(
        way.id,
        [way.geometry[i - 1].lon, way.geometry[i - 1].lat],
        [way.geometry[i].lon, way.geometry[i].lat],
      )
    }
  }

  const SAMPLE_M = 100
  const HALF_WIDTH_M = 50
  const spans: { tracks: number; fromM: number; toM: number }[] = []
  for (let i = 1; i < stations.length; i++) {
    const fromM = stations[i - 1].chainageM
    const toM = stations[i].chainageM
    // Skip the station throats, where platform loops distort counts.
    const skirtM = Math.min(300, Math.floor((toM - fromM) / 4))
    const counts: number[] = []
    for (let m = fromM + skirtM; m <= toM - skirtM; m += SAMPLE_M) {
      counts.push(countTracksAt(centerline, chain, m, index, HALF_WIDTH_M))
    }
    spans.push({ tracks: median(counts), fromM, toM })
    console.log(
      `${stations[i - 1].name.padEnd(16)} → ${stations[i].name.padEnd(16)} tracks=${median(counts)} (samples: ${counts.join(',')})`,
    )
  }

  // --- validate span medians against known reality ---
  const chainOf = (name: string) => stations.find((s) => s.name === name)!.chainageM
  const problems: string[] = []
  for (const exp of EXPECTED_TRACKS) {
    const lo = chainOf(exp.from)
    const hi = chainOf(exp.to)
    for (const span of spans) {
      if (span.fromM < lo || span.toM > hi) continue
      if (span.tracks < exp.min || span.tracks > exp.max) {
        problems.push(
          `${exp.from}–${exp.to} expects ${exp.min}–${exp.max} tracks, but span at ` +
            `${span.fromM}–${span.toM} m counted ${span.tracks}`,
        )
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`track counts disagree with validated reality:\n  ${problems.join('\n  ')}`)
  }
  // The classic description of this stretch is 5–6 tracks; OSM (our ground
  // truth) maps a few 4-track gaps in it. Surface those so a re-bake that
  // changes them is noticed, not silently absorbed.
  for (const span of spans) {
    if (span.fromM >= chainOf('Mumbai Central') && span.toM <= chainOf('Borivali') && span.tracks < 5) {
      console.warn(
        `note: ${span.fromM}–${span.toM} m inside Mumbai Central–Borivali is ${span.tracks}-track in OSM`,
      )
    }
  }

  // --- merge equal-count spans into sections tiling [0, lengthM] ---
  const sections: TrackSection[] = []
  for (const span of spans) {
    const last = sections[sections.length - 1]
    if (last && last.tracks === span.tracks) last.toM = span.toM
    else sections.push({ fromM: span.fromM, toM: span.toM, tracks: span.tracks })
  }

  const corridor = simplify(centerline, 2, 80).map(
    ([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))] as LonLat,
  )

  const network: NetworkData = {
    line: 'western',
    name: 'Western Line',
    lengthM,
    stations,
    corridor,
    sections,
    bakedAt: new Date().toISOString().slice(0, 10),
    source: 'OpenStreetMap via Overpass API (ODbL)',
  }
  writeFileSync(OUT_PATH, JSON.stringify(network))
  console.log(
    `\nwrote ${OUT_PATH}: ${stations.length} stations, ${(lengthM / 1000).toFixed(1)} km, ` +
      `${corridor.length} corridor pts, ${sections.length} sections`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
