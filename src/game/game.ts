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
import { STREAM, subRng, type Rng } from '../core/rng'
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
  PICKUP_COLOR,
  PICKUP_KINDS,
  REPAIR_AMOUNT,
  SHIELD_DURATION,
  TIMED_WARN_AT,
  type PickupKind,
} from '../world/pickups'
import { EnemyPilot } from './ai'
import { createBolts, FACTION_AI, FACTION_PLAYER, type Bolts } from './bolts'
import { createChaseCamera, type ChaseCamera } from './chase'
import { LAUNCH_THROTTLE } from './controls'
import { createFx, type Fx } from './fx'
import type { Hud, HudContact, HudTarget } from './hud'
import { Ship, type Controls, type ShipContext } from './ship'

/**
 * Seconds of simulation per tick.
 *
 * Fixed, and owned here rather than taken from the frame, because the flight
 * model integrates per step: with a variable delta the same stick input covers
 * different ground on a 30 Hz laptop and a 144 Hz desktop, and a hull's turn
 * rate — the balance lever the whole three-airframe design rests on — stops
 * being one number. It is also the precondition for a run replaying: a replay
 * can reproduce a list of inputs, but it can never reproduce a list of frame
 * times.
 *
 * 60 Hz matches the rate the flight model was tuned at and the rate
 * `scripts/simcheck.ts` has always asserted against.
 */
export const STEP = 1 / 60

/** Hulls of each non-chosen type that make up the squadron. */
const PER_ENEMY_TYPE = 3
/** How many enemies are airborne at once. */
const MAX_ACTIVE = 3
/** Seconds between warp-ins. */
const SPAWN_INTERVAL = 1.9
/** Seconds of grace before the first enemy arrives. */
const OPENING_CALM = 2.6

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
const PICKUP_FLASH = Object.fromEntries(
  PICKUP_KINDS.map((k) => [k, new THREE.Color(PICKUP_COLOR[k])]),
) as Record<PickupKind, THREE.Color>

/* -------------------------------------------------------------------------- */
/* Death animation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How long the wreck stays on screen before the debrief takes over.
 *
 * The whole point of the split below is that a hull which vanishes the instant
 * it dies reads as a dropped frame rather than a kill. So the ship survives its
 * own death for `WRECK_TUMBLE` seconds — dead, unsteerable, tumbling and
 * venting — and only then goes up. Watching a recognisable silhouette come
 * apart is the thing; the fireball on its own is just a particle burst.
 *
 * Exported so `simcheck` asserts the real timing rather than a copy of it.
 */
export const DEATH_SEQUENCE = 2.4
/** Seconds the hull stays intact after taking the fatal hit. */
const WRECK_TUMBLE = 0.55
/** How fast the wreck sheds speed, per second. */
const WRECK_DRAG = 0.7
/** Body-frame tumble of the wreck, radians per second. */
const WRECK_PITCH = 2.4
const WRECK_YAW = 1.1
const WRECK_ROLL = 3.6
/** What the hull emissive cooks toward while the wreck burns. */
const WRECK_HOT = new THREE.Color(0xfff0d0)
/** Sparks shed by the tumbling wreck, per second. */
const WRECK_SPARK_RATE = 26

/**
 * The detonation timeline, in seconds since the fatal hit.
 *
 * `spread` jitters the blast off the wreck's centre, because bursts stacked on
 * one point read as a single brighter burst rather than a hull coming apart.
 * The big one at `WRECK_TUMBLE` is the moment the ship itself goes; the two
 * after it are cook-offs in the debris.
 */
const DEATH_BLASTS: { at: number; scale: number; spread: number; shake: number; big: boolean }[] = [
  { at: 0, scale: 0.55, spread: 10, shake: 1, big: false },
  { at: 0.26, scale: 0.7, spread: 14, shake: 1.1, big: false },
  { at: WRECK_TUMBLE, scale: 2.3, spread: 0, shake: 3.2, big: true },
  { at: 0.95, scale: 0.9, spread: 42, shake: 0.8, big: false },
  { at: 1.4, scale: 0.7, spread: 58, shake: 0.5, big: false },
]

