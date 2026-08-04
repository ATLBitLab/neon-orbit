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
import { ARENA_RADIUS, type Environment } from '../world/environment'
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
  /**
   * Body-frame bearing to the locked target's **lead point** — where to point
   * the nose for the shot to connect — in radians, plus range. Plain numbers
   * rather than live object references, so AI behaviour is inspectable from the
   * console and a scripted pilot can fly the game.
   */
  target: { yaw: number; pitch: number; range: number; hull: number } | null
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
    audio.setEngine(0)
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
      const controls = pilot.think(player, squadron, environment.hazards, dt)
      pilot.ship.step(controls, dt, ctx)
    }

    /* Projectiles */
    for (const hit of bolts.update(dt, boltTargets, environment.hazards)) {
      fx.spark(hit.point, hit.color, hit.target ? 16 : 8)
      if (hit.target) audio.hit()
    }

    /* Presentation */
    player.syncVisual()
    for (const pilot of pilots) pilot.ship.syncVisual()
    fx.update(dt, camera)
    chase.update(player, dt)
    audio.setEngine(player.speedFraction)

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
      player.spawn(new THREE.Vector3(0, 120, 1400), new THREE.Vector3(0, 0, -200))
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
      lockedTarget = null
      ending = false
      best = deps.bestScoreFor(shipId)
      playerControls.throttle = 0.6

      hud.setShip(spec)
      hud.show()
      hud.callout('ENGAGE', `#${spec.accent.toString(16).padStart(6, '0')}`, 1.6)
      chase.reset(player)
      audio.setEngine(0.6)

      active = true
      paused = false
    },

    update,

    pause() {
      if (!active) return
      paused = true
      input.reset()
      input.releasePointerLock()
      audio.setEngine(0)
    },

    resume() {
      if (!active) return
      paused = false
      input.reset()
      audio.setEngine(player?.speedFraction ?? 0)
    },

    snapshot() {
      if (!player) return null

      let bearing: RunSnapshot['target'] = null
      if (lockedTarget && lockedTarget.alive) {
        solveLead(lockedTarget, _lead)
        _toEnemy.subVectors(_lead, player.position)
        _inverseQuat.copy(player.quaternion).invert()
        _toEnemy.applyQuaternion(_inverseQuat)
        bearing = {
          yaw: Math.atan2(_toEnemy.x, -_toEnemy.z),
          pitch: Math.atan2(_toEnemy.y, Math.hypot(_toEnemy.x, _toEnemy.z)),
          range: lockedTarget.position.distanceTo(player.position),
          hull: lockedTarget.hullFraction,
        }
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
        target: bearing,
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
      audio.setEngine(0)
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
