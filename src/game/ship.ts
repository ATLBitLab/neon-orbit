/**
 * The flight model, shared by the player and every AI.
 *
 * Deliberately one class rather than two: an enemy Wasp overheats exactly like
 * yours, an enemy Drone regenerates exactly like yours. That makes the ship you
 * are fighting legible — you learn a hull once and the knowledge transfers in
 * both directions — and it means balance changes cannot silently apply to one
 * side only.
 *
 * Flight is arcade, not Newtonian: throttle sets a speed the ship converges on,
 * and velocity chases the nose at a per-hull `grip` rate. Full inertia would be
 * accurate and miserable to fly with two keys.
 */

import * as THREE from 'three'
import type { Audio } from '../core/audio'
import { buildShip, disposeShipVisual, type ShipVisual } from '../ships/meshes'
import type { ShipSpec } from '../ships/specs'
import {
  ARENA_HARD_LIMIT,
  ARENA_RADIUS,
  solarExposure as solarExposureAt,
  type Hazard,
} from '../world/environment'
import type { BoltTarget, Bolts, Team } from './bolts'

export interface Controls {
  /** -1 nose down .. +1 nose up. */
  pitch: number
  /** -1 nose left .. +1 nose right. */
  yaw: number
  /** -1 roll left .. +1 roll right. */
  roll: number
  /** Commanded throttle, 0..1. */
  throttle: number
  fire: boolean
  dash: boolean
  /**
   * Fire direction override. The player always shoots along the nose (`null`);
   * the AI shoots along a lead solution, which may be slightly off-nose.
   */
  aim: THREE.Vector3 | null
  /** Cone of inaccuracy in radians. Zero for the player. */
  spread: number
}

export interface ShipContext {
  hazards: Hazard[]
  audio: Audio
  bolts: Bolts
}

export const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1)

/** Seconds a ship spends materialising, during which it cannot be shot. */
const WARP_DURATION = 0.85

/** Hull damage per second at full solar exposure. */
const SEAR_DPS = 30
/**
 * Burn is banked and spent in discrete ticks rather than applied every frame,
 * so the damage flash, the hull thump and the camera shake fire at a readable
 * rate instead of sixty times a second.
 */
const SEAR_TICK = 0.4

// Module-level scratch. Ship.step runs for every ship every frame.
const _euler = new THREE.Euler()
const _dq = new THREE.Quaternion()
const _desired = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _muzzle = new THREE.Vector3()
const _toShip = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _outNormal = new THREE.Vector3()
const _aim = new THREE.Vector3()
const _jitter = new THREE.Vector3()

export class Ship implements BoltTarget {
  readonly spec: ShipSpec
  readonly team: Team
  readonly visual: ShipVisual
  readonly accent: THREE.Color

  readonly position = new THREE.Vector3()
  readonly quaternion = new THREE.Quaternion()
  readonly velocity = new THREE.Vector3()

  hull: number
  /** Current airspeed along the nose. */
  speed = 0
  /** Commanded throttle, smoothed into `speed` by `spec.accel`. */
  throttle = 0.55
  alive = true

  /** Counts down while materialising. */
  warpTimer = WARP_DURATION
  /** Damage flash, 1 → 0. */
  flash = 0
  /** Seconds since last damage taken. */
  sinceHit = 99

  /* Quirk state — only the fields matching `spec.quirk.kind` are used. */
  heat = 0
  /** Seconds of forced gun silence remaining after an overheat. */
  heatLocked = 0
  /** Seconds of dash remaining. */
  dashTimer = 0
  /** Seconds until dash is available again. */
  dashCooldown = 0

  fireTimer = 0
  shotsFired = 0

  /** 0 inside the patrol zone, 1 at the hard limit. Refreshed once per step. */
  private boundaryDepth = 0

  /** 0 clear of the star, 1 at the full burn rate. Refreshed once per step. */
  solarExposure = 0
  /** Seconds of burn banked since the last sear tick. */
  private searTimer = 0

