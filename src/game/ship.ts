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
import { unseededRng, type Rng } from '../core/rng'
import { buildShip, disposeShipVisual, type ShipVisual } from '../ships/meshes'
import type { ShipSpec } from '../ships/specs'
import {
  ARENA_HARD_LIMIT,
  ARENA_RADIUS,
  solarExposure as solarExposureAt,
  type Hazard,
} from '../world/environment'
import { OVERDRIVE_RATE_MULT } from '../world/pickups'
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

  /**
   * The transform as it was at the start of the current simulation step.
   *
   * The sim advances in fixed 1/60 ticks while the display refreshes at
   * whatever rate it likes, so a render almost never lands on a tick boundary.
   * `syncVisual` blends these toward the live transform to place the hull where
   * it was *between* the two ticks either side of the frame. Without it a
   * 144 Hz display would show the same pose two frames running and a 30 Hz one
   * would skip a pose entirely — both read as judder on a ship crossing the
   * screen at several hundred units a second.
   */
  readonly prevPosition = new THREE.Vector3()
  readonly prevQuaternion = new THREE.Quaternion()

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

  /**
   * Seconds of Overdrive remaining; zero when the guns are running stock.
   *
   * Lives on `Ship` rather than on the player specifically because everything
   * else about the guns already does, and a buff that only existed on one of
   * two ship classes would be the first thing in this file to make the player
   * and an AI structurally different. Nothing sets it on an enemy today — see
   * the note in `world/pickups.ts` — but the flight model does not need to know
   * that.
   */
  overdriveTimer = 0

  /** Seconds of Shield remaining. While this is up, damage is refused. */
  shieldTimer = 0

  /** 0 inside the patrol zone, 1 at the hard limit. Refreshed once per step. */
  private boundaryDepth = 0

  /** 0 clear of the star, 1 at the full burn rate. Refreshed once per step. */
  solarExposure = 0
  /** Seconds of burn banked since the last sear tick. */
  private searTimer = 0

  onDeath?: (ship: Ship) => void
  onDamaged?: (ship: Ship, amount: number, from: Team) => void
  /** Fired instead of `onDamaged` when a Shield ate the hit. */
  onShielded?: (ship: Ship, amount: number) => void
  /** Fired when the hull scrapes a station. */
  onCollide?: (ship: Ship, speed: number) => void

  private readonly baseEmissive: THREE.Color
  private readonly flashEmissive = new THREE.Color(0xff5566)

  /**
   * Gun spread draws from here rather than `Math.random`, so a run replays.
   * Defaults to an unseeded stream for bare ships built by a test or a harness;
   * `createGame` always passes a substream of the run seed.
   */
  private readonly rng: Rng

  constructor(spec: ShipSpec, team: Team, rng: Rng = unseededRng()) {
    this.spec = spec
    this.team = team
    this.rng = rng
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

  get overdriven(): boolean {
    return this.overdriveTimer > 0
  }

  get shielded(): boolean {
    return this.shieldTimer > 0
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
    this.overdriveTimer = 0
    this.shieldTimer = 0
    // Collapse the interpolation window onto the spawn pose. Leaving the
    // previous transform behind would drag the hull in from wherever it last
    // died over the first tick of its new life.
    this.prevPosition.copy(this.position)
    this.prevQuaternion.copy(this.quaternion)
    this.syncVisual()
  }

  /* ------------------------------------------------------------------------ */
  /* Power-ups                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Restore hull, capped at the airframe's maximum. Returns what was actually
   * taken, so the caller can leave a pod armed rather than burning it on a hull
   * that had nothing to repair.
   *
   * Deliberately does not touch `sinceHit`. That field is the Drone's repair
   * timer, and letting a pod reset it would mean collecting one *delays* nanite
   * repair — a heal that switches your healing off.
   */
  repair(amount: number): number {
    if (!this.alive || amount <= 0) return 0
    const before = this.hull
    this.hull = Math.min(this.spec.maxHull, this.hull + amount)
    return this.hull - before
  }

  /**
   * Grant Overdrive. Pods **stack** — two collected back to back buy twenty
   * seconds, not ten.
   *
   * Stacking duration is safe in a way stacking magnitude is not. The effect is
   * a fixed 2x rate whether you are holding one pod or four, so the ceiling
   * never moves and the balance harness only has one number to check; all a
   * second pod buys is more time at that same ceiling. Deliberately uncapped:
   * there are four pads on a 30-second respawn, so the real limit is how much
   * of the arena you are willing to cross instead of fighting.
   */
  engageOverdrive(seconds: number): void {
    this.overdriveTimer += seconds
  }

  /** Grant Shield. Stacks the same way, and for the same reason. */
  engageShield(seconds: number): void {
    this.shieldTimer += seconds
  }

  /* ------------------------------------------------------------------------ */
  /* Simulation                                                               */
  /* ------------------------------------------------------------------------ */

  step(controls: Controls, dt: number, ctx: ShipContext): void {
    if (!this.alive) return

    // Taken before anything moves: this is the pose the next render interpolates
    // away from.
    this.prevPosition.copy(this.position)
    this.prevQuaternion.copy(this.quaternion)

    if (this.warpTimer > 0) this.warpTimer = Math.max(0, this.warpTimer - dt)
    this.sinceHit += dt
    this.flash = Math.max(0, this.flash - dt * 3.5)
    if (this.fireTimer > 0) this.fireTimer -= dt
    if (this.overdriveTimer > 0) this.overdriveTimer = Math.max(0, this.overdriveTimer - dt)
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt)

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

    /*
     * Deflection is clamped here rather than trusted from the producer.
     *
     * Every producer today already stays in range — the AI clamps in
     * `ai.ts`, the device clamps in `input.ts`, and roll there is built from
     * two keys so it can only be -1, 0 or 1 — so this changes no run that
     * exists. It is not redundant, it is a relocation: the bound moves from
     * "every caller is well behaved" to "the airframe cannot be asked to
     * exceed itself", and `Controls` is now the shape a stranger's browser
     * will send. Unclamped, a `pitch` of 1000 is a thousand times the turn
     * rate the whole three-airframe balance rests on.
     *
     * Value bounds belong here because they are free and inert. *Rate* bounds
     * do not: throttle's ramp is a device-side integration the AI legitimately
     * bypasses, so enforcing it host-side is a real behaviour decision and
     * lives with the rest of input validation. See `PLANS/NEON_ORBIT_PHASE_B.md`.
     */
    const pitch = clamp(controls.pitch, -1, 1)
    const yaw = clamp(controls.yaw, -1, 1)
    const bank = clamp(controls.roll, -1, 1)

    // Right-multiplying rotates in the body frame, which is what a stick does.
    // Signs: +Y yaws the nose left and +Z rolls left, so both are negated.
    _euler.set(pitch * turn, -yaw * turn, -bank * roll, 'YXZ')
    _dq.setFromEuler(_euler)
    this.quaternion.multiply(_dq).normalize()
  }

  private applyThrottle(controls: Controls, dt: number): void {
    // Same guard as deflection, and for the same reason: a `NaN` throttle
    // reaches `speed`, and `speed` reaches `position`, which never comes back.
    // Zero is the safe reading of "not a number" — the ship coasts down rather
    // than inheriting a command nobody sent.
    this.throttle = clamp(controls.throttle, 0, 1)
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
        this.rng.spread(spreadRadians),
        this.rng.spread(spreadRadians),
        this.rng.spread(spreadRadians),
      )
      direction.add(_jitter).normalize()
    }

    const boltSpeed = this.spec.boltSpeed + Math.max(0, this.speed) * 0.35

    // Note what is *not* here: Overdrive does not touch `spec.damage`. Every
    // bolt in the game carries the damage its airframe's spec sheet says it
    // does, boosted or not, which is what keeps alpha strike — and therefore
    // every one-volley-kill threshold the balance harness pins — invariant.
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
    const interval = this.overdriven
      ? this.spec.fireInterval / OVERDRIVE_RATE_MULT
      : this.spec.fireInterval
    this.fireTimer = interval + Math.min(0, this.fireTimer)
    this.shotsFired++
    ctx.audio.laser(this.team)

    // Heat is charged per shot and Overdrive does not discount it, so a boosted
    // heat gun banks heat twice as fast and reaches the lockout in half the
    // time. That is left alone rather than compensated for: it self-balances the
    // buff, handing the Wasp roughly 1.6x sustained damage where the two guns
    // without a heat quirk get the full 2x. The airframe that already fires
    // fastest gains least from firing faster still, which is the same argument
    // the quirk makes everywhere else. `scripts/balance.ts` measures both.
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

    /**
     * A held Shield refuses the damage outright — bolts, mines, station
     * scrapes, the star, all of it.
     *
     * Three things deliberately do *not* happen here. `sinceHit` is not reset,
     * because nothing reached the hull and a shielded Drone should keep
     * repairing. `onDamaged` does not fire, because that callback is what
     * credits a hit to the shooter, and a bolt that accomplished nothing is not
     * a hit landed — letting it through would inflate the accuracy stat exactly
     * the way sear damage used to. And the ship stays `targetable`, so bolts
     * still arrive and splash rather than passing through: a shield you cannot
     * see working is a shield the player will not believe in.
     */
    if (this.shieldTimer > 0) {
      this.onShielded?.(this, amount)
      return
    }

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

  /**
   * Push simulation state onto the meshes.
   *
   * `alpha` is how far the frame being drawn sits between the previous
   * simulation tick and the current one, 0..1. Only the transform is
   * interpolated; everything else here is either a threshold (visible, phasing,
   * shielded) or already a smooth function of a timer, and blending those would
   * buy nothing for the arithmetic.
   *
   * Nothing in here may write simulation state. This is the whole render half
   * of the boundary — `step` decides where the ship is, `syncVisual` decides
   * what that looks like, and a headless run calls only the former.
   */
  syncVisual(alpha = 1): void {
    const g = this.visual.group
    if (alpha >= 1) {
      g.position.copy(this.position)
      g.quaternion.copy(this.quaternion)
    } else {
      g.position.lerpVectors(this.prevPosition, this.position, alpha)
      g.quaternion.copy(this.prevQuaternion).slerp(this.quaternion, alpha)
    }
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
    // Overdrive rides the exhaust rather than the hull. The hull emissive is
    // already the damage flash's channel, and a buff that tints the hull would
    // be competing for the same pixels as "you are being shot".
    this.visual.thrusterMat.opacity =
      (0.12 + t * 0.42) * (phasing ? 0.4 : 1) * (this.overdriveTimer > 0 ? 1.7 : 1)

    // Shield bubble. Hidden outright when down rather than faded to zero, so a
    // stock run never pays for an invisible additive shell. The pulse is fast
    // enough to read as energised, and it brightens sharply over the last two
    // seconds — a second channel saying the same thing as the HUD countdown,
    // for a pilot whose eyes are on the reticle rather than the corner panel.
    const shielding = this.shieldTimer > 0
    this.visual.shieldMesh.visible = shielding
    if (shielding) {
      const pulse = 0.5 + Math.sin(performance.now() * 0.006) * 0.5
      const urgency = this.shieldTimer < 2 ? 1 - this.shieldTimer / 2 : 0
      this.visual.shieldMat.opacity = 0.22 + pulse * 0.12 + urgency * 0.3
      this.visual.shieldMesh.rotation.y += 0.004
    }

    // Damage flash rides the hull emissive so it reads on every facet at once.
    // Written unconditionally: gating on `flash > 0` skips the frame it reaches
    // zero and leaves the hull permanently tinted red.
    this.visual.hullMat.emissive.copy(this.baseEmissive).lerp(this.flashEmissive, this.flash)
  }

  dispose(): void {
    disposeShipVisual(this.visual)
  }
}

