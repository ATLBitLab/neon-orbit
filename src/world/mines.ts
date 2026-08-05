/**
 * Proximity mines.
 *
 * Red, spiky, and lethal on contact — a static hazard that turns the empty parts
 * of the arena into terrain you have to read. They punish flying fast in a
 * straight line, which is exactly the habit a wide-open volume encourages.
 *
 * The whole field is two `InstancedMesh` draw calls: a lit body and a slightly
 * larger additive halo. Detonated mines are scaled to zero rather than removed,
 * so a mine's instance index is stable for the life of the run and `reset()` can
 * restore the field between runs without rebuilding any geometry.
 */

import * as THREE from 'three'
import { bakeParts, chunk, disposeParts, prep } from '../core/geo'
import { makeRng, WORLD_SEED } from '../core/rng'
import type { Hazard } from './environment'

/** Core body radius. */
const CORE_RADIUS = 8
const SPIKE_LENGTH = 9
/** Contact radius. Slightly inside the spike tips so grazes feel fair. */
export const MINE_RADIUS = 15
/**
 * Flat damage, deliberately not scaled by hull size. A mine is the same lump of
 * explosive whoever hits it, so the fragile airframe fears it most — which suits
 * the Wasp's glass-cannon identity rather than fighting it.
 */
export const MINE_DAMAGE = 45
/** How far out an AI starts steering around one. Much tighter than a station. */
const MINE_AVOID_RANGE = 130

const UP = new THREE.Vector3(0, 1, 0)
const _scratch = new THREE.Vector3()

export interface Mine {
  readonly position: THREE.Vector3
  live: boolean
}

export interface Minefield {
  group: THREE.Group
  mines: Mine[]
  /**
   * Live mines as hazards, for AI steering. Rebuilt only when one detonates, so
   * the AI can read it every frame for free.
   */
  avoidance: Hazard[]
  /** The live mine this sphere is touching, or null. */
  findContact(position: THREE.Vector3, radius: number): Mine | null
  detonate(mine: Mine): void
  /** Re-arm the whole field. Called at the start of every run. */
  reset(): void
  update(dt: number): void
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/** The twelve icosahedron vertex directions — where the spikes point. */
function spikeDirections(): THREE.Vector3[] {
  const phi = (1 + Math.sqrt(5)) / 2
  const dirs: THREE.Vector3[] = []
  for (const [a, b] of [
    [1, phi],
    [1, -phi],
    [-1, phi],
    [-1, -phi],
  ]) {
    dirs.push(new THREE.Vector3(0, a, b), new THREE.Vector3(a, b, 0), new THREE.Vector3(b, 0, a))
  }
  return dirs.map((d) => d.normalize())
}

function buildMineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [chunk(CORE_RADIUS, 0)]

  // A four-sided cone reads as a spike and costs four triangles.
  const spike = new THREE.ConeGeometry(2.4, SPIKE_LENGTH, 4)
  spike.translate(0, SPIKE_LENGTH / 2, 0) // base at the origin, apex outward
  const spikeBase = prep(spike)

  const quat = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  for (const dir of spikeDirections()) {
    quat.setFromUnitVectors(UP, dir)
    const matrix = new THREE.Matrix4().compose(
      dir.clone().multiplyScalar(CORE_RADIUS * 0.82),
      quat,
      one,
    )
    parts.push(spikeBase.clone().applyMatrix4(matrix))
  }

  const merged = bakeParts(parts, 'mine')
  disposeParts(parts)
  spikeBase.dispose()
  return merged
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

export interface MinefieldOptions {
  count: number
  arenaRadius: number
  /** Station cores to keep clear of. */
  hazards: Hazard[]
  /** Where the player starts, kept clear so nobody spawns inside a minefield. */
  spawn: THREE.Vector3
}

function placeMines(opts: MinefieldOptions): THREE.Vector3[] {
  const rng = makeRng(WORLD_SEED ^ 0x9d1e)
  const placed: THREE.Vector3[] = []

  let attempts = 0
  while (placed.length < opts.count && attempts < opts.count * 60) {
    attempts++

    const u = rng.range(-1, 1)
    const theta = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(Math.max(0, 1 - u * u))
    const dist = rng.range(500, opts.arenaRadius * 0.92)
    const p = new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta)).multiplyScalar(dist)

