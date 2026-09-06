/**
 * Impact and explosion effects.
 *
 * Two pools, both fixed-size and allocation-free at runtime: a point cloud for
 * sparks and debris, and a handful of billboarded rings for shockwaves. The
 * points use a custom shader because `PointsMaterial` has one uniform size for
 * the whole buffer, and an explosion needs a spread of sizes to read as one.
 */

import * as THREE from 'three'

const MAX_PARTICLES = 2400
const MAX_RINGS = 10

const PARTICLE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective-correct sizing, floored so distant sparks stay visible.
    gl_PointSize = aSize * (420.0 / max(24.0, -mv.z));
  }
`

const PARTICLE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float soft = 1.0 - smoothstep(0.0, 0.25, r2);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`

export interface Fx {
  group: THREE.Group
  /** Small bright spray — laser hits on a hull. */
  spark(at: THREE.Vector3, color: THREE.Color, count?: number): void
  /** Full kill: fireball, debris spray, expanding shockwave. */
  explode(at: THREE.Vector3, color: THREE.Color, scale?: number): void
  /** Rising motes as a ship warps in. */
  warpIn(at: THREE.Vector3, color: THREE.Color): void
  /** A power-up pod being absorbed: one tight ring and a bright puff. */
  collect(at: THREE.Vector3, color: THREE.Color): void
  /**
   * BFG detonation: a white core, a coloured fireball and three rings leaving
   * at different speeds. Stacked rings rather than one big one because a single
   * expanding circle reads as a decal, and three reads as a pressure wave.
   */
  blast(at: THREE.Vector3, color: THREE.Color, radius: number): void
  update(dt: number, camera: THREE.Camera): void
  clear(): void
  dispose(): void
}

