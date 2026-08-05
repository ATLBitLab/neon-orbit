/**
 * The BFG.
 *
 * Officially a Bulk Fusion Generator. Nobody calls it that.
 *
 * Everything else in this game is a decision you make with the stick. This is
 * the one you make with the clock: hold the trigger for over a second while the
 * guns are cold, the throttle is capped and the dash is locked out, and hope the
 * furball is still where you left it. A weapon that only did enormous damage
 * would be a stat. Charging in the open is what makes it a choice.
 *
 * Three rules do most of the design work:
 *
 * **Two shots a run, no refills.** Anything renewable becomes a rotation you
 * press on cooldown. Two means every launch is a judgement about whether *this*
 * is the moment, and firing the second one is a small tragedy.
 *
 * **The blast does not care whose side you are on.** It hurts the pilot who
 * fired it at 60% — enough that a point-blank shot kills a Wasp outright and
 * takes a third of a Drone. The distance you keep is the price of the damage
 * you get, and it is paid in the same currency the enemy pays.
 *
 * **The AI runs from a live round.** Each one registers as a steering hazard
 * with a bubble the size of its blast, so hostiles scatter as it crosses the
 * arena. That makes it a zoning tool as much as a killing one: the shot that
 * misses everything still breaks a formation off your tail, and a good pilot
 * learns to fire it where they want people to *not be*.
 *
 * Player-only. An AI holding one of these would either never use it or nuke its
 * own wing, and neither is a fight anyone wants.
 *
 * Pure maths over three.js vectors apart from the two meshes it owns, so the
 * whole thing runs headless in `scripts/simcheck.ts`.
 */

import * as THREE from 'three'
import type { Hazard } from '../world/environment'
import type { Minefield } from '../world/mines'
import type { Team } from './bolts'

/** Shots per run. There is no way to earn more. */
export const BFG_CHARGES = 2
/** Seconds on the trigger before it launches. */
export const SPOOL_TIME = 1.3
/** Throttle ceiling while spooling — you commit to a heading, not just a moment. */
export const SPOOL_THROTTLE_CAP = 0.55
/** Seconds of dead trigger after an abort, so tapping is not free. */
export const ABORT_RECOVERY = 0.6

export const ROUND_SPEED = 420
/** Contact sphere. Fat, because a slow round that clips through a hull is a bug. */
export const ROUND_RADIUS = 22
/** Seconds before it cooks off on its own. ~1750 units of reach. */
export const ROUND_LIFETIME = 4.2
export const MAX_ROUNDS = 3

export const BLAST_RADIUS = 340
/** Damage at the centre of the blast. Deletes any airframe in the game. */
export const BLAST_DAMAGE = 260
/**
 * Falloff exponent. Above 1 so the lethal core is genuinely small and the outer
 * two thirds of the sphere is a hard shove and a scare — at half radius this is
 * 86 damage, which hurts a Hornet and does not decide the fight.
 */
export const BLAST_FALLOFF = 1.6
/** What the pilot who fired it takes. Enough to be a real mistake. */
export const SELF_DAMAGE = 0.6
/** Velocity added away from the blast at the centre, units/sec. */
export const BLAST_KNOCKBACK = 260

/** Everything the weapon needs from a ship. `Ship` satisfies this structurally. */
export interface BfgTarget {
  readonly position: THREE.Vector3
  readonly velocity: THREE.Vector3
  readonly radius: number
  readonly alive: boolean
  /** False while warping in or phase-dashing. */
  readonly targetable: boolean
  readonly team: Team
  takeDamage(amount: number, from: Team): void
}

export type BfgEvent =
  | { kind: 'spool'; progress: number }
  | { kind: 'abort' }
  | { kind: 'launch'; position: THREE.Vector3 }
  | {
      kind: 'detonate'
      position: THREE.Vector3
      /** Hostiles that took damage. */
      enemiesHit: number
      /** Hostiles the blast finished off. */
      kills: number
      /** Whether the pilot caught their own blast. */
      selfHit: boolean
      /** Mines set off by the shockwave. */
      minesChained: number
    }

export interface BfgFrame {
  /** The pilot. Null between runs. */
  owner: BfgTarget | null
  /** Nose direction, for the launch vector. */
  forward: THREE.Vector3
  /** Secondary trigger held. */
  hold: boolean
  /** Everything the blast can touch, including the owner. */
  targets: readonly BfgTarget[]
  /** Solid geometry a round detonates against. */
  hazards: readonly Hazard[]
  minefield: Minefield | null
  /** Rounds cook off rather than leave the arena. */
  arenaLimit: number
}

