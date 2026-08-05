/**
 * Enemy pilots.
 *
 * The AI does not move ships. It produces the same `Controls` struct the player
 * produces and hands it to `Ship.step`, so an AI is bound by the exact turn
 * rate, acceleration and gun heat its hull publishes. That is the whole point:
 * an enemy Wasp is fast because a Wasp is fast, not because its AI was allowed
 * to cheat, and a balance tweak lands on both sides at once.
 *
 * Behaviour is a four-state machine — approach, attack, break, evade — with
 * per-hull profiles, a wander offset so nobody flies a straight line, and soft
 * separation so a squadron does not converge into one blob.
 */

import * as THREE from 'three'
import { ARENA_RADIUS, type Hazard } from '../world/environment'
import type { ShipId } from '../ships/specs'
import type { Controls } from './ship'
import { Ship } from './ship'

type AiState = 'approach' | 'attack' | 'break' | 'evade'

interface AiProfile {
  /** Start shooting inside this range. */
  engageRange: number
  /** Peel off inside this range rather than ramming. */
  breakDistance: number
  /** Preferred fighting distance, held during attack. */
  idealRange: number
  /** Fire only when the nose is within this many radians of the lead solution. */
  aimTolerance: number
  /** Cone of inaccuracy, radians. */
  spread: number
  /** Lateral wander magnitude, world units. */
  jink: number
  jinkInterval: [number, number]
  /** [seconds firing, seconds resting], or null to hold the trigger. */
  burst: [number, number] | null
  /** Chance per break-off of spending a dash, if the hull has one. */
  dashChance: number
  /** Throttle held while fighting, 0..1. */
  aggression: number
}

const PROFILES: Record<ShipId, AiProfile> = {
  wasp: {
    engageRange: 750,
    breakDistance: 130,
    idealRange: 320,
    aimTolerance: 0.1,
    spread: 0.03,
    jink: 105,
    jinkInterval: [0.7, 1.6],
    burst: [0.75, 0.85], // has to respect its own gun heat, so bursts anyway
    dashChance: 0,
    aggression: 0.95,
  },
  drone: {
    engageRange: 950,
    breakDistance: 220,
    idealRange: 520,
    aimTolerance: 0.055, // slow reload, so it waits for a real shot
    spread: 0.028,
    jink: 60,
    jinkInterval: [1.4, 2.6],
    burst: null,
    dashChance: 0,
    aggression: 0.72,
  },
  hornet: {
    engageRange: 820,
    breakDistance: 165,
    idealRange: 400,
    aimTolerance: 0.075,
    spread: 0.022,
    jink: 85,
    jinkInterval: [0.9, 2.0],
    burst: [1.4, 0.7],
    dashChance: 0.35,
    aggression: 0.86,
  },
}

/** Proportional gain from angular error to stick deflection. */
const STEER_GAIN = 2.6
/** Enemies inside this distance of each other drift apart. */
const SEPARATION_RANGE = 150
/** Beyond this share of the arena radius, enemies steer back toward the middle. */
const LEASH = 0.82

const _toTarget = new THREE.Vector3()
const _lead = new THREE.Vector3()
const _aimPoint = new THREE.Vector3()
const _desired = new THREE.Vector3()
const _local = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _inverse = new THREE.Quaternion()
const _push = new THREE.Vector3()

function randomUnit(out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * 2 - 1
  const theta = Math.random() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - u * u))
  return out.set(r * Math.cos(theta), u, r * Math.sin(theta))
}

export class EnemyPilot {
  readonly ship: Ship
  private readonly profile: AiProfile

  private state: AiState = 'approach'
  private stateTimer = 0
  /** Preferred side to come in from, so the squadron does not stack up. */
  private readonly flank = new THREE.Vector3()
  private readonly jinkOffset = new THREE.Vector3()
  private jinkTimer = 0
  private burstTimer = 0
  private firing = true
  private evadeCooldown = 0
  private wantsDash = false
  /**
   * Owned by this pilot rather than shared module scratch: `controls.aim` is
   * read by `Ship.step` after `think` returns, so a shared vector would be
   * overwritten by the next pilot's turn if the caller ever batched all the
   * thinking before all the stepping.
   */
  private readonly aimVector = new THREE.Vector3()

