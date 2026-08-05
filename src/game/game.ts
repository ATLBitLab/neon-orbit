/**
 * The dogfight.
 *
 * Owns the player ship, the enemy squadron, projectiles, effects, camera and
 * HUD for one run, and reports a `RunResult` when the run ends. The environment
 * is passed in rather than built here, because it is expensive and is shared
 * with the hangar screen behind the ship-select cards.
 *
 * Enemies arrive in a trickle rather than all at once: six hulls in your face on
 * spawn is not a fight, it is an ambush. Three at a time keeps every engagement
 * readable while still emptying the same roster.
 */

import * as THREE from 'three'
import type { Audio } from '../core/audio'
import type { Input } from '../core/input'
import type { RunResult } from '../core/scores'
import { otherShips, SHIPS, type ShipId } from '../ships/specs'
import {
  ARENA_RADIUS,
  PLAYER_SPAWN,
  PLAYER_SPAWN_LOOK,
  type Environment,
  type Hazard,
} from '../world/environment'
import { MINE_DAMAGE } from '../world/mines'
import {
  OVERDRIVE_DURATION,
  OVERDRIVE_WARN_AT,
  PICKUP_COLOR,
  REPAIR_AMOUNT,
  type PickupKind,
} from '../world/pickups'
import { EnemyPilot } from './ai'
import { createBolts, type Bolts } from './bolts'
import { createChaseCamera, type ChaseCamera } from './chase'
import { createFx, type Fx } from './fx'
import type { Hud, HudContact, HudTarget } from './hud'
import { Ship, type Controls, type ShipContext } from './ship'

/** Hulls of each non-chosen type that make up the squadron. */
const PER_ENEMY_TYPE = 3
/** How many enemies are airborne at once. */
const MAX_ACTIVE = 3
/** Seconds between warp-ins. */
const SPAWN_INTERVAL = 1.9
/** Seconds of grace before the first enemy arrives. */
const OPENING_CALM = 2.6

const THROTTLE_UP_RATE = 0.85
const THROTTLE_DOWN_RATE = 1.15
/** Hull fraction below which the HUD goes red and the alarm sounds. */
const CRITICAL_HULL = 0.25

/**
 * Distance along the gun line the crosshair represents. Far enough that the
 * reticle sits clear of the hull on screen, close enough to still be a useful
 * aim reference at normal engagement ranges.
 */
const RETICLE_RANGE = 900

/** Mine detonation colour — matches the hull, not the shooter's accent. */
const MINE_FLASH = new THREE.Color(0xff3324)

/** Collection flashes, matching each pod's own glow. */
const PICKUP_FLASH = {
  repair: new THREE.Color(PICKUP_COLOR.repair),
  overdrive: new THREE.Color(PICKUP_COLOR.overdrive),
}

const _spawnDir = new THREE.Vector3()
const _spawnPos = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _toEnemy = new THREE.Vector3()
const _reticle = new THREE.Vector3()
const _inverseQuat = new THREE.Quaternion()
const _lead = new THREE.Vector3()
const _leadNdc = new THREE.Vector3()

export type RunEnd = (result: RunResult) => void

export interface Game {
  readonly active: boolean
  readonly paused: boolean
  start(shipId: ShipId): void
  update(dt: number): void
  pause(): void
  resume(): void
  /**
   * Drop the run without reporting a result. Used by "abort" — a player who
   * quits from the pause menu has not lost, and should not have a loss written
   * into their record.
   */
  abandon(): void
  /** Switch to the next hostile. Bound to Tab / T. */
  cycleTarget(): void
  /**
   * Read-only view of the run, for debugging in the console. Exposed on
   * `window.__neon` in dev builds only.
   */
  snapshot(): RunSnapshot | null
  dispose(): void
}

