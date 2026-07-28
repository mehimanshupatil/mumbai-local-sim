import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Daylight } from './daylight'

/**
 * Sea ripple + fresnel shader, ported from mumbai-lakes. Scrolling analytic
 * ripples perturb the normal (the plane itself stays flat); fresnel tints
 * toward the sky, a specular glint tracks the sun/moon. Manual distance fog
 * blends the sea into the sky at range, since this scene has no THREE.Fog.
 *
 * Both scenes use the same real-metre convention, so wave frequency and amp
 * falloff are unchanged from mumbai-lakes. Only the fog distance range is
 * retuned: this corridor's camera roams from station-zoom (~150 m) out to
 * whole-corridor overviews (~100+ km), much farther than a single lake view.
 */

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`

const FRAG = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uColor;
  uniform float uNight;
  uniform vec3 uFogColor;
  varying vec3 vWorldPos;

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vWorldPos.xz;
    float dist = length(cameraPosition - vWorldPos);
    // diagonal wave sets (no axis-aligned banding), fading with distance
    float amp = 0.09 / (1.0 + dist * 0.012);
    float w1 = sin(dot(p, vec2(0.42, 0.31)) + uTime * 1.15);
    float w2 = sin(dot(p, vec2(-0.27, 0.47)) - uTime * 0.85);
    float w3 = sin(dot(p, vec2(0.83, -0.64)) * 1.7 + uTime * 2.1);
    float nx = (w1 * 0.55 + w3 * 0.3) * amp;
    float nz = (w2 * 0.55 + w3 * 0.3) * amp;
    vec3 n = normalize(vec3(nx, 1.0, nz));

    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 2.4);

    vec3 sun = normalize(uSunDir);
    vec3 h = normalize(sun + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 120.0);

    // Reflect the scene's own sky colour (already dawn/noon/dusk-aware) rather
    // than a hardcoded two-tone approximation.
    vec3 glint = mix(vec3(1.0, 0.95, 0.82), vec3(0.72, 0.82, 1.0), uNight);
    float fresAmt = fres * (0.55 - uNight * 0.25);
    vec3 base = uColor * (1.0 - uNight * 0.72); // moonlit water is dark
    vec3 col = mix(base, uFogColor, fresAmt) + spec * glint * 0.85;

    float fogF = smoothstep(4000.0, 45000.0, dist);
    col = mix(col, uFogColor, fogF);

    gl_FragColor = vec4(col, 1.0);
  }
`

export function WaterMaterial({ color, daylight }: { color: string; daylight: Daylight }) {
  const ref = useRef<THREE.ShaderMaterial>(null)

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uColor: { value: new THREE.Color(color) },
      uNight: { value: 0 },
      uFogColor: { value: new THREE.Color('#14536e') },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame(({ clock }) => {
    const u = ref.current?.uniforms
    if (!u) return
    u.uTime.value = clock.elapsedTime
    u.uSunDir.value.set(daylight.sunPos[0], daylight.sunPos[1], daylight.sunPos[2]).normalize()
    u.uNight.value = daylight.night
    u.uColor.value.set(color)
    u.uFogColor.value.set(daylight.skyColor)
  })

  return <shaderMaterial ref={ref} vertexShader={VERT} fragmentShader={FRAG} uniforms={uniforms} />
}
