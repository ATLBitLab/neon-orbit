/**
 * The lush world below.
 *
 * A faceted icosphere whose vertices are displaced and coloured by a band-sum
 * noise field, so continents, shelves and highlands fall out of one scalar.
 * Nothing is textured — every bit of colour is per-facet vertex colour, which
 * keeps the whole planet one draw call and firmly in the low-poly register.
 */

import * as THREE from 'three'
import type { Rng } from '../core/rng'

/* -------------------------------------------------------------------------- */
/* Elevation field                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A sum of sine bands over random directions, evaluated on the unit sphere.
 *
 * Cheaper and smoother than gradient noise for this purpose: low-frequency
 * terms carve continents, higher terms roughen the coastlines. Returns roughly
 * -1..1. Because it is a pure function of position, duplicated vertices in the
 * non-indexed sphere always agree and seams cannot crack open.
 */
function bandNoise(rng: Rng, terms: number, baseFreq: number, growth: number) {
  const dirs: THREE.Vector3[] = []
  const freqs: number[] = []
  const amps: number[] = []
  const phases: number[] = []
  let ampSum = 0

  for (let i = 0; i < terms; i++) {
    dirs.push(new THREE.Vector3(rng.spread(1), rng.spread(1), rng.spread(1)).normalize())
    const f = baseFreq * Math.pow(growth, i)
    const a = 1 / Math.pow(f, 0.85)
    freqs.push(f)
    amps.push(a)
    phases.push(rng.range(0, Math.PI * 2))
    ampSum += a
  }

  return (p: THREE.Vector3): number => {
    let s = 0
    for (let i = 0; i < terms; i++) {
      s += amps[i] * Math.sin(freqs[i] * Math.PI * dirs[i].dot(p) + phases[i])
    }
    return s / ampSum
  }
}

/* -------------------------------------------------------------------------- */
/* Colour ramp                                                                 */
/* -------------------------------------------------------------------------- */

interface Stop {
  at: number
  color: number
}

/**
 * Abyss to alpine, keyed to **height above sea level** rather than to raw field
 * value, so moving the waterline reshapes the coastlines without also dragging
 * the biomes out from under them.
 *
 * Green-dominant on purpose — the brief said lush.
 */
const TERRAIN: Stop[] = [
  { at: -1.0, color: 0x04202e },
  { at: -0.22, color: 0x07414f },
  { at: -0.05, color: 0x0e6b74 },
  { at: -0.012, color: 0x1a9c82 },
  { at: 0.0, color: 0xdae7a4 }, // beach
  { at: 0.035, color: 0x46b455 },
  { at: 0.14, color: 0x1f8a3c },
  { at: 0.3, color: 0x35a343 },
  { at: 0.48, color: 0x86cf4c },
  { at: 0.68, color: 0xbfdc8e },
  { at: 1.0, color: 0xf0f8dc },
]

const rampCache = TERRAIN.map((s) => new THREE.Color(s.color))

function sampleRamp(h: number, out: THREE.Color): THREE.Color {
  if (h <= TERRAIN[0].at) return out.copy(rampCache[0])
  for (let i = 1; i < TERRAIN.length; i++) {
    if (h <= TERRAIN[i].at) {
      const span = TERRAIN[i].at - TERRAIN[i - 1].at
      const t = span > 0 ? (h - TERRAIN[i - 1].at) / span : 0
      return out.copy(rampCache[i - 1]).lerp(rampCache[i], t)
    }
  }
  return out.copy(rampCache[rampCache.length - 1])
}

/* -------------------------------------------------------------------------- */
/* Atmosphere shell                                                            */
/* -------------------------------------------------------------------------- */

const ATMOSPHERE_VERT = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vEyeDir;
  varying vec3 vNormalWorld;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vEyeDir = normalize(-mv.xyz);
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * mv;
  }
`

const ATMOSPHERE_FRAG = /* glsl */ `
  uniform vec3 uGlow;
  uniform vec3 uSun;
  uniform float uPower;
  uniform float uStrength;

  varying vec3 vNormalView;
  varying vec3 vEyeDir;
  varying vec3 vNormalWorld;

  void main() {
    // Fresnel: brightest where the shell is edge-on to the camera.
    float rim = pow(1.0 - abs(dot(vNormalView, vEyeDir)), uPower);
    // Only the sunlit limb should really burn; the night side keeps a hint.
    float lit = mix(0.12, 1.0, smoothstep(-0.35, 0.55, dot(vNormalWorld, uSun)));
    gl_FragColor = vec4(uGlow, rim * lit * uStrength);
  }
