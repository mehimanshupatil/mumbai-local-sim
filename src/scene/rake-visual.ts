/**
 * What a Rake is made of: coach and cab geometry, and the material that reads
 * the Livery mask atlas. Pure — no sim, no React, no per-frame work. Fleet
 * owns instancing and posing; this owns how a coach looks, so swapping the
 * train visual (CLAUDE.md's promise) means swapping this module.
 *
 * The geometry is built from the same proportions the atlas was baked from
 * (src/scene/livery-atlas.ts), so a window in the texture lands where the
 * window is on the body. Both are in metres there; here they are multiplied
 * up by the scene's exaggeration, the same lie every other visual tells.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  Texture,
  TextureLoader,
  type WebGLProgramParametersWithUniforms,
} from 'three'
import type { ServiceType } from '../sim/types'
import { COACH_LENGTH_SCENE_M } from './config'
import {
  ATLAS_PATH,
  CHANNEL,
  COACH,
  SIDE_HEIGHT_M,
  sideV,
  uvRect,
  type RegionName,
} from './livery-atlas'
import { NOSE_L } from './rake-geometry'

/** Body width and height in scene units — the exaggerated 3.66 m x 3.9 m body. */
export const BODY_W = 18
export const BODY_H = 18

/**
 * Liveries by Service Type: body and waist band. Decided by Service Type and
 * Stock, never by the Line a Service runs on (CONTEXT.md, Livery).
 *
 * Livery does not vary by Stock here, and that is a finding rather than an
 * omission. WR suburban is worked by several Stocks at once — Siemens 1xxx /
 * 2xxx, Bombardier 5xxx, Medha 6xxx, plus retrofitted ICF — but what separates
 * them is cab front and window detail, not paint: they wear the same WR white
 * and purple. Varying colour off a hash of the Rake id would invent a fleet
 * that isn't out there. What the per-instance seed does vary is the lit
 * windows after dark, which really are different coach to coach.
 */
export const LIVERY: Record<ServiceType, { body: Color; stripe: Color }> = {
  slow: { body: new Color('#efecf1'), stripe: new Color('#6d1ca3') }, // WR white/purple
  ac: { body: new Color('#3a7bd5'), stripe: new Color('#e8eef7') }, // AC local blue
  fast: { body: new Color('#efecf1'), stripe: new Color('#6d1ca3') }, // same stock as slow
  express: { body: new Color('#77302c'), stripe: new Color('#e0b04a') }, // long-distance maroon
}

/**
 * Half-section of a coach body, anticlockwise from the bottom-left corner of
 * the skirt, in fractions of half-width and half-height. An EMU body is not a
 * box: it tucks in below the solebar and again at the roof shoulder, and that
 * silhouette is most of what makes a rake read as stock rather than a crate.
 */
const PROFILE: readonly (readonly [number, number])[] = [
  [-0.84, -1.0], // skirt, bottom
  [-1.0, -0.62], // solebar
  [-1.0, 0.6], // cantrail
  [-0.74, 1.0], // roof shoulder
  [0.74, 1.0],
  [1.0, 0.6],
  [1.0, -0.62],
  [0.84, -1.0],
]

/** Floor height as a fraction of the body's full height, up from the skirt. */
const FLOOR_FRAC = COACH.belowFloorM / SIDE_HEIGHT_M

/** Local y (body centred on 0) → height above floor in real metres. */
function heightAboveFloorM(y: number): number {
  return (y / BODY_H + 0.5 - FLOOR_FRAC) * SIDE_HEIGHT_M
}

/** Atlas UV of a point given in region-local (u, v). */
function atlasUv(region: RegionName, u: number, v: number): [number, number] {
  const { offset, scale } = uvRect(region)
  // Region v runs down from the region's top; UV v runs up the atlas.
  return [offset[0] + u * scale[0], offset[1] + (1 - v) * scale[1]]
}

/**
 * Texels that carry no mask at all: the atlas's unused corner. Faces that
 * should show plain Livery — coach ends, which are buried in the coupling —
 * sample here rather than pretending to be a cab face.
 */
const BLANK_UV: [number, number] = [0.995, 0.005]

/** A quad, wound counter-clockwise seen from outside, as two triangles. */
function pushQuad(
  pos: number[],
  uv: number[],
  corners: readonly [number, number, number][],
  uvs: readonly [number, number][],
): void {
  for (const i of [0, 1, 2, 0, 2, 3]) {
    pos.push(...corners[i])
    uv.push(...uvs[i])
  }
}

/**
 * One coach, extruded from PROFILE along z.
 *
 * `taper` shrinks the far (+z) end toward the centreline — 1 for a plain
 * coach, less for the cab end, where the real stock's front rakes in. Side
 * faces take the side region, the roof face the roof region, and the front
 * cap the cab region when there is one (a mid-coach end is blank: it is
 * hidden inside the coupling).
 */
