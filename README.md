# Mumbai Local

A real-time 3D simulation of the Mumbai suburban railway — Western line v1,
Churchgate → Dahanu Road — running a full synthetic service day over real
geography.

**Live:** https://mehimanshupatil.github.io/mumbai-local-sim/

![Morning peak at Dadar](docs/screenshots/dadar-peak.png)

## What it does

- Real track geometry and all 37 stations baked from OpenStreetMap, draped
  over a real terrain heightfield — the Arabian Sea, Mahim bay, the Vasai
  creek crossing, and the Sahyadri foothills are where they belong.
- A pure, deterministic simulation core runs slow and fast locals in both
  directions at real headways (4 min peak / 8 min off-peak), the real fast
  skip-stop pattern, blue AC rakes, nonstop long-distance expresses, and
  Virar–Dahanu shuttles. Fast locals genuinely overtake slows — it emerges
  from the physics, nothing is scripted.
- Kinematics are calibrated against real per-leg runtimes: Churchgate→Virar
  slow takes the true ~95 minutes.
- A sim clock (pause / 1× / 10× / 60×, one-shot sync to live IST) drives the
  timetable *and* a day/night cycle — at 60× the corridor sweeps dawn, golden
  dusk, and a lamp-lit night with headlights and glowing coach windows.
- Click a train for a chase camera; click a station for its arrivals board
  (predictions come from the same timetables the trains run, so they can't
  disagree). Navigation works like a maps app: drag pans, right-drag tilts,
  wheel zooms to cursor.

![Night at Dadar](docs/screenshots/dadar-night.png)
![The full corridor](docs/screenshots/corridor-peak.png)

## Run it

```sh
pnpm install
pnpm dev      # dev server
pnpm test     # sim-core + baked-data invariant tests
pnpm build    # typecheck + production bundle
```

## Data baking

All geographic data is baked offline and committed — the site makes no
runtime calls to OSM or elevation services.

```sh
pnpm bake           # network: stations, chainage, track sections ← Overpass
pnpm bake:terrain   # heightfield ← AWS Terrain Tiles (terrarium)
```

Both scripts cache raw responses under `scripts/.cache/` (add `--refresh` to
refetch) and validate against known reality — station order, monotonic
chainage, per-section track counts (4 Churchgate–Mumbai Central, 4–6 to
Borivali, 4 to Virar, 2 beyond), sea west / hills east — failing loudly if
OSM drifts. Invariant tests over the committed JSON run in CI.

## Architecture

Two layers with one seam: a pure simulation core
(`(network, services, simTime) → TrainState[]`, no React/three.js — see
`src/sim/`) and a rendering layer that consumes it. The scheduler sits
behind an interface so a real scraped timetable can replace the synthetic
one (#13); the network format is line-agnostic so Central/Harbour arrive as
new baked datasets, not new code. See `CLAUDE.md` for conventions.

## Data sources & licenses

- Track/station data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium)
- Fonts: Noto Sans / Noto Sans Devanagari ([OFL](public/fonts/OFL.txt))
- Station metadata for kinematics calibration: `data/` (third-party, reference only)