export interface RunSnapshot {
  score: number
  kills: number
  shotsFired: number
  playerHull: number
  playerSpeed: number
  enemiesAirborne: number
  enemiesQueued: number
  elapsed: number
  /** How hard the star is cooking the player, 0..1. Exposed for the same
   *  reason as the bearing below: so the burn is inspectable from the console
   *  rather than only visible as a hull bar going down. */
  solarExposure: number
  /** Seconds of Overdrive left, 0 when the guns are stock. Exposed for the same
   *  reason as `solarExposure`: a scripted pilot should be able to see the buff
   *  it is flying under without inferring it from its own rate of fire. */
  overdrive: number
  /**
   * Body-frame bearing to the locked target's **lead point** — where to point
   * the nose for the shot to connect — in radians, plus range. Plain numbers
   * rather than live object references, so AI behaviour is inspectable from the
   * console and a scripted pilot can fly the game.
   */
  target: { yaw: number; pitch: number; range: number; hull: number } | null
  /**
   * The same bearing to the nearest armed pod of each kind. Here for the same
   * reason as `target`: a scripted pilot that cannot see where the pods are
   * cannot fly to one, which leaves the whole feature untestable outside a
   * human's hands. Split by kind rather than one nearest-overall, because the
   * two are worth different detours and "where is my next heal" is a different
   * question from "where is my next gun buff".
   */
  pickups: Record<PickupKind, { yaw: number; pitch: number; range: number } | null>
}

export interface GameDeps {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  environment: Environment
  input: Input
  audio: Audio
  hud: Hud
  bestScoreFor(ship: ShipId): number
  onEnd: RunEnd
}