function buildBody({
  lengthZ,
  taper = 1,
  frontRegion,
  uSpan = [0, 1],
}: {
  lengthZ: number
  taper?: number
  frontRegion?: RegionName
  uSpan?: [number, number]
}): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const halfW = BODY_W / 2
  const halfH = BODY_H / 2
  const z0 = -lengthZ / 2
  const z1 = lengthZ / 2
  const at = (i: number, front: boolean): [number, number, number] => {
    const [fx, fy] = PROFILE[i]
    const k = front ? taper : 1
    return [fx * halfW * k, fy * halfH * (front ? 0.5 + 0.5 * taper : 1), front ? z1 : z0]
  }

  for (let i = 0; i < PROFILE.length; i++) {
    const j = (i + 1) % PROFILE.length
    const a = at(i, false)
    const b = at(j, false)
    const c = at(j, true)
    const d = at(i, true)
    const normalUp = (PROFILE[i][1] + PROFILE[j][1]) / 2 > 0.85
    const normalDown = (PROFILE[i][1] + PROFILE[j][1]) / 2 < -0.85
    // Along the body: 0 at the far end, 1 at the near one, so a rake's coaches
    // all read the same way round.
    const [u0, u1] = uSpan
    let uvs: [number, number][]
    if (normalUp) {
      // Roof: u along the body, v across it.
      const across = (x: number) => 0.5 + (0.5 * x) / (halfW * 0.74)
      uvs = [
        atlasUv('roof', u0, across(a[0])),
        atlasUv('roof', u0, across(b[0])),
        atlasUv('roof', u1, across(c[0])),
        atlasUv('roof', u1, across(d[0])),
      ]
    } else if (normalDown) {
      uvs = [BLANK_UV, BLANK_UV, BLANK_UV, BLANK_UV] // underframe, never lit
    } else {
      // Sides (and the tuck-ins above and below them): u along the body, v by
      // real height, which is what the atlas was laid out in.
      const v = (y: number) => sideV(heightAboveFloorM(y))
      uvs = [
        atlasUv('side', u0, v(a[1])),
        atlasUv('side', u0, v(b[1])),
        atlasUv('side', u1, v(c[1])),
        atlasUv('side', u1, v(d[1])),
      ]
    }
    pushQuad(pos, uv, [a, b, c, d], uvs)
  }

  // End caps: a fan from the section centre. The front one is the cab face
  // where the geometry has one.
  for (const front of [false, true]) {
    const z = front ? z1 : z0
    const centre: [number, number, number] = [0, 0, z]
    for (let i = 0; i < PROFILE.length; i++) {
      const j = (i + 1) % PROFILE.length
      const a = at(i, front)
      const b = at(j, front)
      const tri = front ? [centre, a, b] : [centre, b, a]
      const faceUv = (p: [number, number, number]): [number, number] =>
        front && frontRegion
          ? atlasUv(frontRegion, 0.5 + p[0] / (BODY_W * taper), sideV(heightAboveFloorM(p[1])))
          : BLANK_UV
      for (const p of tri) {
        pos.push(...p)
        uv.push(...faceUv(p))
      }
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  geo.computeVertexNormals()
  return geo
}

/** A detailed coach: full length, masked on every visible face. */
export function buildCoachGeometry(): BufferGeometry {
  return buildBody({ lengthZ: COACH_LENGTH_SCENE_M })
}

/**
 * The cab end that caps a rake, tapered toward the nose with the driving face
 * masked from the cab region. Its sides take the short end bay of the coach
 * side, so the cab door's droplight lines up with the body's own windows.
 */
export function buildCabGeometry(): BufferGeometry {
  return buildBody({ lengthZ: NOSE_L, taper: 0.62, frontRegion: 'cab', uSpan: [0, 0.1] })
}

/**
 * The far LOD: today's plain box. Beyond a couple of kilometres a coach is a
 * few pixels wide and the masks are below the mip chain anyway — and this is
 * the geometry Fleet's distance-fattening lie reads well on.
 */
export function buildCoachFarGeometry(): BoxGeometry {
  return new BoxGeometry(BODY_W, BODY_H, COACH_LENGTH_SCENE_M)
}

/** Per-instance data the mask material needs beyond instanceColor. */
export const STRIPE_ATTRIBUTE = 'aStripe'
export const SEED_ATTRIBUTE = 'aSeed'

/** Attach the per-instance attributes an instanced mesh of this material needs. */
export function addInstanceAttributes(geometry: BufferGeometry, capacity: number): void {
  geometry.setAttribute(
    STRIPE_ATTRIBUTE,
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  )
  geometry.setAttribute(SEED_ATTRIBUTE, new InstancedBufferAttribute(new Float32Array(capacity), 1))
}

/** Load the baked atlas. Masks are data, not colour: no sRGB decode. */
export function loadAtlas(baseUrl: string): Texture {
  const tex = new TextureLoader().load(`${baseUrl}${ATLAS_PATH}`)
  tex.colorSpace = NoColorSpace
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.anisotropy = 4
  return tex
}

/** Uniforms Fleet drives per frame. */
export interface RakeUniforms {
  uAtlas: { value: Texture | null }
  uNight: { value: number }
}

/**
 * Body datums in atlas-side v, for the waist band. The band is not a mask
 * channel — all four are spoken for — so it is drawn from the same heights
 * the atlas was laid out in, which keeps it on the window sill where the
 * real stock carries it.
 */
const BAND_TOP_V = sideV(COACH.windowSillM + 0.08)
const BAND_BOTTOM_V = sideV(COACH.windowSillM - 0.34)

/**
 * meshStandardMaterial patched to combine the atlas masks with the
 * per-instance Livery. The first custom shader here outside WaterMaterial —
 * kept to the four masks and nothing else:
 *
 * - doorway: discarded outright, so the body really is open (the material is
 *   double-sided, so what shows through the hole is the far wall's inside).
 * - window: glass by day, and the emissive mask after dark, varied per
 *   instance so a night rake is not twelve identical glowing bars.
 * - dirt: roof wash and brake dust, darkening toward the grime colour.
 * - panel: seams and the underframe in shadow.
 */
export function buildRakeMaterial(atlas: Texture): {
  material: MeshStandardMaterial
  uniforms: RakeUniforms
} {
  const uniforms: RakeUniforms = { uAtlas: { value: atlas }, uNight: { value: 0 } }
  const material = new MeshStandardMaterial({
    roughness: 0.62,
    metalness: 0.08,
    // A discarded doorway shows the far wall from inside; without this it
    // shows the sky through the train.
    side: DoubleSide,
  })
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uAtlas = uniforms.uAtlas
    shader.uniforms.uNight = uniforms.uNight
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec3 ${STRIPE_ATTRIBUTE};
        attribute float ${SEED_ATTRIBUTE};
        varying vec3 vStripe;
        varying float vSeed;
        varying vec2 vAtlasUv;
        varying float vSideV;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vStripe = ${STRIPE_ATTRIBUTE};
        vSeed = ${SEED_ATTRIBUTE};
        vAtlasUv = uv;
        // Height up the body, in the same 0..1 the atlas side region uses:
        // v 0 at the roof gutter, 1 at the bottom of the skirt.
        vSideV = 0.5 - position.y / ${BODY_H.toFixed(1)};`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform sampler2D uAtlas;
        uniform float uNight;
        varying vec3 vStripe;
        varying float vSeed;
        varying vec2 vAtlasUv;
        varying float vSideV;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        vec4 mask = texture2D(uAtlas, vAtlasUv);
        float window = mask.${'rgba'[CHANNEL.WINDOW]};
        float doorway = mask.${'rgba'[CHANNEL.DOORWAY]};
        float dirt = mask.${'rgba'[CHANNEL.DIRT]};
        float panel = mask.${'rgba'[CHANNEL.PANEL]};

        // The doorways are open, always — a Mumbai local runs that way.
        if (doorway > 0.5) discard;

        vec3 body = diffuseColor.rgb;
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          body *= vColor.rgb; // vColor is vec4 when alpha is in play; .rgb reads both
        #endif
        // Waist band, on the window sill where the real stock carries it.
        float band = smoothstep(${BAND_TOP_V.toFixed(4)} - 0.02, ${BAND_TOP_V.toFixed(4)}, vSideV)
                   * (1.0 - smoothstep(${BAND_BOTTOM_V.toFixed(4)}, ${BAND_BOTTOM_V.toFixed(4)} + 0.02, vSideV));
        vec3 col = mix(body, vStripe, band);
        // Glass: darker than the body by day, and it reflects more.
        col = mix(col, mix(vec3(0.10, 0.13, 0.16), col, 0.18), window);
        // Seams and the underframe, then the grime over everything.
        col = mix(col, col * 0.55, panel * 0.75);
        col = mix(col, vec3(0.19, 0.17, 0.14), dirt * 0.5);
        diffuseColor.rgb = col;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        // Lit windows after dark. Per-instance seed varies both brightness and
        // tint a little, so a night rake is twelve different coaches.
        float lit = 0.55 + 0.45 * fract(vSeed * 43758.5453);
        totalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * window * uNight * 2.4 * lit
          * (1.0 - 0.35 * dirt);`,
      )
  }
  // Recompiles are not free, but this runs once: the key pins the patched
  // program so three does not treat every instance as a new material.
  material.customProgramCacheKey = () => 'rake-masks'
  return { material, uniforms }
}