const _spawnDir = new THREE.Vector3()
const _spawnPos = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _toEnemy = new THREE.Vector3()
const _reticle = new THREE.Vector3()
const _inverseQuat = new THREE.Quaternion()
const _lead = new THREE.Vector3()
const _leadNdc = new THREE.Vector3()
const _blast = new THREE.Vector3()
const _spin = new THREE.Euler(0, 0, 0, 'YXZ')
const _spinQuat = new THREE.Quaternion()

export type RunEnd = (result: RunResult) => void

export interface Game {
  readonly active: boolean
  readonly paused: boolean
  /**
   * True while the death animation is playing — the run has resolved, but the
   * wreck is still on screen and the debrief has not come up. Nothing may pause
   * or interrupt the game here, or the explosion freezes mid-blast.
   */
  readonly dying: boolean
  /**
   * Begin a run. `seed` fixes every gameplay draw the run makes — squadron
   * order, arrival points, AI wander, gun spread — so the same seed replayed
   * against the same inputs produces the same fight. Omitted, a fresh one is
   * rolled and reported back through `snapshot().seed`.
   */
  start(shipId: ShipId, seed?: number): void
  /**
   * Advance the simulation by exactly one fixed tick, flying the local ship on
   * `controls`.
   *
   * Deliberately takes no `dt`: a caller that could pass its own could pass a
   * large one and cover more ground per frame, which is the cheapest cheat there
   * is, and is why the loop owns the step size rather than the frame.
   *
   * It does take intent, and that is the point. The simulation is handed what a
   * pilot wants rather than reaching for a keyboard, so the same tick runs
   * identically against a device, a recorded stream, or a packet from another
   * browser. Everything phase B needs hangs off that one substitution.
   */
  step(controls: Controls): void
  /**
   * Draw the current simulation state. `alpha` is how far the frame sits
   * between the last two ticks, 0..1. Writes no simulation state, so a headless
   * run never calls it.
   */
  render(alpha: number, frameDt: number): void
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
  /**
   * The seed this run's gameplay randomness came from. Reported so a run worth
   * keeping can be replayed: feed it back to `start` with the same inputs and
   * the same fight happens.
   */
  seed: number
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
  /** Seconds of Overdrive and Shield left, 0 when neither is up. Exposed for
   *  the same reason as `solarExposure`: a scripted pilot should be able to see
   *  the buffs it is flying under rather than inferring them from its own rate
   *  of fire and a hull that stopped going down. */
  overdrive: number
  shield: number
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

  // The listener is the local player today. Milestone 3 makes this the roster's
  // local participant, at which point a client holding any faction hears its own
  // guns correctly.
  const ctx: ShipContext = {
    hazards: environment.hazards,
    audio,
    bolts,
    localFaction: FACTION_PLAYER,
  }

  let player: Ship | null = null
  let pilots: EnemyPilot[] = []
  let queue: ShipId[] = []
  let spawnTimer = 0

  /**
   * The seed this run's gameplay randomness is derived from, and the counter
   * that hands each pilot its own substream.
   *
   * Kept here rather than passed around because everything that draws is
   * created inside this closure. A caller that wants a reproducible run — a
   * replay, a server, a host peer — supplies the seed to `start` and gets the
   * same fight from the same inputs. `pilotsSpawned` only ever increases within
   * a run, so a pilot's stream is a function of its arrival order and nothing
   * else.
   */
  let runSeed = 0
  let pilotsSpawned = 0
  let spawnRng: Rng = subRng(0, STREAM.spawn)

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
  /** Set once each timed buff crosses the warning threshold, so the chirp fires
   *  on the crossing rather than every frame of the countdown. Cleared when a
   *  fresh pod pushes the clock back above the threshold. */
  let overdriveWarned = false
  let shieldWarned = false
  /** The hostile the player is holding. Damage only becomes kills with a lock. */
  let lockedTarget: Ship | null = null

  /* Death animation state. See `DEATH_SEQUENCE`. */
  let dying = false
  let deathTimer = 0
  /** Index of the next entry in `DEATH_BLASTS` still to fire. */
  let nextBlast = 0
  /** The scoreline, sealed the moment the player died. */
  let pendingResult: RunResult | null = null
  /** Hull emissive at the moment of death, cooked toward `WRECK_HOT` from there. */
  const wreckEmissive = new THREE.Color()