export function createGame(deps: GameDeps): Game {
  const { scene, camera, environment, input, audio, hud } = deps

  const bolts: Bolts = createBolts()
  const fx: Fx = createFx()
  scene.add(bolts.mesh, fx.group)

  const chase: ChaseCamera = createChaseCamera(camera)

  const ctx: ShipContext = { hazards: environment.hazards, audio, bolts }

  let player: Ship | null = null
  let pilots: EnemyPilot[] = []
  let queue: ShipId[] = []
  let spawnTimer = 0

  let active = false
  let paused = false
  let elapsed = 0
  let score = 0
  let kills = 0
  let multiplier = 1
  let playerHits = 0
  let best = 0
  let alarmTimer = 0
  let searAlarmTimer = 0
  /** Whether the player was in the star's light last frame, so the callout
   *  fires on entry instead of every frame. */
  let wasSearing = false
  /** Set once Overdrive crosses the warning threshold, so the callout and the
   *  chirp fire on the crossing rather than every frame of the countdown. */
  let overdriveWarned = false
  /** The hostile the player is holding. Damage only becomes kills with a lock. */
  let lockedTarget: Ship | null = null
  /** Set on the frame the run resolves, so the loop stops before reporting. */
  let ending = false

  const playerControls: Controls = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0.6,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
  }

  const contactBuffer: HudContact[] = []
  /** Enemy-only view of the roster, reused each frame for AI separation. */
  const squadron: Ship[] = []
  /**
   * What the AI steers around: solid stations plus every live mine. Rebuilt only
   * when a mine detonates, not per frame.
   */
  let avoidList: Hazard[] = []
  /** Every ship, rebuilt only when the roster changes. */
  let boltTargets: Ship[] = []

  function refreshTargets() {
    boltTargets = player ? [player, ...pilots.map((p) => p.ship)] : pilots.map((p) => p.ship)
  }

  /* ------------------------------------------------------------------------ */
  /* Squadron                                                                 */
  /* ------------------------------------------------------------------------ */

  function shuffled<T>(items: T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  function pickSpawnPoint(out: THREE.Vector3): THREE.Vector3 {
    if (!player) return out.set(0, 0, 0)

    for (let attempt = 0; attempt < 12; attempt++) {
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.max(0, 1 - u * u))
      _spawnDir.set(r * Math.cos(theta), u, r * Math.sin(theta))

      out.copy(player.position).addScaledVector(_spawnDir, 900 + Math.random() * 420)

      // Keep arrivals inside the arena and out of the middle of a station.
      const dist = out.length()
      if (dist > ARENA_RADIUS * 0.88) out.multiplyScalar((ARENA_RADIUS * 0.88) / dist)

      let clear = true
      for (const hazard of environment.hazards) {
        if (out.distanceTo(hazard.center) < hazard.radius + 220) {
          clear = false
          break
        }
      }
      // Also clear of mines: a hostile that materialises inside one would eat
      // 45 damage the instant its warp-in immunity expired.
      if (clear && environment.minefield.findContact(out, 140)) clear = false
      if (clear) return out
    }
    return out
  }

  function spawnEnemy(): void {
    const id = queue.shift()
    if (!id || !player) return

    const ship = new Ship(SHIPS[id], 'enemy')
    pickSpawnPoint(_spawnPos)
    ship.spawn(_spawnPos, player.position)

    ship.onDamaged = (_self, amount, from) => {
      if (from !== 'player') return
      playerHits++
      score += Math.round(amount)
    }

    ship.onDeath = (self) => {
      kills++
      multiplier = Math.min(3, 1 + kills * 0.25)
      score += Math.round(self.spec.bounty * multiplier)
      fx.explode(self.position, self.accent, self.spec.id === 'drone' ? 1.5 : 1.1)
      audio.explosion(self.spec.id === 'drone')
      chase.shake(player && self.position.distanceTo(player.position) < 420 ? 0.8 : 0.25)
      hud.feed(`${self.spec.name.toUpperCase()} DOWN  +${Math.round(self.spec.bounty * multiplier)}`)
      hud.callout('TARGET DESTROYED', `#${self.spec.accent.toString(16).padStart(6, '0')}`, 1.1)
    }

    scene.add(ship.visual.group)
    pilots.push(new EnemyPilot(ship))
    refreshTargets()

    fx.warpIn(ship.position, ship.accent)
    audio.warp()
  }

  function retireDead(): void {
    let removed = false
    for (let i = pilots.length - 1; i >= 0; i--) {
      const ship = pilots[i].ship
      if (ship.alive) continue
      scene.remove(ship.visual.group)
      ship.dispose()
      pilots.splice(i, 1)
      removed = true
    }
    if (removed) refreshTargets()
  }

  /* ------------------------------------------------------------------------ */
  /* Player input                                                             */
  /* ------------------------------------------------------------------------ */

  function readPlayerControls(dt: number): Controls {
    const s = input.state
    const c = playerControls

    if (s.throttleUp) c.throttle = Math.min(1, c.throttle + THROTTLE_UP_RATE * dt)
    if (s.throttleDown) c.throttle = Math.max(0, c.throttle - THROTTLE_DOWN_RATE * dt)

    c.pitch = s.pitch
    c.yaw = s.yaw
    c.roll = s.roll
    c.fire = s.fire
    c.dash = s.dash
    return c
  }

  /* ------------------------------------------------------------------------ */
  /* Mines                                                                    */
  /* ------------------------------------------------------------------------ */

  function rebuildAvoidList(): void {
    avoidList = environment.hazards.concat(environment.minefield.avoidance)
  }

  /**
   * Mines hurt whoever touches them, player and AI alike. Enemies steering into
   * one is a legitimate way to lose a hostile — it still counts as a kill, since
   * the pressure that forced the mistake was yours.
   */
  function resolveMines(): void {
    const field = environment.minefield

    for (const target of boltTargets) {
      if (!target.alive || target.warpTimer > 0) continue
      const mine = field.findContact(target.position, target.radius)
      if (!mine) continue

      field.detonate(mine)
      rebuildAvoidList()

      fx.explode(mine.position, MINE_FLASH, 1.6)
      audio.explosion(true)

      if (player) {
        const distance = mine.position.distanceTo(player.position)
        chase.shake(distance < 600 ? 2.6 : 0.4)
      }
      if (target === player) hud.callout('MINE', '#ff3b4e', 1.2)

      target.takeDamage(MINE_DAMAGE, target === player ? 'enemy' : 'player')
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Power-up pods                                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * The counterpart to `resolveMines`, with one deliberate difference: only the
   * player's hull is offered. Hostiles fly straight through pods. The reasoning
   * lives in `world/pickups.ts`; the short version is that nothing steers toward
   * a pod, so an AI collecting one would be a coin flip that quadrupled its
   * damage with no tell.
   *
   * Checked after everyone has moved, like mines, so contact resolves against
   * final positions rather than a stale frame.
   */
  function resolvePickups(): void {
    if (!player || !player.alive || player.warpTimer > 0) return

    const field = environment.pickups
    const pod = field.findContact(player.position, player.radius)
    if (!pod) return

    if (pod.kind === 'repair') {
      const healed = player.repair(REPAIR_AMOUNT)
      // Nothing to repair: leave the pad armed rather than burning it on a full
      // hull. Flying over spare parts you do not need should cost you nothing.
      if (healed <= 0) return
      hud.feed(`HULL +${Math.round(healed)}`)
      hud.callout('HULL REPAIRED', PICKUP_COLOR.repair, 0.9)
    } else {
      player.engageOverdrive(OVERDRIVE_DURATION)
      overdriveWarned = false
      hud.feed('OVERDRIVE ENGAGED')
      hud.callout('OVERDRIVE', PICKUP_COLOR.overdrive, 1.2)
    }

    field.collect(pod)
    fx.collect(pod.position, PICKUP_FLASH[pod.kind])
    audio.pickup(pod.kind === 'overdrive')
  }

  /* ------------------------------------------------------------------------ */
  /* Targeting                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Without a lock you cannot concentrate fire. Enemies break off constantly and
   * a Drone repairs itself, so chip damage spread across three hulls simply
   * heals — a scripted pilot chasing whatever was nearest managed 30% accuracy
   * and zero kills. Holding one target is what turns hits into kills.
   */
  function acquireTarget(): void {
    if (!player) return
    if (lockedTarget && (!lockedTarget.alive || !pilots.some((p) => p.ship === lockedTarget))) {
      lockedTarget = null
    }
    if (lockedTarget) return

    // Prefer whatever is closest to the nose, falling back to closest by range.
    player.forward(_forward)
    let best: Ship | null = null
    let bestScore = -Infinity
    for (const pilot of pilots) {
      const enemy = pilot.ship
      if (!enemy.alive) continue
      _toEnemy.subVectors(enemy.position, player.position)
      const dist = _toEnemy.length()
      if (dist < 1e-3) continue
      const alignment = _forward.dot(_toEnemy) / dist
      const score = alignment * 2 - dist / 4000
      if (score > bestScore) {
        bestScore = score
        best = enemy
      }
    }
    lockedTarget = best
  }

  /**
   * Where to aim so a bolt meets the target. One Newton step on
   * `|target + v·t − self| = boltSpeed·t` is plenty at these ranges.
   */
  function solveLead(target: Ship, out: THREE.Vector3): void {
    if (!player) return
    const boltSpeed = player.spec.boltSpeed + Math.max(0, player.speed) * 0.35
    let t = target.position.distanceTo(player.position) / boltSpeed
    for (let i = 0; i < 2; i++) {
      out.copy(target.position).addScaledVector(target.velocity, t)
      t = out.distanceTo(player.position) / boltSpeed
    }
    out.copy(target.position).addScaledVector(target.velocity, t)
  }

  /** True when the nose is close enough to the lead point for the shot to land. */
  function onTarget(): boolean {
    if (!player || !lockedTarget || !lockedTarget.targetable) return false
    solveLead(lockedTarget, _lead)
    _toEnemy.subVectors(_lead, player.position)
    const dist = _toEnemy.length()
    if (dist > 1600 || dist < 1e-3) return false
    player.forward(_forward)
    // The angle the hull subtends, plus a little slack for the reticle to feel
    // responsive rather than binary.
    const gate = Math.atan2(lockedTarget.radius * 2.2, dist)
    return _forward.dot(_toEnemy.multiplyScalar(1 / dist)) > Math.cos(gate)
  }

  /* ------------------------------------------------------------------------ */
  /* Lifecycle                                                                */
  /* ------------------------------------------------------------------------ */

  function clearArena(): void {
    for (const pilot of pilots) {
      scene.remove(pilot.ship.visual.group)
      pilot.ship.dispose()
    }
    pilots = []
    lockedTarget = null
    if (player) {
      scene.remove(player.visual.group)
      player.dispose()
      player = null
    }
    bolts.clear()
    fx.clear()
    boltTargets = []
    contactBuffer.length = 0
  }

  function finish(won: boolean): void {
    if (!active) return
    active = false
    ending = false

    const shipId = player?.spec.id ?? 'hornet'
    const shotsFired = player?.shotsFired ?? 0

    if (won) {
      // Reward finishing intact and finishing fast, in that order.
      const hullBonus = Math.round((player?.hullFraction ?? 0) * 1200)
      const timeBonus = Math.max(0, Math.round(4000 - elapsed * 25))
      score += hullBonus + timeBonus
      hud.callout('SECTOR CLEAR', '#b6ff3d', 3)
    } else {
      hud.callout('HULL BREACH', '#ff3b4e', 3)
    }

    audio.fanfare(won)
    input.releasePointerLock()
    hud.hide()

    const result: RunResult = {
      ship: shipId,
      score,
      kills,
      time: elapsed,
      won,
      accuracy: shotsFired > 0 ? Math.min(1, playerHits / shotsFired) : 0,
    }

    clearArena()
    deps.onEnd(result)
  }

  /* ------------------------------------------------------------------------ */
  /* Frame                                                                    */
  /* ------------------------------------------------------------------------ */

  function update(dt: number): void {
    environment.update(dt)

    if (!active || paused || !player) {
      fx.update(dt, camera)
      hud.tick(dt)
      return
    }

    elapsed += dt

    /* Spawning */
    if (spawnTimer > 0) spawnTimer -= dt
    while (pilots.length < MAX_ACTIVE && queue.length > 0 && spawnTimer <= 0) {
      spawnEnemy()
      spawnTimer = SPAWN_INTERVAL
    }

    /* Player */
    player.step(readPlayerControls(dt), dt, ctx)

    /* Enemies. Each pilot thinks and immediately steps, so `controls.aim` is
       consumed before the next pilot's turn. */
    squadron.length = 0
    for (const pilot of pilots) squadron.push(pilot.ship)
    for (const pilot of pilots) {
      const controls = pilot.think(player, squadron, avoidList, dt)
      pilot.ship.step(controls, dt, ctx)
    }

    /* Projectiles */
    for (const hit of bolts.update(dt, boltTargets, environment.hazards)) {
      fx.spark(hit.point, hit.color, hit.target ? 16 : 8)
      if (hit.target) audio.hit()
    }

    /* Mines. Checked after everyone has moved, so contact is resolved against
       final positions rather than a stale frame. */
    resolveMines()
    resolvePickups()

    /* Presentation */
    player.syncVisual()
    for (const pilot of pilots) pilot.ship.syncVisual()
    fx.update(dt, camera)
    chase.update(player, dt)

    /* HUD */
    contactBuffer.length = 0
    for (const pilot of pilots) {
      const enemy = pilot.ship
      if (!enemy.alive) continue
      contactBuffer.push({
        position: enemy.position,
        hullFraction: enemy.hullFraction,
        accent: enemy.spec.accent,
      })
    }

    acquireTarget()

    const remaining = queue.length + contactBuffer.length
    const critical = player.hullFraction <= CRITICAL_HULL

    // Project the gun line so the crosshair marks where shots actually go.
    player.forward(_forward)
    _reticle.copy(player.position).addScaledVector(_forward, RETICLE_RANGE).project(camera)

    function targetReadout(): HudTarget | null {
      if (!player || !lockedTarget || !lockedTarget.alive) return null
      solveLead(lockedTarget, _lead)
      _leadNdc.copy(_lead).project(camera)
      return {
        name: lockedTarget.spec.name.toUpperCase(),
        accent: lockedTarget.spec.accent,
        hullFraction: lockedTarget.hullFraction,
        range: lockedTarget.position.distanceTo(player.position),
        leadNdcX: _leadNdc.x,
        leadNdcY: _leadNdc.y,
        leadVisible: _leadNdc.z < 1 && Math.abs(_leadNdc.x) < 1 && Math.abs(_leadNdc.y) < 1,
      }
    }

    hud.update({
      hullFraction: player.hullFraction,
      quirkValue: player.quirkValue,
      quirkAlarming: player.quirkAlarming,
      score,
      multiplier,
      best,
      enemiesTotal: PER_ENEMY_TYPE * 2,
      enemiesRemaining: remaining,
      speed: player.velocity.length(),
      throttle: playerControls.throttle,
      locked: onTarget(),
      critical,
      reticleNdcX: _reticle.x,
      reticleNdcY: _reticle.y,
      boundaryOvershoot: player.boundaryOvershoot,
      solarExposure: player.solarExposure,
      overdrive: player.overdriven
        ? {
            remaining: player.overdriveTimer,
            fraction: player.overdriveTimer / OVERDRIVE_DURATION,
            expiring: player.overdriveTimer <= OVERDRIVE_WARN_AT,
          }
        : null,
      target: targetReadout(),
    })
    hud.updateContacts(contactBuffer, camera)
    hud.tick(dt)
    hud.setLockPrompt(!input.pointerLocked)

    if (critical) {
      alarmTimer -= dt
      if (alarmTimer <= 0) {
        audio.alarm()
        alarmTimer = 1.4
      }
    }

    /* Solar proximity. The alarm tightens as the hull heats, so the interval
       itself tells you whether you are getting out or getting worse. */
    const exposure = player.solarExposure
    if (exposure > 0) {
      if (!wasSearing) hud.callout('SOLAR PROXIMITY', '#ffb020', 1.2)
      searAlarmTimer -= dt
      if (searAlarmTimer <= 0) {
        audio.alarm()
        searAlarmTimer = 1.3 - exposure * 0.95
      }
    } else {
      searAlarmTimer = 0
    }
    wasSearing = exposure > 0

    /* Overdrive running out. One chirp on the crossing and nothing after — an
       alarm every frame of the last ten seconds would train the player to
       ignore the alarm that means a low hull.
       No callout to go with it: the banner appearing, the gauge turning amber
       and starting to flash, and this chirp are already three signals, and a
       fourth saying the same words landed on top of the banner it was
       announcing. The banner arriving *is* the announcement. */
    if (player.overdriven && player.overdriveTimer <= OVERDRIVE_WARN_AT && !overdriveWarned) {
      overdriveWarned = true
      audio.alarm()
    }

    retireDead()

    /* Resolution */
    if (!ending) {
      if (!player.alive) {
        ending = true
        fx.explode(player.position, player.accent, 2)
        audio.explosion(true)
        chase.shake(3)
        finish(false)
      } else if (queue.length === 0 && pilots.length === 0) {
        ending = true
        finish(true)
      }
    }
  }

  return {
    get active() {
      return active
    },
    get paused() {
      return paused
    },

    start(shipId) {
      clearArena()

      const spec = SHIPS[shipId]
      player = new Ship(spec, 'player')
      player.spawn(PLAYER_SPAWN, PLAYER_SPAWN_LOOK)
      player.onDamaged = (_self, amount) => {
        hud.flashDamage()
        audio.hullHit()
        chase.shake(Math.min(1.6, 0.25 + amount * 0.02))
      }
      player.onCollide = (_self, speed) => {
        hud.callout('HULL SCRAPE', '#ffb020', 0.8)
        chase.shake(Math.min(2.4, speed * 0.006))
      }
      scene.add(player.visual.group)

      const roster: ShipId[] = []
      for (const id of otherShips(shipId)) {
        for (let i = 0; i < PER_ENEMY_TYPE; i++) roster.push(id)
      }
      queue = shuffled(roster)
      pilots = []
      refreshTargets()

      spawnTimer = OPENING_CALM
      elapsed = 0
      score = 0
      kills = 0
      multiplier = 1
      playerHits = 0
      alarmTimer = 0
      searAlarmTimer = 0
      wasSearing = false
      overdriveWarned = false
      lockedTarget = null
      ending = false
      best = deps.bestScoreFor(shipId)
      playerControls.throttle = 0.6

      environment.minefield.reset()
      environment.pickups.reset()
      rebuildAvoidList()

      hud.setShip(spec)
      hud.show()
      hud.callout('ENGAGE', `#${spec.accent.toString(16).padStart(6, '0')}`, 1.6)
      chase.reset(player)

      active = true
      paused = false
    },

    update,

    pause() {
      if (!active) return
      paused = true
      input.reset()
      input.releasePointerLock()
    },

    resume() {
      if (!active) return
      paused = false
      input.reset()
    },

    snapshot() {
      if (!player) return null

      /** World point → yaw/pitch in the player's own frame. */
      function bearingTo(point: THREE.Vector3): { yaw: number; pitch: number } {
        _toEnemy.subVectors(point, player!.position)
        _inverseQuat.copy(player!.quaternion).invert()
        _toEnemy.applyQuaternion(_inverseQuat)
        return {
          yaw: Math.atan2(_toEnemy.x, -_toEnemy.z),
          pitch: Math.atan2(_toEnemy.y, Math.hypot(_toEnemy.x, _toEnemy.z)),
        }
      }

      let bearing: RunSnapshot['target'] = null
      if (lockedTarget && lockedTarget.alive) {
        solveLead(lockedTarget, _lead)
        bearing = {
          ...bearingTo(_lead),
          range: lockedTarget.position.distanceTo(player.position),
          hull: lockedTarget.hullFraction,
        }
      }

      const nearestPods: RunSnapshot['pickups'] = { repair: null, overdrive: null }
      for (const pod of environment.pickups.pods) {
        if (!pod.live) continue
        const range = pod.position.distanceTo(player.position)
        const held = nearestPods[pod.kind]
        if (held && held.range <= range) continue
        nearestPods[pod.kind] = { ...bearingTo(pod.position), range }
      }

      return {
        score,
        kills,
        shotsFired: player.shotsFired,
        playerHull: player.hull,
        playerSpeed: player.velocity.length(),
        enemiesAirborne: pilots.length,
        enemiesQueued: queue.length,
        elapsed,
        solarExposure: player.solarExposure,
        overdrive: player.overdriveTimer,
        target: bearing,
        pickups: nearestPods,
      }
    },

    cycleTarget() {
      const live = pilots.map((p) => p.ship).filter((s) => s.alive)
      if (live.length === 0) {
        lockedTarget = null
        return
      }
      const index = lockedTarget ? live.indexOf(lockedTarget) : -1
      lockedTarget = live[(index + 1) % live.length]
    },

    abandon() {
      active = false
      paused = false
      ending = false
      input.releasePointerLock()
      hud.hide()
      clearArena()
    },

    dispose() {
      clearArena()
      scene.remove(bolts.mesh, fx.group)
      bolts.dispose()
      fx.dispose()
    },
  }
}