    // Never inside a station, never on top of the player's spawn, and never so
    // close to another mine that they read as one blob.
    if (p.distanceTo(opts.spawn) < 620) continue
    if (opts.hazards.some((h) => p.distanceTo(h.center) < h.radius + 240)) continue
    if (placed.some((q) => p.distanceTo(q) < 260)) continue

    placed.push(p)
  }

  return placed
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export function buildMinefield(opts: MinefieldOptions): Minefield {
  const geometry = buildMineGeometry()

  const bodyMat = new THREE.MeshPhongMaterial({
    color: 0x3a0d12,
    flatShading: true,
    shininess: 40,
    specular: 0xff6070,
    // Bright enough to clear the bloom threshold, so mines glow from far off.
    emissive: 0xd01828,
  })

  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xff2a3a,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  })

  const positions = placeMines(opts)
  const count = positions.length

  const body = new THREE.InstancedMesh(geometry, bodyMat, Math.max(1, count))
  const halo = new THREE.InstancedMesh(geometry, haloMat, Math.max(1, count))
  for (const mesh of [body, halo]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
  }

  const group = new THREE.Group()
  group.add(body, halo)

  const mines: Mine[] = positions.map((position) => ({ position, live: true }))
  const spins = positions.map(() => new THREE.Vector3(0, 0, 0))
  const rots = positions.map(() => new THREE.Euler())

  const spinRng = makeRng(WORLD_SEED ^ 0x71b0)
  for (let i = 0; i < count; i++) {
    rots[i].set(spinRng.range(0, 7), spinRng.range(0, 7), spinRng.range(0, 7))
    spins[i].set(spinRng.spread(0.35), spinRng.spread(0.35), spinRng.spread(0.35))
  }

  const basis = new THREE.Object3D()
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  let avoidance: Hazard[] = []

  function rebuildAvoidance() {
    avoidance = mines
      .filter((m) => m.live)
      .map((m) => ({
        center: m.position,
        radius: MINE_RADIUS,
        avoidRange: MINE_AVOID_RANGE,
        name: 'MINE',
      }))
    field.avoidance = avoidance
  }

  /** Halo pulse. One shared phase — a field blinking in unison is creepier. */
  let pulse = 0

  function writeInstances() {
    for (let i = 0; i < count; i++) {
      if (!mines[i].live) {
        body.setMatrixAt(i, hidden)
        halo.setMatrixAt(i, hidden)
        continue
      }
      basis.position.copy(mines[i].position)
      basis.rotation.copy(rots[i])
      basis.scale.setScalar(1)
      basis.updateMatrix()
      body.setMatrixAt(i, basis.matrix)

      basis.scale.setScalar(1.25 + Math.sin(pulse) * 0.12)
      basis.updateMatrix()
      halo.setMatrixAt(i, basis.matrix)
    }
    body.instanceMatrix.needsUpdate = true
    halo.instanceMatrix.needsUpdate = true
  }

  const field: Minefield = {
    group,
    mines,
    avoidance,

    findContact(position, radius) {
      const reach = MINE_RADIUS + radius
      const reachSq = reach * reach
      for (const mine of mines) {
        if (!mine.live) continue
        if (_scratch.subVectors(position, mine.position).lengthSq() <= reachSq) return mine
      }
      return null
    },

    detonate(mine) {
      if (!mine.live) return
      mine.live = false
      rebuildAvoidance()
      writeInstances()
    },

    reset() {
      for (const mine of mines) mine.live = true
      rebuildAvoidance()
      writeInstances()
    },

    update(dt) {
      pulse += dt * 3.1
      for (let i = 0; i < count; i++) {
        if (!mines[i].live) continue
        rots[i].x += spins[i].x * dt
        rots[i].y += spins[i].y * dt
        rots[i].z += spins[i].z * dt
      }
      haloMat.opacity = 0.12 + (Math.sin(pulse) * 0.5 + 0.5) * 0.14
      writeInstances()
    },

    dispose() {
      geometry.dispose()
      bodyMat.dispose()
      haloMat.dispose()
      body.dispose()
      halo.dispose()
    },
  }

  rebuildAvoidance()
  writeInstances()
  return field
}
