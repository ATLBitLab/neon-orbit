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

export type Team = 'player' | 'enemy'

/** Anything a bolt can hit. `Ship` satisfies this structurally. */
export interface BoltTarget {
  readonly position: THREE.Vector3
  readonly radius: number
  readonly alive: boolean
  /** False while warping in or phase-dashing. */
  readonly targetable: boolean
  readonly team: Team
  takeDamage(amount: number, from: Team): void
}

export interface FireRequest {
  origin: THREE.Vector3
  direction: THREE.Vector3
  speed: number
  damage: number
  team: Team
  color: THREE.Color
}

export interface BoltHit {
  point: THREE.Vector3
  target: BoltTarget | null
  damage: number
  team: Team
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
  team: Team
  color: THREE.Color
}

export interface Bolts {
  mesh: THREE.InstancedMesh
  fire(req: FireRequest): void
  /** Advances every bolt and resolves hits. Returns this frame's impacts. */
  update(dt: number, targets: BoltTarget[], hazards: Hazard[]): BoltHit[]
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
    team: 'enemy' as Team,
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

  function writeInstance(i: number, bolt: Bolt) {
    if (!bolt.active) {
      mesh.setMatrixAt(i, hidden)
      return
    }
    dir.copy(bolt.vel).normalize()
    quat.setFromUnitVectors(FORWARD, dir)
    basis.position.copy(bolt.pos)
    basis.quaternion.copy(quat)
    basis.scale.set(1, 1, BOLT_LENGTH)
    basis.updateMatrix()
    mesh.setMatrixAt(i, basis.matrix)
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
        bolt.team = req.team
        bolt.color.copy(req.color)
        mesh.instanceColor!.setXYZ(i, req.color.r, req.color.g, req.color.b)
        return
      }
      // Pool exhausted: drop the shot rather than stealing a live bolt.
    },

    update(dt, targets, hazards) {
      const hits: BoltHit[] = []

      for (let i = 0; i < MAX_BOLTS; i++) {
        const bolt = pool[i]
        if (!bolt.active) {
          mesh.setMatrixAt(i, hidden)
          continue
        }

        bolt.life -= dt
        if (bolt.life <= 0) {
          bolt.active = false
          mesh.setMatrixAt(i, hidden)
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
          if (target.team === bolt.team) continue

          const reach = target.radius + BOLT_RADIUS
          if (segmentDistanceSq(bolt.prev, bolt.pos, target.position) <= reach * reach) {
            hits.push({
              point: closest.clone(),
              target,
              damage: bolt.damage,
              team: bolt.team,
              color: bolt.color.clone(),
            })
            target.takeDamage(bolt.damage, bolt.team)
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
                team: bolt.team,
                color: bolt.color.clone(),
              })
              consumed = true
              break
            }
          }
        }

        if (consumed) {
          bolt.active = false
          mesh.setMatrixAt(i, hidden)
        } else {
          writeInstance(i, bolt)
        }
      }

      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor!.needsUpdate = true
      return hits
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