export interface Bfg {
  group: THREE.Group
  readonly charges: number
  /** Spool progress, 0..1. */
  readonly spool: number
  readonly spooling: boolean
  readonly roundsInFlight: number
  /**
   * Live rounds as AI steering hazards. A stable array whose contents change as
   * rounds launch and detonate, so callers can concat it once per frame.
   */
  readonly avoidance: Hazard[]
  update(dt: number, frame: BfgFrame): BfgEvent[]
  /** Re-arm for a new run. */
  reset(): void
  syncVisual(dt: number): void
  clear(): void
  dispose(): void
}

interface Round {
  live: boolean
  position: THREE.Vector3
  velocity: THREE.Vector3
  life: number
  team: Team
  hazard: Hazard
  core: THREE.Mesh
  halo: THREE.Mesh
  spin: number
}

const _push = new THREE.Vector3()
const _muzzle = new THREE.Vector3()

/** Blast strength at a distance, 1 at the centre and 0 at the edge. */
export function blastFraction(distance: number): number {
  if (distance >= BLAST_RADIUS) return 0
  return Math.pow(1 - distance / BLAST_RADIUS, BLAST_FALLOFF)
}

export function createBfg(accent = 0x9dff3b): Bfg {
  const group = new THREE.Group()

  const coreGeometry = new THREE.IcosahedronGeometry(ROUND_RADIUS * 0.72, 1)
  const haloGeometry = new THREE.IcosahedronGeometry(ROUND_RADIUS * 1.55, 1)

  const rounds: Round[] = Array.from({ length: MAX_ROUNDS }, () => {
    // White core inside a coloured shell: under bloom the white blows out into
    // the shell and the whole thing reads as one object with a hot middle,
    // which a single emissive sphere never manages.
    const core = new THREE.Mesh(
      coreGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    )
    const halo = new THREE.Mesh(
      haloGeometry,
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    core.visible = false
    halo.visible = false
    core.frustumCulled = false
    halo.frustumCulled = false
    group.add(core, halo)

    const position = new THREE.Vector3()
    return {
      live: false,
      position,
      velocity: new THREE.Vector3(),
      life: 0,
      team: 'player' as Team,
      // The hazard holds the same vector instance the round moves, so the AI
      // reads a live position without anything having to copy it per frame.
      hazard: {
        center: position,
        radius: ROUND_RADIUS,
        avoidRange: BLAST_RADIUS * 1.15,
        name: 'BFG round',
      },
      core,
      halo,
      spin: 0,
    }
  })

  const avoidance: Hazard[] = []

  let charges = BFG_CHARGES
  let spoolTimer = 0
  let recovery = 0

  function refreshAvoidance(): void {
    avoidance.length = 0
    for (const round of rounds) if (round.live) avoidance.push(round.hazard)
  }

  function launch(frame: BfgFrame): BfgEvent | null {
    const owner = frame.owner
    const slot = rounds.find((r) => !r.live)
    if (!owner || !slot) return null

    // Ahead of the nose, so the round is never born already touching the hull
    // that fired it.
    _muzzle.copy(owner.position).addScaledVector(frame.forward, owner.radius + ROUND_RADIUS * 1.6)

    slot.live = true
    slot.position.copy(_muzzle)
    // A fraction of the ship's own velocity, so firing while running away does
    // not leave the round hanging behind you looking silly.
    slot.velocity.copy(frame.forward).multiplyScalar(ROUND_SPEED).addScaledVector(owner.velocity, 0.2)
    slot.life = ROUND_LIFETIME
    slot.team = owner.team
    slot.spin = 0
    slot.core.position.copy(_muzzle)
    slot.halo.position.copy(_muzzle)
    slot.core.visible = true
    slot.halo.visible = true

    charges--
    refreshAvoidance()
    return { kind: 'launch', position: slot.position }
  }

  function detonate(round: Round, frame: BfgFrame): BfgEvent {
    let enemiesHit = 0
    let kills = 0
    let selfHit = false

    for (const target of frame.targets) {
      if (!target.alive || !target.targetable) continue

      const distance = target.position.distanceTo(round.position)
      const fraction = blastFraction(Math.max(0, distance - target.radius))
      if (fraction <= 0) continue

      const own = target.team === round.team
      const damage = BLAST_DAMAGE * fraction * (own ? SELF_DAMAGE : 1)

      // Shove first: a ship killed by the blast should still be thrown by it,
      // and `takeDamage` may flip `alive` before we get there.
      _push.subVectors(target.position, round.position)
      if (_push.lengthSq() < 1e-6) _push.copy(frame.forward)
      target.velocity.addScaledVector(_push.normalize(), BLAST_KNOCKBACK * fraction)

      const before = target.alive
      target.takeDamage(damage, own ? 'enemy' : round.team)

      if (own) {
        selfHit = true
      } else {
        enemiesHit++
        if (before && !target.alive) kills++
      }
    }

    // The shockwave sets off anything armed nearby. Chained mines do not add
    // their own damage — the blast has already been applied over that volume,
    // and double-dipping would make a minefield detonation wildly swingy.
    let minesChained = 0
    const field = frame.minefield
    if (field) {
      for (const mine of field.mines) {
        if (!mine.live) continue
        if (mine.position.distanceTo(round.position) > BLAST_RADIUS) continue
        field.detonate(mine)
        minesChained++
      }
    }

    round.live = false
    round.core.visible = false
    round.halo.visible = false
    refreshAvoidance()

    return {
      kind: 'detonate',
      position: round.position,
      enemiesHit,
      kills,
      selfHit,
      minesChained,
    }
  }

  /** True when the round has run into something solid this frame. */
  function contact(round: Round, frame: BfgFrame): boolean {
    for (const target of frame.targets) {
      if (!target.alive || !target.targetable) continue
      if (target.position.distanceTo(round.position) <= target.radius + ROUND_RADIUS) return true
    }
    for (const hazard of frame.hazards) {
      if (round.position.distanceTo(hazard.center) <= hazard.radius + ROUND_RADIUS) return true
    }
    const field = frame.minefield
    if (field && field.findContact(round.position, ROUND_RADIUS)) return true
    return round.position.length() >= frame.arenaLimit
  }

  return {
    group,
    get charges() {
      return charges
    },
    get spool() {
      return spoolTimer / SPOOL_TIME
    },
    get spooling() {
      return spoolTimer > 0
    },
    get roundsInFlight() {
      return rounds.reduce((n, r) => n + (r.live ? 1 : 0), 0)
    },
    avoidance,

    update(dt, frame) {
      const events: BfgEvent[] = []

      /* ---- Trigger ------------------------------------------------------ */

      if (recovery > 0) recovery = Math.max(0, recovery - dt)

      const canSpool =
        frame.hold &&
        recovery <= 0 &&
        charges > 0 &&
        frame.owner !== null &&
        frame.owner.alive &&
        rounds.some((r) => !r.live)

      if (canSpool) {
        spoolTimer += dt
        if (spoolTimer >= SPOOL_TIME) {
          spoolTimer = 0
          const event = launch(frame)
          if (event) events.push(event)
          // A launch consumes the trigger. Holding the button down does not
          // immediately start winding the next one — let go and mean it.
          recovery = ABORT_RECOVERY
        } else {
          events.push({ kind: 'spool', progress: spoolTimer / SPOOL_TIME })
        }
      } else if (spoolTimer > 0) {
        // Released early, died mid-charge, or ran the arena out of round slots.
        // The charge is kept: punishing a mispress with a permanent loss of one
        // of two shots would make people never touch the button.
        spoolTimer = 0
        recovery = ABORT_RECOVERY
        events.push({ kind: 'abort' })
      }

      /* ---- Rounds ------------------------------------------------------- */

      for (const round of rounds) {
        if (!round.live) continue

        round.position.addScaledVector(round.velocity, dt)
        round.life -= dt
        round.spin += dt

        if (round.life <= 0 || contact(round, frame)) {
          events.push(detonate(round, frame))
        }
      }

      return events
    },

    reset() {
      charges = BFG_CHARGES
      spoolTimer = 0
      recovery = 0
      this.clear()
    },

    syncVisual(dt) {
      for (const round of rounds) {
        if (!round.live) continue
        round.core.position.copy(round.position)
        round.halo.position.copy(round.position)
        round.core.rotation.y += dt * 3.1
        round.core.rotation.x += dt * 1.7
        // Breathe, so a slow round still reads as something under pressure
        // rather than a ball someone threw.
        const pulse = 1 + Math.sin(round.spin * 14) * 0.09
        round.halo.scale.setScalar(pulse)
      }
    },

    clear() {
      for (const round of rounds) {
        round.live = false
        round.core.visible = false
        round.halo.visible = false
      }
      refreshAvoidance()
    },

    dispose() {
      coreGeometry.dispose()
      haloGeometry.dispose()
      for (const round of rounds) {
        ;(round.core.material as THREE.Material).dispose()
        ;(round.halo.material as THREE.Material).dispose()
      }
    },
  }
}