  /**
   * A *copy* of the controls the last tick actually flew on, so the HUD reports
   * the throttle being simulated rather than whatever a device says right now.
   * On a client those two differ by a round trip.
   *
   * Copied rather than referenced, and that is the whole point of it. `Pilot`
   * returns the same struct every call — sixty allocations a second would be
   * silly — so retaining the caller's object would make this a live view of the
   * device, which is exactly the thing it exists not to be. It was a reference
   * first, and read back as whatever the stick was doing later.
   *
   * The general rule, now that `Controls` is becoming a wire format: **`step`
   * must not retain what it is handed.** A host buffering `inputs[tick]` would
   * otherwise collect N aliases of one object and replay the last tick N times.
   */
  const lastControls: Controls = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: LAUNCH_THROTTLE,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
  }

  function recordControls(c: Controls): void {
    lastControls.pitch = c.pitch
    lastControls.yaw = c.yaw
    lastControls.roll = c.roll
    lastControls.throttle = c.throttle
    lastControls.fire = c.fire
    lastControls.dash = c.dash
    lastControls.spread = c.spread
    // `aim` is a vector the producer owns; the HUD never reads it, so the
    // reference is not copied and not kept.
    lastControls.aim = null
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
      const j = spawnRng.int(0, i)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  function pickSpawnPoint(out: THREE.Vector3): THREE.Vector3 {
    if (!player) return out.set(0, 0, 0)

    for (let attempt = 0; attempt < 12; attempt++) {
      const u = spawnRng.range(-1, 1)
      const theta = spawnRng.range(0, Math.PI * 2)
      const r = Math.sqrt(Math.max(0, 1 - u * u))
      _spawnDir.set(r * Math.cos(theta), u, r * Math.sin(theta))

      out.copy(player.position).addScaledVector(_spawnDir, spawnRng.range(900, 1320))

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

    const index = pilotsSpawned++
    const ship = new Ship(SHIPS[id], FACTION_AI, subRng(runSeed, STREAM.enemyGuns + index))
    pickSpawnPoint(_spawnPos)
    ship.spawn(_spawnPos, player.position)

    ship.onDamaged = (_self, amount, from) => {
      if (from !== FACTION_PLAYER) return
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
    pilots.push(new EnemyPilot(ship, subRng(runSeed, STREAM.pilot + index)))
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

      // Attributed to "not the victim" so a hostile chased onto a mine scores
      // for the player — documented behaviour, and the one place the arena has
      // to name a culprit it does not have. See `notMe` in `ship.ts`: this is
      // the shape that stops working once there are more than two factions.
      target.takeDamage(MINE_DAMAGE, target === player ? FACTION_AI : FACTION_PLAYER)
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
    } else if (pod.kind === 'overdrive') {
      player.engageOverdrive(OVERDRIVE_DURATION)
      // Clear the warning latch: a stacked pod has pushed the clock back above
      // the threshold, so the countdown has to be able to fire again.
      overdriveWarned = false
      // "SEC" rather than "s": the HUD uppercases everything, and in this font
      // a trailing capital S against a digit reads as another 5 — "+10s" came
      // out looking like "+105".
      hud.feed(`OVERDRIVE +${OVERDRIVE_DURATION} SEC`)
      hud.callout('OVERDRIVE', PICKUP_COLOR.overdrive, 1.2)
    } else {
      player.engageShield(SHIELD_DURATION)
      shieldWarned = false
      hud.feed(`SHIELD +${SHIELD_DURATION} SEC`)
      hud.callout('SHIELD UP', PICKUP_COLOR.shield, 1.2)
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

  /**
   * The scoreline at the instant the run resolves.
   *
   * Sealed here rather than read at `finish`, because a loss keeps the arena
   * running for `DEATH_SEQUENCE` seconds afterwards — long enough for a hostile
   * to fly into the star and post a bounty to a pilot who is already dead.
   */
  function sealResult(won: boolean): RunResult {
    const shotsFired = player?.shotsFired ?? 0

    if (won) {
      // Reward finishing intact and finishing fast, in that order.
      const hullBonus = Math.round((player?.hullFraction ?? 0) * 1200)
      const timeBonus = Math.max(0, Math.round(4000 - elapsed * 25))
      score += hullBonus + timeBonus
    }

    return {
      ship: player?.spec.id ?? 'hornet',
      score,
      kills,
      time: elapsed,
      won,
      accuracy: shotsFired > 0 ? Math.min(1, playerHits / shotsFired) : 0,
    }
  }

  function finish(result: RunResult): void {
    if (!active) return
    active = false
    dying = false
    pendingResult = null

    audio.fanfare(result.won)
    input.releasePointerLock()
    hud.hide()

    clearArena()
    deps.onEnd(result)
  }

  /* ------------------------------------------------------------------------ */
  /* Death animation                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Contact markers for whatever is still airborne.
   *
   * Reads the *drawn* transform, not the simulation one. The bracket and the
   * hull bar under it are pinned to a hostile that is itself drawn interpolated,
   * seen through a camera that is also interpolated — so a marker placed from
   * the tick pose agrees with its ship only at alpha 1 and swims around it the
   * rest of the time, by up to `|v| · STEP` — about 7.8 units at a Wasp's top
   * speed, worst exactly when relative velocity is highest and the bracket is
   * most useful.
   *
   * Callers must therefore run this *after* `syncVisual`, which both call sites
   * in `render` do. `visual.group.position` is pushed as a live reference, the
   * same way `enemy.position` was.
   */
  function refreshContacts(): void {
    contactBuffer.length = 0
    for (const pilot of pilots) {
      const enemy = pilot.ship
      if (!enemy.alive) continue
      contactBuffer.push({
        position: enemy.visual.group.position,
        hullFraction: enemy.hullFraction,
        accent: enemy.spec.accent,
        // The Drone's repair clock, read a second time. It is already exactly
        // "seconds since this hull last lost anything", which is the same
        // question the hull bar's fade asks, and a parallel timer would be a
        // second thing to remember to reset in `takeDamage`.
        sinceHit: enemy.sinceHit,
      })
    }
  }

  /**
   * Take the run out of the player's hands and hand it to the wreck.
   *
   * The result is banked immediately; everything after this is presentation.
   */
  function beginDeathSequence(): void {
    if (!player || dying) return

    dying = true
    deathTimer = 0
    nextBlast = 0
    pendingResult = sealResult(false)

    hud.callout('HULL BREACH', '#ff3b4e', 3)

    // Freeze the instruments on the moment of death: a lock pip or a live target
    // readout floating over your own wreck is a lie. The reticle keeps its last
    // projection rather than snapping to centre.
    hud.update({
      hullFraction: 0,
      quirkValue: player.quirkValue,
      quirkAlarming: false,
      score,
      multiplier,
      best,
      enemiesTotal: PER_ENEMY_TYPE * 2,
      enemiesRemaining: queue.length + pilots.length,
      speed: player.velocity.length(),
      throttle: 0,
      locked: false,
      critical: true,
      reticleNdcX: _reticle.x,
      reticleNdcY: _reticle.y,
      boundaryOvershoot: 0,
      solarExposure: 0,
      overdrive: null,
      shield: null,
      target: null,
    })

    // `syncVisual` hid the hull the frame it died. Put it back — it has a
    // tumble to perform first — and cut the engines.
    player.visual.group.visible = true
    player.visual.thrusterMat.opacity = 0
    wreckEmissive.copy(player.visual.hullMat.emissive)
  }

  /**
   * One frame of the death animation.
   *
   * The squadron keeps flying and the bolts keep travelling: freezing the arena
   * the instant the player dies reads as the game crashing rather than as a
   * kill. None of it can touch the player — `takeDamage` and `step` both bail on
   * a dead hull, and bolts skip anything untargetable — so this is safe to run
   * with a corpse in the roster.
   *
   * Runs on the fixed tick because it gates the debrief, and it is the one place
   * in the simulation half that calls `Math.random()` — for spark timing and
   * blast scatter. That is allowed here and nowhere else: `beginDeathSequence`
   * has already sealed the scoreline, so nothing this function rolls can change
   * what the run reports. It is a cutscene wearing a simulation's clothes.
   */
  function stepDeathSequence(dt: number): void {
    if (!player) return
    deathTimer += dt

    /* The wreck */
    const g = player.visual.group
    if (deathTimer < WRECK_TUMBLE) {
      // Coast on the last velocity, so the camera has something to trail rather
      // than a hull that stopped dead in space. Airspeed bleeds with it, which
      // is what walks the camera's speed FOV back down as the wreck slows.
      // Same start-of-tick snapshot `Ship.step` takes, for the same reason: the
      // chase camera interpolates the wreck's drift, and without this it would
      // blend against whatever pose the last living tick left behind.
      player.prevPosition.copy(player.position)
      player.prevQuaternion.copy(player.quaternion)

      const drag = Math.exp(-WRECK_DRAG * dt)
      player.velocity.multiplyScalar(drag)
      player.speed *= drag
      player.position.addScaledVector(player.velocity, dt)

      // Tumble the *visual* only. The chase camera sits in the ship's own frame,
      // so spinning `player.quaternion` would spin the shot instead of the hull
      // and make the last two seconds of the run unwatchable.
      //
      // This rotation is the one mesh write the simulation half is allowed, and
      // it earns the exemption by accumulating: it multiplies into whatever the
      // mesh already holds rather than being a function of `deathTimer`. Move it
      // to `render` and the tumble rate becomes frame-rate dependent, which is
      // the exact thing the fixed step exists to prevent. The wreck's *position*
      // has no such excuse — it is a plain interpolation, so `render` owns it.
      _spin.set(WRECK_PITCH * dt, WRECK_YAW * dt, WRECK_ROLL * dt)
      _spinQuat.setFromEuler(_spin)
      g.quaternion.multiply(_spinQuat).normalize()

      player.visual.hullMat.emissive
        .copy(wreckEmissive)
        .lerp(WRECK_HOT, deathTimer / WRECK_TUMBLE)

      if (Math.random() < WRECK_SPARK_RATE * dt) fx.spark(player.position, player.accent, 6)
    } else if (g.visible) {
      // The ship itself is gone. Debris and cook-offs carry the rest.
      g.visible = false
    }

    /* Detonations */
    while (nextBlast < DEATH_BLASTS.length && deathTimer >= DEATH_BLASTS[nextBlast].at) {
      const blast = DEATH_BLASTS[nextBlast++]
      _blast.copy(player.position)
      if (blast.spread > 0) {
        _blast.x += (Math.random() * 2 - 1) * blast.spread
        _blast.y += (Math.random() * 2 - 1) * blast.spread
        _blast.z += (Math.random() * 2 - 1) * blast.spread
      }
      fx.explode(_blast, player.accent, blast.scale)
      audio.explosion(blast.big)
      chase.shake(blast.shake)
    }

    /* The fight carries on around it */
    squadron.length = 0
    for (const pilot of pilots) squadron.push(pilot.ship)
    for (const pilot of pilots) {
      const controls = pilot.think(player, squadron, avoidList, dt)
      pilot.ship.step(controls, dt, ctx)
    }
    for (const hit of bolts.update(dt, boltTargets, environment.hazards)) {
      fx.spark(hit.point, hit.color, hit.target ? 16 : 8)
    }

    retireDead()

    // Falls back rather than waiting for a result that will never arrive: this
    // is the only exit from the sequence, so it must not be able to not happen.
    if (deathTimer >= DEATH_SEQUENCE) finish(pendingResult ?? sealResult(false))
  }

  /* ------------------------------------------------------------------------ */
  /* Frame                                                                    */
  /* ------------------------------------------------------------------------ */

  /* ------------------------------------------------------------------------ */
  /* Simulation                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * One fixed tick of the fight.
   *
   * Everything in here decides an outcome. Nothing in here reads the camera or
   * writes a mesh transform, which is what lets the same code run without a
   * renderer — and, later, somewhere that is not the player's browser.
   *
   * Audio and HUD callouts do fire from here, and belong here: they are driven
   * by simulation timers, so hanging them off the frame rate would make a
   * critical-hull alarm beat faster on a better monitor.
   */
  function step(controls: Controls): void {
    environment.step(STEP)

    if (dying) {
      stepDeathSequence(STEP)
      return
    }

    if (!active || paused || !player) return

    elapsed += STEP

    /* Spawning */
    if (spawnTimer > 0) spawnTimer -= STEP
    while (pilots.length < MAX_ACTIVE && queue.length > 0 && spawnTimer <= 0) {
      spawnEnemy()
      spawnTimer = SPAWN_INTERVAL
    }

    /* Player */
    recordControls(controls)
    player.step(controls, STEP, ctx)

    /* Enemies. Each pilot thinks and immediately steps, so `controls.aim` is
       consumed before the next pilot's turn. */
    squadron.length = 0
    for (const pilot of pilots) squadron.push(pilot.ship)
    for (const pilot of pilots) {
      const controls = pilot.think(player, squadron, avoidList, STEP)
      pilot.ship.step(controls, STEP, ctx)
    }

    /* Projectiles */
    for (const hit of bolts.update(STEP, boltTargets, environment.hazards)) {
      fx.spark(hit.point, hit.color, hit.target ? 16 : 8)
      if (hit.target) audio.hit()
    }

    /* Mines. Checked after everyone has moved, so contact is resolved against
       final positions rather than a stale frame. */
    resolveMines()
    resolvePickups()

    /* Target lock. Simulation rather than display: the lock decides which hull
       the lead solution is computed against, and `onTarget` gates the reticle
       the player shoots on. */
    acquireTarget()

    const critical = player.hullFraction <= CRITICAL_HULL
    if (critical) {
      alarmTimer -= STEP
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
      searAlarmTimer -= STEP
      if (searAlarmTimer <= 0) {
        audio.alarm()
        searAlarmTimer = 1.3 - exposure * 0.95
      }
    } else {
      searAlarmTimer = 0
    }
    wasSearing = exposure > 0

    /* Timed buffs running out. One chirp on each crossing and nothing after —
       an alarm every frame of the last five seconds would train the player to
       ignore the alarm that means a low hull.
       No callout to go with it: the banner appearing, the gauge turning amber
       and starting to flash, and this chirp are already three signals, and a
       fourth saying the same words landed on top of the banner it was
       announcing. The banner arriving *is* the announcement. */
    if (player.overdriven && player.overdriveTimer <= TIMED_WARN_AT && !overdriveWarned) {
      overdriveWarned = true
      audio.alarm()
    }
    if (player.shielded && player.shieldTimer <= TIMED_WARN_AT && !shieldWarned) {
      shieldWarned = true
      audio.alarm()
    }

    retireDead()

    /* Resolution. A loss hands off to the death animation and reports when it
       is done; a win reports immediately. */
    if (!player.alive) {
      beginDeathSequence()
    } else if (queue.length === 0 && pilots.length === 0) {
      hud.callout('SECTOR CLEAR', '#b6ff3d', 3)
      finish(sealResult(true))
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Presentation                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * Draw the state `step` left behind, at the frame's own rate.
   *
   * `frameDt` drives everything whose only job is to look smooth — particles,
   * camera follow, world spin — so those stay fluid on a display faster than
   * the tick rate instead of being pinned to 60.
   */
  function render(alpha: number, frameDt: number): void {
    environment.update(frameDt, camera)

    /* The death cutscene. `syncVisual` is deliberately not called for the
       player — it would overwrite the accumulated tumble with the ship's own
       unrotated quaternion — so the wreck's position is interpolated here by
       hand, at the same `alpha` as everything else in the frame.

       Skipping that is a real artefact rather than a theoretical one: the
       camera is locked to the wreck, so a wreck sitting on raw tick positions
       while the camera moves smoothly shimmers against the one thing the player
       is looking at. The instruments stay frozen where `beginDeathSequence`
       left them. */
    if (dying) {
      if (player) {
        player.visual.group.position.lerpVectors(
          player.prevPosition,
          player.position,
          alpha,
        )
        for (const pilot of pilots) pilot.ship.syncVisual(alpha)
        bolts.render(alpha)
        fx.update(frameDt, camera)
        chase.update(player, frameDt, alpha)
        refreshContacts()
        hud.updateContacts(contactBuffer, camera)
      }
      hud.tick(frameDt)
      return
    }

    /* Nothing is advancing, so nothing is worth re-posing: a varying alpha
       against a frozen simulation would swing every hull back and forth between
       the last two ticks. Leaving the meshes where the final frame drew them is
       both correct and cheaper. */
    if (!active || paused || !player) {
      fx.update(frameDt, camera)
      hud.tick(frameDt)
      return
    }

    player.syncVisual(alpha)
    for (const pilot of pilots) pilot.ship.syncVisual(alpha)
    bolts.render(alpha)

    fx.update(frameDt, camera)
    // After `syncVisual`, and at the same blend, so the camera follows the pose
    // actually on screen rather than the tick-quantized one behind it.
    chase.update(player, frameDt, alpha)

    refreshContacts()

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
      throttle: lastControls.throttle,
      locked: onTarget(),
      critical,
      reticleNdcX: _reticle.x,
      reticleNdcY: _reticle.y,
      boundaryOvershoot: player.boundaryOvershoot,
      solarExposure: player.solarExposure,
      // Both buffs stack, so the bar is clamped: past one pod's worth the
      // fraction stops meaning anything and the seconds carry the truth.
      overdrive: player.overdriven
        ? {
            remaining: player.overdriveTimer,
            fraction: Math.min(1, player.overdriveTimer / OVERDRIVE_DURATION),
            expiring: player.overdriveTimer <= TIMED_WARN_AT,
          }
        : null,
      shield: player.shielded
        ? {
            remaining: player.shieldTimer,
            fraction: Math.min(1, player.shieldTimer / SHIELD_DURATION),
            expiring: player.shieldTimer <= TIMED_WARN_AT,
          }
        : null,
      target: targetReadout(),
    })
    hud.updateContacts(contactBuffer, camera)
    hud.tick(frameDt)
    hud.setLockPrompt(!input.pointerLocked)
  }

  return {
    get active() {
      return active
    },
    get paused() {
      return paused
    },
    get dying() {
      return dying
    },

    start(shipId, seed = (Math.random() * 0xffffffff) >>> 0) {
      clearArena()

      // Every stream this run draws from hangs off the seed, and must be built
      // before anything draws — `shuffled` below is the first customer.
      runSeed = seed >>> 0
      pilotsSpawned = 0
      spawnRng = subRng(runSeed, STREAM.spawn)

      const spec = SHIPS[shipId]
      player = new Ship(spec, FACTION_PLAYER, subRng(runSeed, STREAM.playerGuns))
      player.spawn(PLAYER_SPAWN, PLAYER_SPAWN_LOOK)
      player.onDamaged = (_self, amount) => {
        hud.flashDamage()
        audio.hullHit()
        chase.shake(Math.min(1.6, 0.25 + amount * 0.02))
      }
      // A shielded hit has to feel like *something* or the player cannot tell
      // the shield from a lull in enemy fire. Deliberately a much smaller nudge
      // than a hull hit, and no red flash: this is the good outcome.
      player.onShielded = (self, amount) => {
        fx.spark(self.position, PICKUP_FLASH.shield, 10)
        chase.shake(Math.min(0.35, 0.06 + amount * 0.004))
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
      shieldWarned = false
      lockedTarget = null
      dying = false
      deathTimer = 0
      nextBlast = 0
      pendingResult = null
      best = deps.bestScoreFor(shipId)

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

    step,
    render,

    pause() {
      // Never mid-death: the run has already resolved, and freezing here strands
      // the player in a paused explosion with a debrief queued behind it.
      if (!active || dying) return
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

      const nearestPods = Object.fromEntries(
        PICKUP_KINDS.map((k) => [k, null]),
      ) as RunSnapshot['pickups']
      for (const pod of environment.pickups.pods) {
        if (!pod.live) continue
        const range = pod.position.distanceTo(player.position)
        const held = nearestPods[pod.kind]
        if (held && held.range <= range) continue
        nearestPods[pod.kind] = { ...bearingTo(pod.position), range }
      }

      return {
        seed: runSeed,
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
        shield: player.shieldTimer,
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
      dying = false
      pendingResult = null
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