  private readonly controls: Controls = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0.8,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
  }

  constructor(ship: Ship) {
    this.ship = ship
    this.profile = PROFILES[ship.spec.id]
    randomUnit(this.flank)
    this.controls.spread = this.profile.spread
    this.resetJink()
  }

  private resetJink(): void {
    const [lo, hi] = this.profile.jinkInterval
    this.jinkTimer = lo + Math.random() * (hi - lo)
    randomUnit(this.jinkOffset).multiplyScalar(this.profile.jink)
  }

  private enter(state: AiState, duration: number): void {
    this.state = state
    this.stateTimer = duration
  }

  /**
   * Produces this frame's controls. `peers` is the full enemy list, used only
   * for separation; passing it in avoids the AI holding a back-reference to the
   * game and lets a squadron be simulated in any order.
   */
  think(target: Ship, peers: readonly Ship[], hazards: Hazard[], dt: number): Controls {
    const self = this.ship
    const p = this.profile
    const c = this.controls

    this.stateTimer -= dt
    this.jinkTimer -= dt
    this.evadeCooldown = Math.max(0, this.evadeCooldown - dt)
    if (this.jinkTimer <= 0) this.resetJink()

    _toTarget.subVectors(target.position, self.position)
    const dist = _toTarget.length()

    /* ---- State transitions --------------------------------------------- */

    // A fresh wound while low on hull is the cue to disengage and reset.
    if (
      this.state !== 'evade' &&
      this.evadeCooldown <= 0 &&
      self.hullFraction < 0.35 &&
      self.sinceHit < 0.4
    ) {
      this.enter('evade', 1.9)
      this.evadeCooldown = 6.5
      randomUnit(this.flank)
    }

    switch (this.state) {
      case 'approach':
        if (dist < p.engageRange) this.enter('attack', 0)
        break
      case 'attack':
        if (dist < p.breakDistance) {
          this.enter('break', 1.1 + Math.random() * 1.1)
          this.wantsDash = Math.random() < p.dashChance
          randomUnit(this.flank)
        } else if (dist > p.engageRange * 1.6) {
          this.enter('approach', 0)
        }
        break
      case 'break':
      case 'evade':
        if (this.stateTimer <= 0) this.enter('approach', 0)
        break
    }

    /* ---- Lead solution -------------------------------------------------- */

    // Where the target will be when a bolt gets there.
    const boltSpeed = self.spec.boltSpeed + Math.max(0, self.speed) * 0.35
    const flight = dist / boltSpeed
    _lead.copy(target.position).addScaledVector(target.velocity, flight)

    /* ---- Steering goal -------------------------------------------------- */

    switch (this.state) {
      case 'approach':
        // Curve in from an assigned side instead of driving straight down the
        // target's nose, which is both smarter and much better looking.
        _aimPoint.copy(target.position).addScaledVector(this.flank, p.idealRange * 0.6)
        c.throttle = 1
        break

      case 'attack':
        _aimPoint.copy(_lead).add(this.jinkOffset)
        // Ease off when inside the preferred range so it does not close to a ram.
        c.throttle = dist < p.idealRange ? p.aggression * 0.72 : p.aggression
        break

      case 'break':
        // Extend past the target and out to the side — a real fighter break.
        self.forward(_forward)
        _aimPoint
          .copy(self.position)
          .addScaledVector(_forward, 350)
          .addScaledVector(this.flank, 650)
        c.throttle = 1
        break

      case 'evade':
        _aimPoint
          .copy(self.position)
          .addScaledVector(_toTarget, -1.4)
          .add(this.jinkOffset)
          .addScaledVector(this.flank, 300)
        c.throttle = 1
        break
    }

    // Soft separation, so a squadron spreads instead of flying in formation.
    for (const peer of peers) {
      if (peer === self || !peer.alive) continue
      _push.subVectors(self.position, peer.position)
      const d = _push.length()
      if (d > SEPARATION_RANGE || d < 1e-3) continue
      _aimPoint.addScaledVector(_push.multiplyScalar(1 / d), (SEPARATION_RANGE - d) * 2.4)
    }

    // Hazard avoidance — stations and mines both. Enemies bounce off station
    // hulls like the player does, but steering around is better than watching
    // them grind along a habitat ring. Each hazard carries its own avoid range,
    // so a mine gets a tight berth and a station a wide one.
    //
    // This is deliberately imperfect: it is a steering bias, not a guarantee, so
    // an enemy under pressure can still blunder into a mine. That is a good
    // moment, not a bug.
    for (const hazard of hazards) {
      _push.subVectors(self.position, hazard.center)
      const d = _push.length()
      const trigger = hazard.radius + hazard.avoidRange
      if (d > trigger || d < 1e-3) continue
      _aimPoint.addScaledVector(_push.multiplyScalar(1 / d), (trigger - d) * 2.2)
    }

    // Leash to the arena. Without this a breaking or evading enemy happily flies
    // into the boundary and grinds along it, which looks broken and takes it out
    // of the fight — the same trap the boundary force exists to rescue you from.
    const fromCentre = self.position.length()
    if (fromCentre > ARENA_RADIUS * LEASH) {
      const urgency = (fromCentre - ARENA_RADIUS * LEASH) / (ARENA_RADIUS * (1 - LEASH))
      _aimPoint.lerp(_push.set(0, 0, 0), Math.min(0.85, urgency))
    }

    /* ---- Error to stick ------------------------------------------------- */

    _desired.subVectors(_aimPoint, self.position)
    if (_desired.lengthSq() < 1e-6) _desired.copy(_toTarget)
    _desired.normalize()

    // Rotate the goal into the body frame; forward is -Z, +X is right, +Y is up.
    _inverse.copy(self.quaternion).invert()
    _local.copy(_desired).applyQuaternion(_inverse)

    const yawError = Math.atan2(_local.x, -_local.z)
    const pitchError = Math.atan2(_local.y, Math.hypot(_local.x, _local.z))

    c.pitch = clamp(pitchError * STEER_GAIN, -1, 1)
    c.yaw = clamp(yawError * STEER_GAIN, -1, 1)
    c.roll = clamp(yawError * 0.7, -1, 1) // bank into the turn, cosmetic only

    /* ---- Trigger -------------------------------------------------------- */

    if (p.burst) {
      this.burstTimer -= dt
      if (this.burstTimer <= 0) {
        this.firing = !this.firing
        this.burstTimer = this.firing ? p.burst[0] : p.burst[1]
      }
    } else {
      this.firing = true
    }

    this.aimVector.subVectors(_lead, self.position).normalize()
    self.forward(_forward)
    const aimError = Math.acos(clamp(_forward.dot(this.aimVector), -1, 1))

    c.fire =
      this.firing &&
      this.state === 'attack' &&
      dist < p.engageRange &&
      aimError < p.aimTolerance &&
      target.targetable
    c.aim = c.fire ? this.aimVector : null

    c.dash = this.wantsDash && this.state === 'break'
    if (c.dash) this.wantsDash = false

    return c
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
