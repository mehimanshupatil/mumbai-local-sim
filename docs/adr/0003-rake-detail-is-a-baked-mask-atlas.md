# Rake detail is a baked mask atlas, not authored models or painted textures

Making a Rake read as a Mumbai local at the follow camera needs surface detail —
doorways, windows, panel lines, roof dirt, brake dust — that neither flat
`meshStandardMaterial` nor affordable geometry can carry at ~70 concurrent
12-car Rakes. We decided that detail arrives as **one 1024x1024 RGBA texture of
greyscale masks** (window / doorway / dirt / panel lines, one per channel),
baked deterministically by `pnpm bake:livery` from committed TS constants and
combined at draw time with the existing per-instance Livery colours.

## Considered options

**A GLTF rake and authored texture maps.** The obvious path, and rejected: it
drags in modelling tooling this repo has no story for, puts opaque binaries in
the tree, and needs a licence trail like `docs/attribution.md`. Every other
asset here is generated from committed inputs (`bake`, `bake:announcements`,
`bake:realtimetable`); ADR 0002 already chose generated over sourced for the
same reasons, and the same reasons hold.

**Fully procedural, no texture at all.** Rejected: a window arrangement and an
open doorway cannot be expressed as geometry at this instance count without
absurd triangle budgets.

**A painted full-colour atlas, one region per Livery.** Rejected because it
would retire `setColorAt`. Livery then lives in pixels, so adding a Livery — or
a Stock, or a future Route's stock — means re-baking an image instead of adding
a colour constant. Masks keep colour per-instance and one atlas serves every
Livery there will ever be.

## Consequences

The masks must be combined with instance colour in the shader, so the standard
material is patched via `onBeforeCompile`. That is the first custom shader in
`src/scene/` outside `WaterMaterial.tsx`, and it is the real cost of this
decision: material changes now happen in two places, TS and GLSL.

Roof grime and brake dust share the **dirt** channel. They are the same
phenomenon at different heights and are not separable at this camera distance;
the freed channel carries panel lines. If a future camera gets close enough for
that to show, the atlas grows a second texture rather than changing this shape.
