# mumbai-local-sim

3D simulation of the Mumbai local (Western line v1), React + react-three-fiber + TypeScript strict + pnpm. Spec is GitHub issue #1; work is ticketed in issues #2–12, one commit per ticket on main with `Closes #N`.

## Architecture (spec-mandated seams)

- `src/sim/` — pure simulation core: `(network, services, simTime) → TrainState[]`. **No React or three.js imports here, ever.** Deterministic: same inputs, same output.
- `src/data/` — baked network JSON (`western.json`) + line-agnostic types. True-scale WGS84/chainage data; visual exaggeration happens only at render time (`src/scene/config.ts`).
- `src/scene/` — rendering layer; consumes sim output. The train visual is a swappable component.
- Future lines (Central, Harbour, Metro) must arrive as new baked datasets, not new code paths.

## Testing (two seams only)

- Sim core: unit tests on `trainStates` output — tests read like operations facts (headways, dwell ~30 s, stop sequences, deterministic replay).
- Baked data: invariant tests over the committed JSON (`src/data/western.test.ts`).
- Rendering has **no component tests by design** — verify visually: `pnpm dev`, then in the browser console use `window.simClock` (`.t` = seconds since midnight IST, `.speed = 0` to freeze) to park trains for screenshots.

## Commands

- `pnpm test` / `pnpm build` (tsc -b + vite) / `pnpm dev`
- `pnpm bake` — re-bake network JSON from OSM Overpass. Responses cached in `scripts/.cache/` (gitignored); `--refresh` refetches. Bake validates station order, chainage monotonicity, and per-section track counts against known reality and fails loudly on drift.
- `pnpm bake:realtimetable` — re-bake `src/data/western-real-timetable.json` from official WR Public Time Tables. Two-stage pipeline: `pip install -r scripts/requirements-timetable.txt && python3 scripts/extract-timetable-pdfs.py` globs every PDF in `data/timetable/` and does position-based grid extraction (direction/AC-ness read from each PDF's own header text, not its filename), writing `scripts/.cache/timetable-raw.json`; then `pnpm bake:realtimetable` (TS) maps station names to network ids, repairs known extraction noise, splits round-trip diagrams, classifies each service, and validates before committing. Re-run both whenever WR publishes a new PTT — just drop the new PDF(s) into `data/timetable/`, any filename.

## Quirks

- pnpm 11: build-script approvals live in `pnpm-workspace.yaml` (`allowBuilds`), not package.json.
- Track counts genuinely differ per section (4 / 5–6 / 4 / 2 along the corridor); two 4-track gaps inside Mumbai Central–Borivali are real (Harbour line is a separate excluded service; 6th line under construction) and are pinned by tests — don't "fix" them.
- Real WR fast trains run several distinct calling patterns, not the one idealized skip-list the v1 spec assumed (confirmed baking `western-real-timetable.json`: only ~37% of real fast services match that exact pattern south of Borivali). What holds universally is that every major interchange stays served — see `src/data/western-real-timetable.test.ts`.