`

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export interface PlanetOptions {
  radius: number
  center: THREE.Vector3
  sunDirection: THREE.Vector3
  /** Icosphere subdivision. 24 ≈ 12.5k triangles — plenty for hard facets. */
  detail?: number
  /** Field value that counts as sea level. */
  seaLevel?: number
}

export interface Planet {
  group: THREE.Group
  radius: number
  center: THREE.Vector3
  /** Slow axial spin, radians/sec. */
  spin: number
  update(dt: number): void
  dispose(): void
}

export function buildPlanet(rng: Rng, opts: PlanetOptions): Planet {
  const { radius, center, sunDirection } = opts
  const detail = opts.detail ?? 24
  // Below zero so land wins the coin flip — a mostly-ocean world reads cold.
  const seaLevel = opts.seaLevel ?? -0.07

  const elevation = bandNoise(rng, 13, 1.1, 1.42)
  const texture = bandNoise(rng, 6, 7.5, 1.5) // local green variation
  const cloudField = bandNoise(rng, 8, 2.4, 1.55)

  /* ---- Surface ---------------------------------------------------------- */

  const surface = new THREE.IcosahedronGeometry(radius, detail)
  const pos = surface.getAttribute('position') as THREE.BufferAttribute
  const count = pos.count
  const colors = new Float32Array(count * 3)

  const unit = new THREE.Vector3()
  const faceColor = new THREE.Color()
  const heights = new Float32Array(count)

  // Pass 1: displace. Land rises; ocean stays a clean sphere so it reads wet.
  for (let i = 0; i < count; i++) {
    unit.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const h = elevation(unit)
    heights[i] = h
    const land = Math.max(0, h - seaLevel)
    // Linear rise for rolling ground, quadratic kicker so ranges spike.
    const r = radius * (1 + 0.016 * land + 0.05 * land * land)
    pos.setXYZ(i, unit.x * r, unit.y * r, unit.z * r)
  }

  // Pass 2: colour per triangle, not per vertex — that is what makes facets pop.
  for (let tri = 0; tri < count; tri += 3) {
    const raw = (heights[tri] + heights[tri + 1] + heights[tri + 2]) / 3
    const h = raw - seaLevel
    unit
      .set(
        pos.getX(tri) + pos.getX(tri + 1) + pos.getX(tri + 2),
        pos.getY(tri) + pos.getY(tri + 1) + pos.getY(tri + 2),
        pos.getZ(tri) + pos.getZ(tri + 1) + pos.getZ(tri + 2),
      )
      .normalize()

    sampleRamp(h, faceColor)
    if (h > 0) {
      // Break up the greens so continents do not read as one flat wash.
      const v = 1 + texture(unit) * 0.13
      faceColor.multiplyScalar(v)
    }

    for (let k = 0; k < 3; k++) {
      colors[(tri + k) * 3 + 0] = faceColor.r
      colors[(tri + k) * 3 + 1] = faceColor.g
      colors[(tri + k) * 3 + 2] = faceColor.b
    }
  }

  surface.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  surface.computeVertexNormals()

  const surfaceMat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    flatShading: true,
    shininess: 8,
    specular: 0x0a1a24,
    // Keeps the night side from going pure black without washing out the day.
    emissive: 0x030a12,
  })

  const surfaceMesh = new THREE.Mesh(surface, surfaceMat)

  /* ---- Clouds ----------------------------------------------------------- */
  // Built by keeping only the triangles inside a cloud mass, so there is no
  // full transparent shell to blend against the whole planet every frame.

  const cloudShell = new THREE.IcosahedronGeometry(radius * 1.014, Math.max(8, Math.floor(detail * 0.6)))
  const cPos = cloudShell.getAttribute('position') as THREE.BufferAttribute
  const kept: number[] = []
  const keptColors: number[] = []

  for (let tri = 0; tri < cPos.count; tri += 3) {
    unit
      .set(
        cPos.getX(tri) + cPos.getX(tri + 1) + cPos.getX(tri + 2),
        cPos.getY(tri) + cPos.getY(tri + 1) + cPos.getY(tri + 2),
        cPos.getZ(tri) + cPos.getZ(tri + 1) + cPos.getZ(tri + 2),
      )
      .normalize()

    const c = cloudField(unit)
    if (c < 0.24) continue

    const alpha = Math.min(1, (c - 0.24) / 0.34) * 0.52
    for (let k = 0; k < 3; k++) {
      kept.push(cPos.getX(tri + k), cPos.getY(tri + k), cPos.getZ(tri + k))
      keptColors.push(1, 1, 1, alpha)
    }
  }
  cloudShell.dispose()

  const clouds = new THREE.BufferGeometry()
  clouds.setAttribute('position', new THREE.Float32BufferAttribute(kept, 3))
  clouds.setAttribute('color', new THREE.Float32BufferAttribute(keptColors, 4))
  clouds.computeVertexNormals()

  const cloudMat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    flatShading: true,
    transparent: true,
    depthWrite: false,
    shininess: 0,
    emissive: 0x0c1626,
    side: THREE.DoubleSide,
  })
  const cloudMesh = new THREE.Mesh(clouds, cloudMat)

  /* ---- Atmosphere ------------------------------------------------------- */

  const atmoGeo = new THREE.IcosahedronGeometry(radius * 1.055, 4)
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uGlow: { value: new THREE.Color(0x4ce0ff) },
      uSun: { value: sunDirection.clone().normalize() },
      uPower: { value: 3.8 },
      uStrength: { value: 0.7 },
    },
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  })
  const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat)

  // A wider, softer second shell reads as high-altitude haze.
  const hazeGeo = new THREE.IcosahedronGeometry(radius * 1.14, 4)
  const hazeMat = atmoMat.clone()
  hazeMat.uniforms.uGlow.value = new THREE.Color(0x2f7cff)
  hazeMat.uniforms.uPower.value = 5.0
  hazeMat.uniforms.uStrength.value = 0.3
  const hazeMesh = new THREE.Mesh(hazeGeo, hazeMat)

  /* ---- Assembly --------------------------------------------------------- */

  const body = new THREE.Group() // spins
  body.add(surfaceMesh, cloudMesh)

  const group = new THREE.Group() // does not spin, so the haze stays put
  group.position.copy(center)
  group.add(body, atmoMesh, hazeMesh)

  const spin = 0.0075

  return {
    group,
    radius,
    center: center.clone(),
    spin,
    update(dt: number) {
      body.rotation.y += spin * dt
      // Clouds drift a touch faster than the ground under them.
      cloudMesh.rotation.y += spin * 0.35 * dt
    },
    dispose() {
      surface.dispose()
      clouds.dispose()
      atmoGeo.dispose()
      hazeGeo.dispose()
      surfaceMat.dispose()
      cloudMat.dispose()
      atmoMat.dispose()
      hazeMat.dispose()
    },
  }
}