  onDeath?: (ship: Ship) => void
  onDamaged?: (ship: Ship, amount: number, from: Team) => void
  /** Fired when the hull scrapes a station. */
  onCollide?: (ship: Ship, speed: number) => void

  private readonly baseEmissive: THREE.Color
  private readonly flashEmissive = new THREE.Color(0xff5566)

  constructor(spec: ShipSpec, team: Team) {
    this.spec = spec
    this.team = team
    this.hull = spec.maxHull
    this.visual = buildShip(spec)
    this.accent = new THREE.Color(spec.accent)
    this.baseEmissive = this.visual.hullMat.emissive.clone()
  }

  get radius(): number {
    return this.spec.radius
  }

  /** False while materialising or phase-dashing — bolts pass straight through. */
  get targetable(): boolean {
    return this.alive && this.warpTimer <= 0 && this.dashTimer <= 0
  }

  get hullFraction(): number {
    return Math.max(0, this.hull / this.spec.maxHull)
  }

  /** Outside the patrol zone, where the boundary is actively pushing back. */
  get outOfBounds(): boolean {
    return this.position.lengthSq() > ARENA_RADIUS * ARENA_RADIUS
  }

  /** Metres past the patrol line, for the HUD warning. */
  get boundaryOvershoot(): number {
    return Math.max(0, this.position.length() - ARENA_RADIUS)
  }

  get speedFraction(): number {
    return Math.max(0, Math.min(1, this.speed / this.spec.maxSpeed))
  }

  /** 0..1 for the HUD quirk gauge. Meaning depends on the hull. */
  get quirkValue(): number {
    const q = this.spec.quirk
    switch (q.kind) {
      case 'heat':
        return Math.min(1, this.heat / q.max)
      case 'regen':
        return Math.min(1, this.sinceHit / q.delay)
      case 'dash':
        return 1 - Math.min(1, this.dashCooldown / q.cooldown)
    }
  }

  /** True when the gauge is a warning rather than a readiness bar. */
  get quirkAlarming(): boolean {
    return this.spec.quirk.kind === 'heat' && (this.heatLocked > 0 || this.quirkValue > 0.8)
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(LOCAL_FORWARD).applyQuaternion(this.quaternion)
  }

  /** Place a freshly spawned ship. Resets flight state but not the score. */
  spawn(position: THREE.Vector3, lookAt: THREE.Vector3): void {
    this.position.copy(position)
    const m = new THREE.Matrix4().lookAt(position, lookAt, THREE.Object3D.DEFAULT_UP)
    this.quaternion.setFromRotationMatrix(m)
    this.speed = this.spec.maxSpeed * 0.5
    this.throttle = 0.6
    this.forward(_forward)
    this.velocity.copy(_forward).multiplyScalar(this.speed)
    this.hull = this.spec.maxHull
    this.alive = true
    this.warpTimer = WARP_DURATION
    this.heat = 0
    this.heatLocked = 0
    this.dashTimer = 0
    this.dashCooldown = 0
    this.fireTimer = 0
    this.flash = 0
    this.sinceHit = 99
    this.solarExposure = 0
    this.searTimer = 0
    this.syncVisual()
  }

  /* ------------------------------------------------------------------------ */
  /* Simulation                                                               */
  /* ------------------------------------------------------------------------ */

  step(controls: Controls, dt: number, ctx: ShipContext): void {
    if (!this.alive) return

    if (this.warpTimer > 0) this.warpTimer = Math.max(0, this.warpTimer - dt)
    this.sinceHit += dt
    this.flash = Math.max(0, this.flash - dt * 3.5)
    if (this.fireTimer > 0) this.fireTimer -= dt

    this.applyRotation(controls, dt)
    this.applyThrottle(controls, dt)
    this.applyDash(controls, dt, ctx.audio)
    this.measureBoundary()
    this.integrate(dt)
    this.applyBoundary(dt)
    this.applyHazards(ctx.hazards)
    this.applySolarSear(dt)
    this.applyQuirks(controls, dt)

    if (controls.fire) this.tryFire(ctx, controls.aim, controls.spread)
  }

