import * as THREE from 'three'
import type { Ship } from './ship'

/** A crash cannot erase even the Wasp's full 70-point hull in one impact. */
export const MAX_RAM_DAMAGE = 55
export const RAM_COOLDOWN = 0.3
const DAMAGE_THRESHOLD = 60
const DAMAGE_PER_SPEED = 0.1
const RESTITUTION = 0.45

export interface ShipImpact {
  a: Ship
  b: Ship
  point: THREE.Vector3
  closingSpeed: number
  damageA: number
  damageB: number
}

/** Pair history belongs to a match, never to a ship or a render frame. */
export function createShipCollisions() {
  let last = new WeakMap<Ship, WeakMap<Ship, number>>()

  return {
    reset() { last = new WeakMap() },
    resolve(ships: readonly Ship[], now: number, onImpact: (impact: ShipImpact) => void): void {
      for (let i = 0; i < ships.length; i++) {
        const a = ships[i]
        if (!a.targetable) continue
        for (let j = i + 1; j < ships.length; j++) {
          const b = ships[j]
          if (!b.targetable) continue
          const radius = a.radius + b.radius
          const dx = b.position.x - a.position.x
          const dy = b.position.y - a.position.y
          const dz = b.position.z - a.position.z
          const distanceSq = dx * dx + dy * dy + dz * dz
          if (distanceSq >= radius * radius) continue

          // Stable normal even if two hull centres coincide exactly.
          const distance = Math.sqrt(distanceSq)
          const normal = distance > 1e-6
            ? new THREE.Vector3(dx / distance, dy / distance, dz / distance)
            : new THREE.Vector3(1, 0, 0)
          const massA = a.spec.maxHull
          const massB = b.spec.maxHull
          const invA = 1 / massA
          const invB = 1 / massB
          const invTotal = invA + invB
          const point = a.position.clone().addScaledVector(normal, a.radius - (radius - distance) * invA / invTotal)

          // Position separation always runs, including during damage cooldown.
          const overlap = radius - distance
          a.position.addScaledVector(normal, -overlap * invA / invTotal)
          b.position.addScaledVector(normal, overlap * invB / invTotal)

          const relative = b.velocity.clone().sub(a.velocity).dot(normal)
          const closingSpeed = Math.max(0, -relative)
          if (relative < 0) {
            const impulse = -(1 + RESTITUTION) * relative / invTotal
            a.velocity.addScaledVector(normal, -impulse * invA)
            b.velocity.addScaledVector(normal, impulse * invB)
          }

          const prior = last.get(a)?.get(b) ?? -Infinity
          if (closingSpeed <= 0 || now - prior < RAM_COOLDOWN) continue
          let pair = last.get(a)
          if (!pair) { pair = new WeakMap(); last.set(a, pair) }
          pair.set(b, now)

          // Match the bolt rule: NPC squadron mates share a faction, while
          // human seats remain opponents even in a no-respawn pot room.
          const friendly = a.faction === b.faction
          const force = Math.max(0, closingSpeed - DAMAGE_THRESHOLD) * DAMAGE_PER_SPEED
          const damageA = friendly ? 0 : Math.min(MAX_RAM_DAMAGE, force * 2 * massB / (massA + massB))
          const damageB = friendly ? 0 : Math.min(MAX_RAM_DAMAGE, force * 2 * massA / (massA + massB))
          onImpact({ a, b, point, closingSpeed, damageA, damageB })
          if (damageA > 0) a.takeDamage(damageA, b.faction)
          if (damageB > 0) b.takeDamage(damageB, a.faction)
        }
      }
    },
  }
}
