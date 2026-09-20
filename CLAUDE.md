# mumbai-local-sim

3D simulation of the Mumbai local (Western Route v1), React + react-three-fiber + TypeScript strict + pnpm. Spec is GitHub issue #1; work is ticketed in issues #2–12, one commit per ticket on main with `Closes #N`.

## Vocabulary

`CONTEXT.md` pins the terms; the short version, because one word used to do
three jobs here: a **Route** is a whole corridor arriving as one baked dataset
(Western, Central, Harbour). A **Line** is what a Service is booked on — Slow /
Fast / Through by Up / Down, real WR usage, `LINE_*` in `src/sim/types.ts`. A
**Track** is one physical pair of rails, counted per Section and drawn as one
polyline; `trackForLine` (`src/sim/lines.ts`) says which Track a Line runs on
where a Section has fewer Tracks than Lines. "lane" is not a word here.

## Architecture (spec-mandated seams)

- `src/sim/` — pure simulation core: `(network, services, simTime) → TrainState[]`. **No React or three.js imports here, ever.** Deterministic: same inputs, same output.
- `src/data/` — baked network JSON (`western.json`) + line-agnostic types. True-scale WGS84/chainage data; visual exaggeration happens only at render time (`src/scene/config.ts`).
- `src/scene/` — rendering layer; consumes sim output. The train visual is a swappable component.
- Future Routes (Central, Harbour, Metro) must arrive as new baked datasets, not new code paths.

## Testing (two seams only)

- Sim core: unit tests on `trainStates` output — tests read like operations facts (headways, dwell ~30 s, stop sequences, deterministic replay).
- Baked data: invariant tests over the committed JSON (`src/data/western.test.ts`).
- Rendering has **no component tests by design** — verify visually: `pnpm dev`, then in the browser console use `window.simClock` (`.t` = seconds since midnight IST, `.speed = 0` to freeze) and `window.setFocus` (DEV only — `{mode: 'station', stationId}` / `{mode: 'follow', trainId}` / `{mode: 'free'}`) to park trains and cameras for screenshots. If the chrome-devtools MCP is unavailable, a one-off Playwright script against the cached Chromium at `~/Library/Caches/ms-playwright/` (find the actual binary path — it moves between `chrome-mac`/`chrome-mac-arm64` and product names across versions) works as a drop-in substitute for navigate/screenshot/console-error checks.

## Commands

- `pnpm test` / `pnpm build` (tsc -b + vite) / `pnpm dev`
- `pnpm bake` — re-bake network JSON from OSM Overpass. Responses cached in `scripts/.cache/` (gitignored); `--refresh` refetches. Bake validates station order, chainage monotonicity, and per-section track counts against known reality and fails loudly on drift.
- `pnpm bake:announcements` — re-bake the Phrase Bank (`public/audio/speech/*.m4a` + `src/data/phrase-bank.json`) with Piper TTS. Needs `pip install -r scripts/requirements-announcements.txt` and `ffmpeg`; voices download themselves into `scripts/.cache/`. Deterministic — noise scales pinned to zero, so a re-bake is byte-identical. Marathi and English only, and that is a licensing fact, not an oversight: see `docs/adr/0002-announcements-are-baked-synthetic-speech.md`.
- `pnpm bake:livery` — re-bake the Livery mask atlas (`public/livery/rake-masks.png`) from the proportions in `src/scene/livery-atlas.ts`. Greyscale masks channel-packed into one RGBA PNG (window / doorway / dirt / panel lines), never colour — Livery stays per-instance, so adding one is a colour constant, not a re-bake; see `docs/adr/0003-rake-detail-is-a-baked-mask-atlas.md`. Deterministic: `--check` asserts the committed file matches a fresh bake, and so does `src/scene/livery-atlas.test.ts`.
- `./scripts/fetch-beds.sh` — re-fetch the ambient Beds from Freesound and re-encode them (needs `curl` + `ffmpeg`; outputs in `public/audio/beds/` are committed, so a clone needs neither). Every clip must be credited in `docs/attribution.md` — that file is the CC-BY obligation, the script is only how the bytes arrived.
- `pnpm bake:realtimetable` — re-bake `src/data/western-real-timetable.json` from official WR Public Time Tables. Two-stage pipeline: `pip install -r scripts/requirements-timetable.txt && python3 scripts/extract-timetable-pdfs.py` globs every PDF in `data/timetable/` and does position-based grid extraction (direction/AC-ness read from each PDF's own header text, not its filename), writing `scripts/.cache/timetable-raw.json`; then `pnpm bake:realtimetable` (TS) maps station names to network ids, repairs known extraction noise, splits round-trip diagrams, classifies each service, and validates before committing. Re-run both whenever WR publishes a new PTT — just drop the new PDF(s) into `data/timetable/`, any filename.

## Quirks

- pnpm 11: build-script approvals live in `pnpm-workspace.yaml` (`allowBuilds`), not package.json.
- Track counts genuinely differ per section (4 / 5–6 / 4 / 2 along the corridor); two 4-Track gaps inside Mumbai Central–Borivali are real (the Harbour Route is a separate excluded service; a 6th Track is under construction) and are pinned by tests — don't "fix" them.
- Real WR fast trains run several distinct calling patterns, not the one idealized skip-list the v1 spec assumed (confirmed baking `western-real-timetable.json`: only ~37% of real fast services match that exact pattern south of Borivali). What holds universally is that every major interchange stays served — see `src/data/western-real-timetable.test.ts`.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `mehimanshupatil/mumbai-local-sim`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
