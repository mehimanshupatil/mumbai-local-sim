import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three'

const CANVAS_W = 128
const CANVAS_H = 512
/** Sleepers per texture tile — the tile then repeats via UV wrapping. */
const SLEEPERS_PER_TILE = 4

/**
 * Procedural ballast+sleeper+rail texture for a single running track,
 * tiled along its length via UV wrapping. No binary asset to source or
 * commit — generated once at load time and reused by every track ribbon.
 *
 * `maxAnisotropy` comes from the renderer (`gl.capabilities.getMaxAnisotropy()`).
 * It matters more than anything else here: the corridor is almost always
 * viewed at a grazing angle, which is texture *minification*, and MSAA does
 * nothing for that. At the default anisotropy of 1 the sleeper bands collapse
 * into moire chevrons and the rails break into a dotted smear within a few
 * hundred metres of the camera.
 */
export function createTrackTexture(maxAnisotropy = 1): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return new CanvasTexture(canvas)

  ctx.fillStyle = '#6b6259'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  // Ballast speckle.
  let seed = 1234
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  // Speckle count tracks canvas area so grain density survives a resolution change.
  const speckles = Math.round((CANVAS_W * CANVAS_H) / 32)
  for (let i = 0; i < speckles; i++) {
    const shade = 70 + rand() * 60
    ctx.fillStyle = `rgb(${shade}, ${shade * 0.94}, ${shade * 0.86})`
    ctx.fillRect(rand() * CANVAS_W, rand() * CANVAS_H, 2, 2)
  }

  // Sleepers: dark bands crossing the full width, evenly spaced per tile —
  // high contrast against the ballast so the band survives mip-blurring at
  // typical camera distance (see TRACK_TILE_LENGTH_SCENE_M in Corridor.tsx).
  const sleeperH = CANVAS_H / SLEEPERS_PER_TILE
  ctx.fillStyle = '#241d16'
  for (let i = 0; i < SLEEPERS_PER_TILE; i++) {
    ctx.fillRect(0, i * sleeperH, CANVAS_W, sleeperH * 0.4)
  }

  // Rails: two bright rails running the full length.
  ctx.fillStyle = '#c8c8c8'
  ctx.fillRect(CANVAS_W * 0.18, 0, CANVAS_W * 0.1, CANVAS_H)
  ctx.fillRect(CANVAS_W * 0.72, 0, CANVAS_W * 0.1, CANVAS_H)

  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  // A colour map authored in sRGB; without this three treats it as linear and
  // the ballast renders washed out against the terrain.
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = maxAnisotropy
  texture.needsUpdate = true
  return texture
}
