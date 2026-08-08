/**
 * Laser bolts.
 *
 * One `InstancedMesh` holds the whole pool, so four hundred bolts in flight is
 * still a single draw call. Inactive slots are scaled to zero rather than
 * compacted, which keeps a bolt's index stable for its whole life.
 *
 * Bolts sweep-test as a segment against target spheres rather than point-test
 * at their new position. At 1450 units/sec a bolt covers ~24 units per frame,
 * comfortably more than a Wasp's 9-unit radius, so point testing would let
 * shots pass clean through a ship on a bad frame.
 */

import * as THREE from 'three'
import type { Hazard } from '../world/environment'

/**
 * Who a ship belongs to, for the purpose of who is allowed to shoot it.
 *
 * This replaces a two-valued `'player' | 'enemy'`, and the widening is the
 * point: PvP gives every human their own faction, so the set has to be open.
 * Today it holds exactly the two values it always did, so no run changes.
 *
 * Deliberately an opaque number rather than a union of names. A union cannot
 * express "one per participant", and nothing switches exhaustively on this —
 * every use is an equality test — so the exhaustiveness a union would buy is
 * not being spent anywhere. What is lost is protection against passing an
 * arbitrary number; what is gained is the ability to have more than two sides,
 * which is the whole of phase B.
 */
export type Faction = number

/**
 * Every NPC shares one faction, deliberately.
 *
 * The friendly-fire rule below documents why enemies must not shred each other
 * in a shared firing line. Giving each NPC its own faction turns that warning
 * on. Humans are numbered from zero upward instead, so the two sets cannot
 * collide.
 */
export const FACTION_AI: Faction = -1

/**
 * The local human. In PvP, further participants take 1, 2, … — which is why
 * humans count up from zero and the AI sits below it.
 */
export const FACTION_PLAYER: Faction = 0

/** Anything a bolt can hit. `Ship` satisfies this structurally. */
export interface BoltTarget {
  readonly position: THREE.Vector3
  readonly radius: number
  readonly alive: boolean
  /** False while warping in or phase-dashing. */
  readonly targetable: boolean
  readonly faction: Faction
  takeDamage(amount: number, from: Faction): void
}

export interface FireRequest {
  origin: THREE.Vector3
  direction: THREE.Vector3
  speed: number
  damage: number
  faction: Faction
  color: THREE.Color
}

export interface BoltHit {
  point: THREE.Vector3
  target: BoltTarget | null
  damage: number
  faction: Faction
  color: THREE.Color
}

const MAX_BOLTS = 420
const BOLT_LIFETIME = 2.6
const BOLT_RADIUS = 0.55
const BOLT_LENGTH = 26

interface Bolt {
  active: boolean
  pos: THREE.Vector3
  prev: THREE.Vector3
  vel: THREE.Vector3
  life: number
  damage: number
  faction: Faction
  color: THREE.Color
}

export interface Bolts {
  mesh: THREE.InstancedMesh
  fire(req: FireRequest): void
  /**
   * Advances every bolt and resolves hits. Returns this tick's impacts.
   *
   * Simulation only — it moves bolts and decides what they hit, and writes
   * nothing to the mesh. `render` draws the result.
   */
  update(dt: number, targets: BoltTarget[], hazards: Hazard[]): BoltHit[]
  /**
   * Draw the pool, `alpha` of the way from each bolt's last tick position to
   * its current one.
   *
   * Bolts need this as much as hulls do, and arguably more: at 980–1450 units/s
   * one covers 16–24 units per tick, so drawing them only on tick boundaries
   * makes them stutter visibly against ships that are being interpolated
   * smoothly — the one thing on screen moving faster than anything else, and
   * the one thing not smoothed.
   */
  render(alpha: number): void
  clear(): void
  dispose(): void
}

const FORWARD = new THREE.Vector3(0, 0, 1)