  private applyRotation(controls: Controls, dt: number): void {
    const turn = this.spec.turnRate * dt
    const roll = this.spec.rollRate * dt
    // Right-multiplying rotates in the body frame, which is what a stick does.
    // Signs: +Y yaws the nose left and +Z rolls left, so both are negated.
    _euler.set(controls.pitch * turn, -controls.yaw * turn, -controls.roll * roll, 'YXZ')
    _dq.setFromEuler(_euler)
    this.quaternion.multiply(_dq).normalize()
  }

  private applyThrottle(controls: Controls, dt: number): void {
    this.throttle = Math.max(0, Math.min(1, controls.throttle))
    const target = this.throttle * this.spec.maxSpeed
    const delta = target - this.speed
    const step = this.spec.accel * dt
    this.speed += Math.abs(delta) <= step ? delta : Math.sign(delta) * step
  }

  private applyDash(controls: Controls, dt: number, audio: Audio): void {
    const q = this.spec.quirk
    if (q.kind !== 'dash') return

    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt)
    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt)

    if (controls.dash && this.dashCooldown <= 0 && this.dashTimer <= 0) {
      this.dashTimer = q.duration
      this.dashCooldown = q.cooldown
      this.forward(_forward)
      this.velocity.addScaledVector(_forward, q.impulse)
      audio.dash()
    }
  }

  /** Records how far outside the patrol zone the ship is, once per step. */
  private measureBoundary(): void {
    const dist = this.position.length()
    if (dist <= ARENA_RADIUS || dist < 1e-3) {
      this.boundaryDepth = 0
      return
    }
    this.boundaryDepth = Math.min(1, (dist - ARENA_RADIUS) / (ARENA_HARD_LIMIT - ARENA_RADIUS))
    _outNormal.copy(this.position).multiplyScalar(1 / dist)
  }

  private integrate(dt: number): void {
    this.forward(_forward)
    _desired.copy(_forward).multiplyScalar(this.speed)

    if (this.boundaryDepth > 0) {
      // The flight computer refuses to thrust further out of the patrol zone.
      //
      // This has to be a veto, not a force. `velocity` chases nose × maxSpeed at
      // rate `grip`, so the engine asserts up to grip × maxSpeed of outward
      // acceleration — and it asserts the *most* exactly when velocity is zero.
      // Any purely additive counter-force therefore has a depth where the two
      // cancel and the ship hangs motionless against the wall, nose out, engine
      // roaring, going nowhere. Raising the force only moves that depth.
      // Ramped over only ~20 units so it is effectively a step: any gentler
      // ramp just relocates the equilibrium instead of removing it. Note this
      // vetoes the *radial* component only — a ship crossing the line at an
      // angle keeps its full tangential speed and skims the boundary, which is
      // why this reads as a ceiling on outward progress rather than a wall.
      const outward = _desired.dot(_outNormal)
      if (outward > 0) {
        const veto = Math.min(1, this.boundaryDepth * 40)
        _desired.addScaledVector(_outNormal, -outward * veto)
      }
    }

    // A dash would be erased instantly at normal grip, so loosen it mid-dash
    // and let the extra velocity bleed off naturally afterwards.
    const grip = this.dashTimer > 0 ? this.spec.grip * 0.12 : this.spec.grip
    this.velocity.lerp(_desired, 1 - Math.exp(-grip * dt))
    this.position.addScaledVector(this.velocity, dt)
  }

  /**
   * The inward tether, plus the hard backstop.
   *
   * With outward thrust already vetoed in `integrate`, this only has to be
   * enough to walk the ship home — it is not fighting the engine. Scaled to the
   * hull's own authority so every airframe feels the same at the same depth.
   */
  private applyBoundary(dt: number): void {
    const d = this.boundaryDepth
    if (d <= 0) return

    // The constant term matters: a pull that scales purely with depth vanishes
    // at the line, so a drifting ship converges on it asymptotically and never
    // quite crosses — leaving the warning banner lit forever a few units out.
    const authority = this.spec.grip * this.spec.maxSpeed
    this.velocity.addScaledVector(_outNormal, -authority * (0.06 + 0.5 * d + d * d) * dt)

    const dist = this.position.length()
    if (dist > ARENA_HARD_LIMIT) {
      this.position.multiplyScalar(ARENA_HARD_LIMIT / dist)
      const outward = this.velocity.dot(_outNormal)
      // Reflect rather than cancel, so touching the limit visibly kicks back.
      if (outward > 0) this.velocity.addScaledVector(_outNormal, -outward * 1.6)
    }
  }

  private applyHazards(hazards: Hazard[]): void {
    for (const hazard of hazards) {
      _toShip.subVectors(this.position, hazard.center)
      const dist = _toShip.length()
      const minDist = hazard.radius + this.radius
      if (dist >= minDist || dist < 1e-3) continue

      _normal.copy(_toShip).multiplyScalar(1 / dist)
      this.position.copy(hazard.center).addScaledVector(_normal, minDist)

      const closing = this.velocity.dot(_normal)
      if (closing < 0) {
        // Kill the inward component and bounce back a little.
        this.velocity.addScaledVector(_normal, -closing * 1.5)
        const impact = Math.abs(closing)
        this.takeDamage(Math.min(55, 4 + impact * 0.1), this.team === 'player' ? 'enemy' : 'player')
        this.onCollide?.(this, impact)
      }
    }
  }

  /**
   * Radiant damage from the star.
   *
   * Credited to the burning ship's *own* team, unlike a station scrape, which
   * is credited to the opposition. Sear damage ticks for as long as a hull
   * stays in the light, so crediting it to the player would count every tick
   * as a shot landed and quietly destroy the accuracy stat. Baiting a hostile
   * into the sun still clears it from the roster and still pays the bounty —
   * it just is not recorded as marksmanship.
   */
  private applySolarSear(dt: number): void {
    this.solarExposure = solarExposureAt(this.position)

    // A materialising ship cannot steer, so burning one is a spawn killed for
    // free rather than a pilot error.
    if (this.solarExposure <= 0 || this.warpTimer > 0) {
      this.searTimer = 0
      return
    }

    this.searTimer += dt
    if (this.searTimer < SEAR_TICK) return

    const elapsed = this.searTimer
    this.searTimer = 0
    // Squared, so the outer edge is a warning you can back out of and the
    // core is unsurvivable rather than the whole zone being uniformly bad.
    const rate = SEAR_DPS * this.solarExposure * this.solarExposure
    this.takeDamage(rate * elapsed, this.team)
  }

  private applyQuirks(controls: Controls, dt: number): void {
    const q = this.spec.quirk

    if (q.kind === 'heat') {
      if (this.heatLocked > 0) {
        this.heatLocked = Math.max(0, this.heatLocked - dt)
        // Vent faster during lockout so the penalty has a visible payoff.
        this.heat = Math.max(0, this.heat - q.coolRate * 1.6 * dt)
      } else if (!controls.fire) {
        this.heat = Math.max(0, this.heat - q.coolRate * dt)
      }
    }

    if (q.kind === 'regen' && this.sinceHit >= q.delay && this.hull < this.spec.maxHull) {
      this.hull = Math.min(this.spec.maxHull, this.hull + q.rate * dt)
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Guns                                                                     */
  /* ------------------------------------------------------------------------ */

  get canFire(): boolean {
    if (!this.alive || this.warpTimer > 0 || this.fireTimer > 0) return false
    if (this.spec.quirk.kind === 'heat' && this.heatLocked > 0) return false
    return true
  }

  /**
   * Fires if the guns are ready.
   * `aim` overrides the nose direction — the AI aims off-nose to lead a target;
   * `spreadRadians` is the AI's inaccuracy, and is zero for the player.
   */
  tryFire(ctx: ShipContext, aim: THREE.Vector3 | null, spreadRadians = 0): boolean {
    if (!this.canFire) return false

    this.forward(_forward)
    const direction = aim ? _aim.copy(aim).normalize() : _aim.copy(_forward)

    if (spreadRadians > 0) {
      // Random small-angle deflection: nudge the direction by a random vector
      // and renormalise. Accurate enough for the small angles AI aim uses.
      _jitter.set(
        (Math.random() * 2 - 1) * spreadRadians,
        (Math.random() * 2 - 1) * spreadRadians,
        (Math.random() * 2 - 1) * spreadRadians,
      )
      direction.add(_jitter).normalize()
    }

    const boltSpeed = this.spec.boltSpeed + Math.max(0, this.speed) * 0.35

    for (const local of this.visual.muzzles) {
      _muzzle.copy(local).applyQuaternion(this.quaternion).add(this.position)
      ctx.bolts.fire({
        origin: _muzzle,
        direction,
        speed: boltSpeed,
        damage: this.spec.damage,
        team: this.team,
        color: this.accent,
      })
    }

    // Carry the overshoot. `fireTimer` stops decrementing once it passes zero,
    // so the leftover is a record of how far into the frame the gun was ready —
    // throwing it away rounds every fire interval up to a whole frame. At 60Hz
    // that cost the Wasp's 0.085s interval a sixth of its rate (0.1s in
    // practice), and the error shrank on a 144Hz display, which quietly made
    // refresh rate a balance lever. Bounded by one frame, so a stalled tab
    // cannot bank shots.
    this.fireTimer = this.spec.fireInterval + Math.min(0, this.fireTimer)
    this.shotsFired++
    ctx.audio.laser(this.team)

    const q = this.spec.quirk
    if (q.kind === 'heat') {
      this.heat += q.perShot
      if (this.heat >= q.max) {
        this.heat = q.max
        this.heatLocked = q.lockout
        ctx.audio.overheat()
      }
    }

    return true
  }

  takeDamage(amount: number, from: Team): void {
    if (!this.alive || amount <= 0) return
    this.hull -= amount
    this.sinceHit = 0
    this.flash = 1
    this.onDamaged?.(this, amount, from)
    if (this.hull <= 0) {
      this.hull = 0
      this.alive = false
      this.onDeath?.(this)
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Presentation                                                             */
  /* ------------------------------------------------------------------------ */

  syncVisual(): void {
    const g = this.visual.group
    g.position.copy(this.position)
    g.quaternion.copy(this.quaternion)
    g.visible = this.alive

    // Materialise: scale up and over-drive the trim as the hull phases in.
    const warp = this.warpTimer > 0 ? 1 - this.warpTimer / WARP_DURATION : 1
    g.scale.setScalar(0.25 + warp * 0.75)

    // Phase dash hides the plates outright rather than fading them. Toggling
    // `transparent` on an opaque material mid-flight moves it between render
    // queues and sorts badly against its own edge lines; a neon skeleton reads
    // better anyway.
    const phasing = this.dashTimer > 0
    this.visual.hullMesh.visible = !phasing
    this.visual.trimMat.opacity = phasing ? 0.55 : warp < 1 ? 0.4 + warp * 0.55 : 0.95

    // Throttle drives exhaust length and brightness, with a little flicker so
    // it never looks like a static cone bolted to the tail.
    const t = this.speedFraction
    const flicker = 0.9 + Math.sin(performance.now() * 0.035 + this.position.x) * 0.1
    for (const flare of this.visual.thrusters) {
      flare.scale.set(0.6 + t * 0.5, 0.6 + t * 0.5, (0.25 + t * 1.15) * flicker)
    }
    this.visual.thrusterMat.opacity = (0.12 + t * 0.42) * (phasing ? 0.4 : 1)

    // Damage flash rides the hull emissive so it reads on every facet at once.
    // Written unconditionally: gating on `flash > 0` skips the frame it reaches
    // zero and leaves the hull permanently tinted red.
    this.visual.hullMat.emissive.copy(this.baseEmissive).lerp(this.flashEmissive, this.flash)
  }

  dispose(): void {
    disposeShipVisual(this.visual)
  }
}