/**
 * Bound a commanded value, and reject one that is not a number at all.
 *
 * The finite check is not defensive padding — it is the more important half.
 * An out-of-range deflection is a *cheat*: visible, bounded, and correctable,
 * because clamping it produces a legal ship. `NaN` is not a cheat, it is
 * destruction. It propagates through the quaternion into the position, and
 * every later integration keeps it there: five honest ticks after a single
 * poisoned one, the hull is still at `NaN` and the participant is gone from the
 * arena for the rest of the match. There is no recovery path in the flight
 * model, and if it lands on the host's own ship there is nothing to roll back
 * to.
 *
 * `Math.max`/`Math.min` propagate `NaN` rather than clamping it, so the obvious
 * clamp does not help.
 *
 * And it does not take malice. A *missing* field reads as `undefined` and a
 * wrong type reads as a string, neither of which is a number at all. JSON
 * cannot carry `NaN`, but the binary snapshot format at milestone 4 can —
 * `new Float32Array([NaN])[0]` is `NaN` — so a truncated packet does the same
 * permanent damage a deliberate one would.
 *
 * The guard is deliberately **not** `Number.isFinite`, which is the obvious
 * spelling and is wrong here: it rejects `Infinity` too, and infinity is a
 * perfectly clampable request. "Turn as hard as you can" is a legal thing to
 * ask; the bound is the honest answer. Zeroing it instead would take a hostile
 * input that the plain clamp already handled correctly and quietly neutralise
 * it — a regression hiding inside a hardening fix.
 *
 * Inert for every producer that exists today, all of which send real numbers in
 * range.
 */
function clamp(v: number, lo: number, hi: number): number {
  // Not a number at all — missing field, wrong type, or NaN itself.
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  // Finite or infinite, the comparisons below bound it correctly.
  return v < lo ? lo : v > hi ? hi : v
}