export function createBolts(): Bolts {
  const geometry = new THREE.CylinderGeometry(BOLT_RADIUS, BOLT_RADIUS, 1, 6, 1, true)
  geometry.rotateX(Math.PI / 2) // length now runs along +Z

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_BOLTS)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  /*
   * Culling off, deliberately — three.js defaults this to `true`.
   *
   * The bounding sphere of an `InstancedMesh` is computed **lazily and exactly
   * once**: `Frustum.intersectsObject` and `WebGLRenderer` both guard with
   * `if (object.boundingSphere === null) object.computeBoundingSphere()`, and
   * nothing invalidates it when instance matrices change. Writing four hundred
   * new matrices every frame does not mark it stale.
   *
   * So with culling on, the sphere is whatever the pool looked like on the
   * first frame the renderer happened to ask — which in a match is an idle one,
   * before anyone has fired. Inactive slots are parked at the origin with
   * `makeScale(0, 0, 0)`, so that snapshot is a **degenerate point at the world
   * origin, radius zero, frozen for the session**. Measured: twelve bolts in
   * flight at z = -1500 and the sphere still reads centre (0,0,0) r=0 until
   * something calls `computeBoundingSphere` by hand.
   *
   * `ARENA_RADIUS` is 3400 — a radius, so 6800 across — and the origin is out
   * of frustum most of the time. The failure is not "bounds too loose to be
   * useful"; it is every bolt on screen vanishing while the pool is culled
   * against a point nobody is looking at. Measured: an r=0 sphere at the origin
   * fails `Frustum.intersectsSphere` from any camera not pointed at it.
   *
   * That makes the obvious fix — recompute the bounds each frame — a real
   * option rather than a mistake, at the cost of walking the pool per frame.
   * It is simply not worth it here for a mesh that is nearly always on screen.
   */
  mesh.frustumCulled = false
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLTS * 3), 3)
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)

  const pool: Bolt[] = Array.from({ length: MAX_BOLTS }, () => ({
    active: false,
    pos: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    life: 0,
    damage: 0,
    faction: FACTION_AI,
    color: new THREE.Color(),
  }))

  let cursor = 0

  // Scratch, reused every frame — this loop runs a few hundred times a tick.
  const basis = new THREE.Object3D()
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const closest = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const dir = new THREE.Vector3()

  function writeInstance(i: number, bolt: Bolt, alpha: number) {
    if (!bolt.active) {
      mesh.setMatrixAt(i, hidden)
      return
    }
    dir.copy(bolt.vel).normalize()
    quat.setFromUnitVectors(FORWARD, dir)
    // A bolt flies dead straight, so interpolating position alone is exact
    // rather than an approximation — there is no rotation to blend.
    basis.position.lerpVectors(bolt.prev, bolt.pos, alpha)
    basis.quaternion.copy(quat)
    basis.scale.set(1, 1, BOLT_LENGTH)
    basis.updateMatrix()
    mesh.setMatrixAt(i, basis.matrix)
    mesh.instanceColor!.setXYZ(i, bolt.color.r, bolt.color.g, bolt.color.b)
  }

  /**
   * Squared distance from `center` to segment a→b, plus the closest point.
   * Written out rather than using a helper so nothing allocates per test.
   */
  function segmentDistanceSq(a: THREE.Vector3, b: THREE.Vector3, center: THREE.Vector3): number {
    ab.subVectors(b, a)
    ac.subVectors(center, a)
    const lenSq = ab.lengthSq()
    const t = lenSq > 1e-6 ? Math.min(1, Math.max(0, ac.dot(ab) / lenSq)) : 0
    closest.copy(a).addScaledVector(ab, t)
    return closest.distanceToSquared(center)
  }

  return {
    mesh,

    fire(req) {
      // Oldest-first overwrite. At 420 slots a bolt only gets stolen if the
      // arena is genuinely saturated, and losing the eldest is the right loss.
      for (let n = 0; n < MAX_BOLTS; n++) {
        const i = (cursor + n) % MAX_BOLTS
        if (pool[i].active) continue
        cursor = (i + 1) % MAX_BOLTS
        const bolt = pool[i]
        bolt.active = true
        bolt.pos.copy(req.origin)
        bolt.prev.copy(req.origin)
        bolt.vel.copy(req.direction).normalize().multiplyScalar(req.speed)
        bolt.life = BOLT_LIFETIME
        bolt.damage = req.damage
        bolt.faction = req.faction
        bolt.color.copy(req.color)
        return
      }
      // Pool exhausted: drop the shot rather than stealing a live bolt.
    },

    update(dt, targets, hazards) {
      const hits: BoltHit[] = []

      for (let i = 0; i < MAX_BOLTS; i++) {
        const bolt = pool[i]
        if (!bolt.active) continue

        bolt.life -= dt
        if (bolt.life <= 0) {
          bolt.active = false
          continue
        }

        bolt.prev.copy(bolt.pos)
        bolt.pos.addScaledVector(bolt.vel, dt)

        let consumed = false

        for (const target of targets) {
          if (!target.alive || !target.targetable) continue
          // Friendly fire is off, which also covers a ship shooting itself:
          // enemies would otherwise shred each other while chasing you
          // through the same firing line, and win the game on your behalf.
          if (target.faction === bolt.faction) continue

          const reach = target.radius + BOLT_RADIUS
          if (segmentDistanceSq(bolt.prev, bolt.pos, target.position) <= reach * reach) {
            hits.push({
              point: closest.clone(),
              target,
              damage: bolt.damage,
              faction: bolt.faction,
              color: bolt.color.clone(),
            })
            target.takeDamage(bolt.damage, bolt.faction)
            consumed = true
            break
          }
        }

        if (!consumed) {
          for (const hazard of hazards) {
            if (segmentDistanceSq(bolt.prev, bolt.pos, hazard.center) <= hazard.radius * hazard.radius) {
              hits.push({
                point: closest.clone(),
                target: null,
                damage: 0,
                faction: bolt.faction,
                color: bolt.color.clone(),
              })
              consumed = true
              break
            }
          }
        }

        if (consumed) bolt.active = false
      }

      return hits
    },

    render(alpha) {
      for (let i = 0; i < MAX_BOLTS; i++) writeInstance(i, pool[i], alpha)
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor!.needsUpdate = true
    },

    clear() {
      for (let i = 0; i < MAX_BOLTS; i++) {
        pool[i].active = false
        mesh.setMatrixAt(i, hidden)
      }
      mesh.instanceMatrix.needsUpdate = true
    },

    dispose() {
      geometry.dispose()
      material.dispose()
      mesh.dispose()
    },
  }
}