export function createFx(): Fx {
  const group = new THREE.Group()

  /* ---- Particles -------------------------------------------------------- */

  const positions = new Float32Array(MAX_PARTICLES * 3)
  const colors = new Float32Array(MAX_PARTICLES * 3)
  const sizes = new Float32Array(MAX_PARTICLES)
  const alphas = new Float32Array(MAX_PARTICLES)

  // Simulation state, kept out of the GPU buffers.
  const velocities = new Float32Array(MAX_PARTICLES * 3)
  const life = new Float32Array(MAX_PARTICLES)
  const maxLife = new Float32Array(MAX_PARTICLES)
  const drag = new Float32Array(MAX_PARTICLES)
  const baseSize = new Float32Array(MAX_PARTICLES)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1))
  geometry.setDrawRange(0, MAX_PARTICLES)
  // Particles are placed in world space, so a bounding sphere computed from a
  // half-empty buffer would cull the whole cloud at the wrong moment.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)

  const particleMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, particleMat)
  points.frustumCulled = false
  group.add(points)

  let particleCursor = 0

  function emit(
    at: THREE.Vector3,
    color: THREE.Color,
    count: number,
    speed: number,
    size: number,
    ttl: number,
    dragRate: number,
    spreadPos = 0,
  ) {
    for (let n = 0; n < count; n++) {
      const i = particleCursor
      particleCursor = (particleCursor + 1) % MAX_PARTICLES

      // Uniform direction on the sphere, magnitude jittered so the shell of a
      // burst is ragged rather than a perfect expanding ball.
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.max(0, 1 - u * u))
      const mag = speed * (0.35 + Math.random() * 0.65)

      const dx = r * Math.cos(theta)
      const dy = u
      const dz = r * Math.sin(theta)

      positions[i * 3] = at.x + dx * spreadPos
      positions[i * 3 + 1] = at.y + dy * spreadPos
      positions[i * 3 + 2] = at.z + dz * spreadPos

      velocities[i * 3] = dx * mag
      velocities[i * 3 + 1] = dy * mag
      velocities[i * 3 + 2] = dz * mag

      // Bias toward white at the hot centre of the flash.
      const heat = Math.random() * 0.55
      colors[i * 3] = color.r + (1 - color.r) * heat
      colors[i * 3 + 1] = color.g + (1 - color.g) * heat
      colors[i * 3 + 2] = color.b + (1 - color.b) * heat

      const t = ttl * (0.55 + Math.random() * 0.9)
      life[i] = t
      maxLife[i] = t
      drag[i] = dragRate
      baseSize[i] = size * (0.5 + Math.random() * 1.1)
      sizes[i] = baseSize[i]
      alphas[i] = 1
    }
  }

  /* ---- Shockwave rings -------------------------------------------------- */

  const ringGeometry = new THREE.RingGeometry(0.72, 1, 32)
  const rings = Array.from({ length: MAX_RINGS }, () => {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(ringGeometry, material)
    mesh.visible = false
    mesh.frustumCulled = false
    group.add(mesh)
    return { mesh, material, life: 0, ttl: 1, size: 1 }
  })

  let ringCursor = 0

  function ring(at: THREE.Vector3, color: THREE.Color, size: number, ttl: number) {
    const slot = rings[ringCursor]
    ringCursor = (ringCursor + 1) % MAX_RINGS
    slot.mesh.position.copy(at)
    slot.mesh.visible = true
    slot.material.color.copy(color)
    slot.life = ttl
    slot.ttl = ttl
    slot.size = size
  }

  return {
    group,

    spark(at, color, count = 14) {
      emit(at, color, count, 90, 3.4, 0.4, 5.5, 1.5)
    },

    explode(at, color, scale = 1) {
      emit(at, color, Math.round(90 * scale), 190 * scale, 6.5 * scale, 1.1, 1.5, 3)
      emit(at, color, Math.round(40 * scale), 70 * scale, 12 * scale, 1.7, 0.9, 5)
      emit(at, new THREE.Color(0xffffff), Math.round(26 * scale), 300 * scale, 3.2 * scale, 0.4, 4.5, 1)
      ring(at, color, 130 * scale, 0.62)
    },

    warpIn(at, color) {
      emit(at, color, 44, 46, 4.2, 0.85, 2.2, 26)
      ring(at, color, 70, 0.5)
    },

    // Shorter and snappier than a warp-in: this fires while the player is flying
    // through the thing at speed, so it has to resolve before the pod is behind
    // them. Heavy drag keeps the puff from smearing into a trail.
    collect(at, color) {
      emit(at, color, 34, 130, 4.4, 0.55, 4.2, 10)
      ring(at, color, 100, 0.42)
    },

    blast(at, color, radius) {
      // Tight and short. The first cut of this threw 600 particles out past the
      // kill radius for two and a half seconds, and the reward for landing the
      // best shot in the game was a screen you could not see out of.
      const white = new THREE.Color(0xffffff)
      emit(at, white, 140, radius * 1.2, 7, 0.35, 4, 10)
      emit(at, color, 220, radius * 0.55, 9, 0.9, 1.8, 18)
      emit(at, color, 80, radius * 0.22, 15, 1.5, 1, 40)
      // The middle ring stops exactly on the damage boundary. A shockwave drawn
      // wider than it kills teaches the wrong distance, and this is a weapon
      // where the distance you keep is the whole decision.
      ring(at, white, radius * 0.55, 0.45)
      ring(at, color, radius, 0.8)
      ring(at, color, radius * 1.25, 1.2)
    },

    update(dt, camera) {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (life[i] <= 0) {
          if (alphas[i] !== 0) {
            alphas[i] = 0
            sizes[i] = 0
          }
          continue
        }

        life[i] -= dt
        if (life[i] <= 0) {
          alphas[i] = 0
          sizes[i] = 0
          continue
        }

        const decay = Math.exp(-drag[i] * dt)
        velocities[i * 3] *= decay
        velocities[i * 3 + 1] *= decay
        velocities[i * 3 + 2] *= decay

        positions[i * 3] += velocities[i * 3] * dt
        positions[i * 3 + 1] += velocities[i * 3 + 1] * dt
        positions[i * 3 + 2] += velocities[i * 3 + 2] * dt

        const k = life[i] / maxLife[i]
        alphas[i] = k * k
        sizes[i] = baseSize[i] * (0.35 + k * 0.65)
      }

      geometry.attributes.position.needsUpdate = true
      geometry.attributes.aColor.needsUpdate = true
      geometry.attributes.aSize.needsUpdate = true
      geometry.attributes.aAlpha.needsUpdate = true

      for (const slot of rings) {
        if (slot.life <= 0) {
          if (slot.mesh.visible) slot.mesh.visible = false
          continue
        }
        slot.life -= dt
        const k = Math.max(0, slot.life / slot.ttl)
        const grow = 1 - k
        slot.mesh.scale.setScalar(slot.size * (0.15 + grow * 0.85))
        slot.material.opacity = k * k * 0.9
        // Billboard, so a flat ring never turns edge-on and vanishes.
        slot.mesh.quaternion.copy(camera.quaternion)
        if (slot.life <= 0) slot.mesh.visible = false
      }
    },

    clear() {
      life.fill(0)
      alphas.fill(0)
      sizes.fill(0)
      geometry.attributes.aAlpha.needsUpdate = true
      geometry.attributes.aSize.needsUpdate = true
      for (const slot of rings) {
        slot.life = 0
        slot.mesh.visible = false
      }
    },

    dispose() {
      geometry.dispose()
      particleMat.dispose()
      ringGeometry.dispose()
      for (const slot of rings) slot.material.dispose()
    },
  }
}
