/**
 * The dogfight.
 *
 * Owns the participant roster, the enemy squadron, projectiles, effects, camera
 * and HUD for one match, and reports a `RunResult` when it ends. The environment
 * is passed in rather than built here, because it is expensive and is shared
 * with the hangar screen behind the ship-select cards.
 *
 * Enemies arrive in a trickle rather than all at once: six hulls in your face on
 * spawn is not a fight, it is an ambush. Three at a time keeps every engagement
 * readable while still emptying the same squadron.
 *
 * There is no `player` in here any more, and the absence is the milestone. What
 * replaced it is `seats` plus a `local` index, and the split between them is the
 * rule everything else in this file follows: **a seat decides outcomes, `local`
 * only decides what is drawn.** A host simulating four seats has to arrive at
 * the same fight whichever one it happens to be looking through, so anything
 * that reads `local` — the camera, the HUD, the alarms, the gun pitch — must not
 * be able to change a hull, a score or a result. The three anchors that used to
 * read `player` and now do not are enemy arrival points, the AI's target, and
 * the run's own liveness; each is noted where it lands.
 */

import * as THREE from 'three'
import type { Audio } from '../core/audio'
import type { Input } from '../core/input'
import { STREAM, subRng, type Rng } from '../core/rng'
import type { RunResult } from '../core/scores'
import { otherShips, SHIPS, type ShipId } from '../ships/specs'
import {
  ARENA_RADIUS,
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
import { createBolts, FACTION_AI, FACTION_ENVIRONMENT, FACTION_PLAYER, type Bolts, type Faction } from './bolts'
import { FEED_RING, NOBODY, THE_ARENA, type KillEvent, type LockRef, type SeatState, type ShipState, type SquadronState, type WorldSnapshot } from '../net/snapshot'
import { createChaseCamera, type ChaseCamera } from './chase'
import { createFx, type Fx } from './fx'
import type { Hud, HudContact, HudTarget } from './hud'
import {
  accuracyOf,
  createSeats,
  creditDamage,
  creditHit,
  creditKill,
  ELIMINATED,
  FLYING,
  launchPoint,
  recordControls,
  seatOf,
  type Participant,
  type SeatPhase,
} from './roster'
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

/**
 * What a participant's hull is worth to whoever downs it, as a multiple of the
 * bounty the same airframe carries when the squadron flies it.
 *
 * A number, not a mechanism, and it is here so that it is one number: a human
 * on the stick is harder to hit than the scripted pilot, and the match should
 * pay for it. Two is a first guess and a balance lever, not a finding.
 */
export const PARTICIPANT_BOUNTY_MULT = 2

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
const _drawnPos = new THREE.Vector3()
const _drawnQuat = new THREE.Quaternion()
/** Where the fight is, recomputed per use. See `fightCentre`. */
const _anchor = new THREE.Vector3()
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

/**
 * What a match is made of.
 *
 * One entry in `ships` per seat, in roster order, so seat `i` flies `ships[i]`
 * and holds faction `i`. The shipped game passes one; the headless checks pass
 * two. Nothing else about a seat is described here on purpose — a name, an
 * avatar, whether a pilot or a peer supplies its controls — because none of that
 * is decided yet and inventing the fields now would be guessing at milestone 9.
 */
export interface MatchSetup {
  ships: ShipId[]
  /**
   * The seat this machine presents: camera, HUD, alarms, gun pitch. Defaults to
   * seat 0. Presentation only — see the note at the top of this file.
   */
  local?: number
  /**
   * Death returns a seat to the arena after its cutscene instead of resolving
   * the run.
   *
   * A match policy rather than a property of the roster size, and off by default,
   * which is the one place this milestone deliberately does not follow the plan.
   * `PLANS/NEON_ORBIT_PHASE_B.md` has respawn replacing run-end outright — but
   * single-player *is* a match with one seat, and switching it over would leave
   * the shipped game with no lose condition and no route to the debrief at all.
   * So elimination stays the default and PvP turns respawn on. Same code path
   * either way; the flag decides what happens when the cutscene finishes.
   */
  respawn?: boolean
  /**
   * Fixes every gameplay draw the match makes — squadron order, arrival points,
   * AI wander, gun spread, respawn points — so the same seed replayed against
   * the same inputs produces the same fight. Omitted, a fresh one is rolled and
   * reported back through `snapshot().seed`.
   */
  seed?: number
}

export interface Game {
  readonly active: boolean
  readonly paused: boolean
  /**
   * True while the *local* seat's death animation is playing. Nothing may pause
   * or interrupt the game here, or the explosion freezes mid-blast.
   *
   * Local rather than global, because a match in which one participant's death
   * froze the arena for everybody else is not a match. Another seat's wreck
   * tumbles inside the ordinary tick and this stays false.
   */
  readonly dying: boolean
  /** How many seats the match was started with. */
  readonly seatCount: number
  /** Begin a match. */
  start(setup: MatchSetup): void
  /**
   * Advance the simulation by exactly one fixed tick, flying **seat `i` on
   * `intents[i]`**.
   *
   * Deliberately takes no `dt`: a caller that could pass its own could pass a
   * large one and cover more ground per frame, which is the cheapest cheat there
   * is, and is why the loop owns the step size rather than the frame.
   *
   * It takes intent rather than a device, which is the substitution milestone 1
   * made and everything in phase B hangs off — the same tick runs identically
   * against a keyboard, a recorded stream, or a packet from another browser and
   * cannot tell which. What is new is that it takes intent for *everybody*: the
   * host flies the whole roster, so a seat is driven by whatever controls were
   * supplied for it and the simulation never asks where they came from.
   *
   * Exactly one intent per seat is required, and a mismatch throws rather than
   * being filled in. A short array is otherwise a `TypeError` deep inside the
   * flight model — reading `.fire` of `undefined` — and a long one is a caller
   * that thinks the match has more seats than it does, which is worth hearing
   * about immediately. A *late* packet is a different thing and is not this:
   * when there is a wire, the boundary that unpacks it decides what a missing
   * tick means (hold the last intent) before the array is built. Milestones 4
   * and 6.
   */
  step(intents: readonly Controls[]): void
  /**
   * Draw the current simulation state. `alpha` is how far the frame sits
   * between the last two ticks, 0..1. Writes no simulation state, so a headless
   * run never calls it.
   */
  render(alpha: number, frameDt: number): void
  /**
   * Freeze the simulation, and report whether it actually froze.
   *
   * The return value is load-bearing rather than a convenience. Pausing is refused
   * while any seat is mid-explosion, and a caller that decides on its own whether
   * that is the case will eventually disagree — `src/main.ts` gated its pause
   * *screen* on `dying`, which is the drawn seat only, so with a remote seat wrecked
   * it showed the panel while this method refused, and the match kept fighting
   * behind the overlay. Measured at 140 units of travel in the second after the
   * player pressed Escape. Ask, then act on the answer.
   */
  pause(): boolean
  resume(): void
  /**
   * Drop the run without reporting a result. Used by "abort" — a player who
   * quits from the pause menu has not lost, and should not have a loss written
   * into their record.
   */
  abandon(): void
  /** Switch the local seat to the next hostile. Bound to Tab / T. */
  cycleTarget(): void
  /**
   * Read-only view of one seat's match, for debugging in the console. Exposed on
   * `window.__neon` in dev builds only.
   *
   * Defaults to the local seat, which is what the console wants. `seat` is what
   * makes a headless check able to fly a participant it is not watching: the
   * autopilots in `scripts/simcheck.ts` steer from the bearings in here, so
   * without a per-seat view a second human could be simulated but not flown.
   * Returns `null` for a seat that does not exist rather than throwing, since
   * this is an inspection hook and a bad index in a console is not worth killing
   * a frame over.
   */
  snapshot(seat?: number): RunSnapshot | null
  /** The world this tick, as plain data, for the wire. See `net/snapshot.ts`. */
  capture(): WorldSnapshot
  /**
   * Become a host's world for one tick. A mirror starts the same `MatchSetup`,
   * never calls `step`, applies each snapshot as it arrives and renders as
   * normal. Throws `RangeError` if the roster does not match; a snapshot that
   * throws has changed nothing.
   */
  apply(snapshot: WorldSnapshot): void
  /** Fly one seat one tick locally, provisionally — flight only. See the implementation. */
  predict(seat: number, controls: Controls): void
  /** After `apply`: replay this seat's unacknowledged intents on top of the host's truth. */
  reconcile(seat: number, replay: readonly Controls[]): void
  /** Host only: record the client intent tick a seat just flew, for the next snapshot. */
  acknowledge(seat: number, tick: number): void
  /**
   * Mirror only: no snapshot arrived for this tick, so carry every hull and bolt
   * one tick along its last velocity — except the seat given, which is being
   * predicted and moves on its own intent. See the implementation for why this
   * is not a stall.
   */
  coast(except: number): void
  dispose(): void
}

export interface RunSnapshot {
  /**
   * The seed this run's gameplay randomness came from. Reported so a run worth
   * keeping can be replayed: feed it back to `start` with the same inputs and
   * the same fight happens.
   */
  seed: number
  /** Which seat this view is of, and how many there are. */
  seat: number
  seats: number
  /**
   * Where this seat is in its life: flying, mid-explosion, or out.
   *
   * Three states rather than a `wrecked` boolean, because "not wrecked" was
   * ambiguous between the two ends of a seat's life and reading it as "flying" is
   * exactly the bug `SeatPhase` exists to make unrepresentable.
   */
  phase: 'flying' | 'wrecked' | 'eliminated'
  /** Times this seat has been killed. Zero in a match without respawn. */
  deaths: number
  score: number
  kills: number
  /**
   * This seat's streak bonus and its landed-hit count — the two halves of a
   * scoreline that a `score` total alone cannot separate.
   *
   * Both are per-seat state and both were unobservable, which meant "scoring is
   * per participant" could only be checked through the one number they feed. `hits`
   * is the accuracy numerator; `multiplier` is what makes a streak personal rather
   * than shared.
   */
  multiplier: number
  hits: number
  shotsFired: number
  /**
   * This seat's hull and speed. Named for the seat rather than for "the player",
   * which is the rename that stops `snapshot(1)` from lying about whose numbers
   * these are.
   */
  hull: number
  speed: number
  /**
   * Where this seat is.
   *
   * A console view that reports the bearing to every pod and every locked target
   * but not where the ship asking is was an odd gap, and it is the one field that
   * makes a *trajectory* comparable rather than only an outcome. Two runs of one
   * seed can agree on hull, score and speed while flying different fights — which
   * is exactly what a mutation that pointed the squadron at the wrong seat did,
   * undetected, until this was here to see it.
   */
  position: { x: number; y: number; z: number }
  /**
   * The throttle this seat's last tick actually flew on — the seat's copy, not
   * whatever its producer holds now.
   *
   * Here because it is the only observable of the "`step` must not retain what it
   * is handed" rule for a seat nobody is drawing. The local seat's copy has always
   * been visible through the HUD, which is how the rule was asserted when there
   * was one seat; a rule that only holds where somebody is looking is not the rule.
   */
  throttle: number
  enemiesAirborne: number
  enemiesQueued: number
  elapsed: number
  /** How hard the star is cooking this seat, 0..1. Exposed for the same
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

  // The listener, rewritten by `start` to whichever seat this machine presents.
  // Initialised to seat 0's faction rather than left undefined so a `Ship`
  // constructed before any match — nothing does today — still has a coherent
  // context.
  const ctx: ShipContext = {
    hazards: environment.hazards,
    audio,
    bolts,
    localFaction: FACTION_PLAYER,
  }
  /**
   * The context a *predicted* step flies in: the same arena, but the guns fire
   * into nothing. A client predicts its own flight so the stick feels
   * immediate; it does not predict its bolts, because the host's snapshot
   * restores the whole pool every tick and a locally fired bolt would flicker
   * out and reappear a round trip later. Bolts arrive with the truth.
   */
  const dryCtx: ShipContext = {
    hazards: environment.hazards,
    audio,
    bolts: { ...bolts, fire() {} },
    localFaction: FACTION_PLAYER,
  }

  /**
   * The roster. Empty between matches, which is the state `player === null` used
   * to mean.
   */
  let seats: Participant[] = []
  /** Index into `seats` of the seat this machine draws. Presentation only. */
  let localIndex = 0
  let respawns = false

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
  let respawnRng: Rng = subRng(0, STREAM.respawn)

  let active = false
  let paused = false
  let elapsed = 0
  /** Fixed ticks since `start`. The snapshot's clock; nothing in the sim reads it. */
  let tick = 0
  /**
   * True once `apply` has run: this game is a mirror of a host's, and reports the
   * host's queue rather than its own empty one. Cleared by `start`.
   */
  let mirrored = false
  let mirroredQueued = 0
  /**
   * The seat that last landed a hit on each hull, for damage with no author.
   * Weak, so a retired squadron hull takes its entry with it.
   */
  const lastHitter = new WeakMap<Ship, Participant>()
  /** The latest kills, oldest first, at most `FEED_RING`. Sent with every snapshot. */
  let feed: KillEvent[] = []
  let feedSeq = 0
  /** A mirror: the last `KillEvent.seq` announced. */
  let feedSeen = 0
  /** Spawn order of each squadron hull — the identity a snapshot carries for it. */
  const pilotIds = new Map<EnemyPilot, number>()
  /**
   * Per seat, the client intent tick the host last flew — protocol state the
   * snapshot carries so a predicting client knows what to replay. Set by the
   * host through `acknowledge`, copied through `apply`, never read by the sim.
   */
  let acks: number[] = []
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

  /**
   * The scoreline, sealed the moment the local seat died.
   *
   * Only a match without respawn ever holds one: with respawn on, a death is not
   * a resolution, so there is nothing to seal.
   */
  let pendingResult: RunResult | null = null

  const contactBuffer: HudContact[] = []
  /** Enemy-only view of the arena, reused each frame for AI separation. */
  const squadron: Ship[] = []
  /** Scratch for `lockCandidates`, rebuilt per seat per tick. */
  const candidateBuffer: Ship[] = []
  /**
   * What the AI steers around: solid stations plus every live mine. Rebuilt only
   * when a mine detonates, not per frame.
   */
  let avoidList: Hazard[] = []
  /** Every ship in the arena, rebuilt only when the squadron changes. */
  let boltTargets: Ship[] = []

  function refreshTargets() {
    boltTargets = [...seats.map((s) => s.ship), ...pilots.map((p) => p.ship)]
  }

  /* ------------------------------------------------------------------------ */
  /* The roster                                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * Which seat to draw, given what the caller asked for.
   *
   * Clamped rather than trusted, because `local` is an index into a roster the
   * caller did not build and an out-of-range one would leave every presentation
   * call reading `undefined` for a whole match. Presentation, so a wrong-but-legal
   * answer is the right failure mode — unlike a faction, where there is no stand-in
   * and `humanFaction` throws instead.
   *
   * The not-a-number case is separate and is why this is a function. `Math.min` and
   * `Math.max` propagate `NaN` rather than clamping it, so the obvious one-liner
   * produced `seats[NaN]`, `undefined`, and a `TypeError` on the next line — a
   * comment claiming "clamped, not fatal" over code that threw. Same trap and same
   * fix as `clamp` in `ship.ts`, and deliberately not `Number.isFinite`: `Infinity`
   * is a perfectly clampable request for "the last seat".
   */
  function drawnSeatIndex(requested: number | undefined, count: number): number {
    if (typeof requested !== 'number' || Number.isNaN(requested)) return 0
    const asked = Math.trunc(requested)
    return asked < 0 ? 0 : asked > count - 1 ? count - 1 : asked
  }

  /**
   * The seat this machine is drawing, or `null` between matches.
   *
   * Every caller of this is presentation. If a use of it ever reaches a hull, a
   * score or a result, that is the bug this accessor exists to make visible.
   */
  function local(): Participant | null {
    return seats[localIndex] ?? null
  }

  /**
   * Where the fight is: the centre of the live seats, or of all of them if none
   * are alive.
   *
   * This is the first of the three things that used to read `player`, and the
   * one where the wrong answer is tempting. Anchoring on the *local* seat would
   * work perfectly and be silently non-deterministic — two machines drawing the
   * same match from different seats would place arrivals in different places, so
   * the same seed would stop reproducing the moment anyone else was watching.
   * The centroid is a function of the roster rather than of the viewer.
   *
   * Exact for one seat: `0 + x` and `x / 1` are both exact in floating point, so
   * a single-seat match anchors on precisely the position it always did. That is
   * load-bearing for the recorded baseline, not a nicety.
   */
  function fightCentre(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0)
    let counted = 0
    for (const seat of seats) {
      if (!seat.ship.alive) continue
      out.add(seat.ship.position)
      counted++
    }
    if (counted === 0) {
      for (const seat of seats) out.add(seat.ship.position)
      counted = seats.length
    }
    return counted > 0 ? out.divideScalar(counted) : out
  }

  /**
   * The seat a hostile flies at: the nearest one, live for preference.
   *
   * The second thing that used to read `player`. Ties break on seat order, so
   * this is a pure function of the roster's positions and reproduces. A dead
   * seat is still a valid answer when every seat is dead — which is what the AI
   * was handed during the old cutscene, and keeping that means a squadron does
   * not stop flying while it waits for somebody to come back.
   */
  function nearestSeat(to: THREE.Vector3): Ship | null {
    let best: Ship | null = null
    let bestDist = Infinity
    let bestAlive = false
    for (const seat of seats) {
      const ship = seat.ship
      const dist = ship.position.distanceToSquared(to)
      // A live seat always outranks a dead one, however far away it is.
      if (bestAlive && !ship.alive) continue
      if (ship.alive && !bestAlive) {
        best = ship
        bestDist = dist
        bestAlive = true
        continue
      }
      if (dist < bestDist) {
        best = ship
        bestDist = dist
      }
    }
    return best
  }

  /**
   * The seat a hit is credited to, or nobody.
   *
   * A bolt names its author, and that is the credit. Damage the arena inflicts
   * — a mine, a scrape — arrives as `FACTION_ENVIRONMENT`, and goes to the seat
   * that last landed a hit on the victim: a hostile chased onto a mine still
   * scores for the chaser, which the README sells as a tactic. In a match of
   * one seat, the arena's damage to a hostile is that seat's — exactly what the
   * old "blame the other side" produced there — so the single-player scoreline
   * is unchanged bit for bit. With more seats and no last hitter it is nobody's.
   * The star names the victim's own faction and is never a hit for anyone.
   */
  function hitCredit(from: Faction, victim: Ship): Participant | null {
    if (from === FACTION_ENVIRONMENT) return lastHitter.get(victim) ?? soleSeat()
    return seatOf(seats, from) ?? null
  }

  /**
   * The seat paid for a kill, or nobody.
   *
   * The author if it has one, else the last seat to land a hit, else — in a
   * match of one seat only — that seat. That last clause is the whole of the
   * single-player behaviour, in which every kill was seat 0's: a hostile that
   * flew into the star untouched still paid. With more than one seat it is
   * no longer arbitrary: an untouched hostile burning up pays nobody.
   */
  function bountyGoesTo(from: Faction, victim: Ship): Participant | null {
    return seatOf(seats, from) ?? lastHitter.get(victim) ?? soleSeat()
  }

  /** The one seat, in a match of one; nobody otherwise. */
  function soleSeat(): Participant | null {
    return seats.length === 1 ? seats[0] : null
  }

  /* ---- The kill feed ------------------------------------------------------ */

  /** A seat by name for the feed: the watcher is YOU, everyone else is P<n>. */
  function seatName(index: number): string {
    return seats[index] === local() ? 'YOU' : `P${index + 1}`
  }

  /**
   * Show one kill to the seat being drawn. The host runs this as the kill
   * happens; a mirror runs it as the event arrives in a snapshot. Same text on
   * every machine, from the same event, with only YOU moving.
   */
  function announceKill(e: KillEvent): void {
    const watcher = local()
    const victimName = e.victim >= 0 ? seatName(e.victim) : SHIPS[e.hull].name.toUpperCase()
    const killerName = e.killer >= 0 ? seatName(e.killer) : e.killer === THE_ARENA ? 'THE ARENA' : 'THE SQUADRON'
    if (e.killer >= 0 && seats[e.killer] === watcher) {
      hud.feed(`${victimName} DOWN  +${e.award}`)
      hud.callout('TARGET DESTROYED', `#${SHIPS[e.hull].accent.toString(16).padStart(6, '0')}`, 1.1)
    } else if (e.victim >= 0 && seats[e.victim] === watcher) {
      hud.feed(`DOWNED BY ${killerName}`)
    } else {
      hud.feed(`${killerName} ▸ ${victimName} DOWN`)
    }
  }

  /** Record a kill for the wire and announce it here. */
  function recordKill(killer: Participant | null, from: Faction, victim: Participant | null, hull: ShipId, award: number): void {
    const e: KillEvent = {
      seq: ++feedSeq,
      killer: killer ? killer.index : from === FACTION_AI ? NOBODY : THE_ARENA,
      victim: victim ? victim.index : NOBODY,
      hull,
      award,
    }
    feed.push(e)
    if (feed.length > FEED_RING) feed.shift()
    feedSeen = e.seq
    announceKill(e)
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
    if (seats.length === 0) return out.set(0, 0, 0)
    fightCentre(_anchor)

    for (let attempt = 0; attempt < 12; attempt++) {
      const u = spawnRng.range(-1, 1)
      const theta = spawnRng.range(0, Math.PI * 2)
      const r = Math.sqrt(Math.max(0, 1 - u * u))
      _spawnDir.set(r * Math.cos(theta), u, r * Math.sin(theta))

      out.copy(_anchor).addScaledVector(_spawnDir, spawnRng.range(900, 1320))

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
    if (!id || seats.length === 0) return

    const index = pilotsSpawned++
    const ship = new Ship(SHIPS[id], FACTION_AI, subRng(runSeed, STREAM.enemyGuns + index))
    pickSpawnPoint(_spawnPos)
    fightCentre(_anchor)
    ship.spawn(_spawnPos, _anchor)

    // A hit is credited to whoever landed it, and to nobody when that is nobody.
    // `seatOf` is the lookup that makes this safe — resolving faction to seat and
    // returning nothing on a miss, rather than minting a faction from a search.
    ship.onDamaged = (self, amount, from) => {
      const direct = seatOf(seats, from)
      if (direct) {
        lastHitter.set(self, direct)
        creditHit(direct, amount)
        return
      }
      const owed = hitCredit(from, self)
      if (owed) creditDamage(owed, amount)
    }

    ship.onDeath = (self, from) => {
      const scorer = bountyGoesTo(from, self)
      const award = scorer ? creditKill(scorer, self.spec.bounty) : 0
      fx.explode(self.position, self.accent, self.spec.id === 'drone' ? 1.5 : 1.1)
      audio.explosion(self.spec.id === 'drone')
      const watcher = local()
      chase.shake(watcher && self.position.distanceTo(watcher.ship.position) < 420 ? 0.8 : 0.25)
      recordKill(scorer, from, null, self.spec.id, award)
    }

    scene.add(ship.visual.group)
    const pilot = new EnemyPilot(ship, subRng(runSeed, STREAM.pilot + index))
    pilotIds.set(pilot, index)
    pilots.push(pilot)
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
      pilotIds.delete(pilots[i])
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

      const watcher = local()
      if (watcher) {
        const distance = mine.position.distanceTo(watcher.ship.position)
        chase.shake(distance < 600 ? 2.6 : 0.4)
      }
      if (watcher && target === watcher.ship) hud.callout('MINE', '#ff3b4e', 1.2)

      // The arena's doing. Who is credited is `hitCredit` / `bountyGoesTo`'s
      // rule: the last seat to land a hit on the victim, so a hostile chased
      // onto a mine scores for the chaser and a participant on a mine pays
      // whoever was on their tail.
      target.takeDamage(MINE_DAMAGE, FACTION_ENVIRONMENT)
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Power-up pods                                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * The counterpart to `resolveMines`, with one deliberate difference: only a
   * *seat's* hull is offered a pod. Hostiles fly straight through. The reasoning
   * lives in `world/pickups.ts`; the short version is that nothing steers toward
   * a pod, so an AI collecting one would be a coin flip that quadrupled its
   * damage with no tell — and that argument turns on steering, not on sides, so
   * it generalises to every seat rather than to "the player".
   *
   * Checked after everyone has moved, like mines, so contact resolves against
   * final positions rather than a stale frame. Seats are offered pods in roster
   * order, which decides who gets a pod two hulls arrive at on the same tick —
   * arbitrary, but deterministic, which is the part that matters.
   */
  function resolvePickups(): void {
    for (const seat of seats) offerPickup(seat)
  }

  function offerPickup(seat: Participant): void {
    const ship = seat.ship
    if (!ship.alive || ship.warpTimer > 0) return

    const field = environment.pickups
    const pod = field.findContact(ship.position, ship.radius)
    if (!pod) return

    // Callouts and the feed belong to the seat being drawn. Another participant
    // collecting a pod is their business, and their HUD's.
    const mine = seat === local()

    if (pod.kind === 'repair') {
      const healed = ship.repair(REPAIR_AMOUNT)
      // Nothing to repair: leave the pad armed rather than burning it on a full
      // hull. Flying over spare parts you do not need should cost you nothing.
      if (healed <= 0) return
      if (mine) {
        hud.feed(`HULL +${Math.round(healed)}`)
        hud.callout('HULL REPAIRED', PICKUP_COLOR.repair, 0.9)
      }
    } else if (pod.kind === 'overdrive') {
      ship.engageOverdrive(OVERDRIVE_DURATION)
      if (mine) {
        // Clear the warning latch: a stacked pod has pushed the clock back above
        // the threshold, so the countdown has to be able to fire again.
        overdriveWarned = false
        // "SEC" rather than "s": the HUD uppercases everything, and in this font
        // a trailing capital S against a digit reads as another 5 — "+10s" came
        // out looking like "+105".
        hud.feed(`OVERDRIVE +${OVERDRIVE_DURATION} SEC`)
        hud.callout('OVERDRIVE', PICKUP_COLOR.overdrive, 1.2)
      }
    } else {
      ship.engageShield(SHIELD_DURATION)
      if (mine) {
        shieldWarned = false
        hud.feed(`SHIELD +${SHIELD_DURATION} SEC`)
        hud.callout('SHIELD UP', PICKUP_COLOR.shield, 1.2)
      }
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
  /**
   * Anything `seat` is allowed to shoot at, in a stable order.
   *
   * Other seats come first, then the squadron. For a one-seat match the first
   * half is empty and this is exactly the old list of pilots, in the old order —
   * which matters, because the lock below breaks ties on iteration order.
   *
   * A dead or same-faction ship is excluded here rather than at every use.
   */
  function lockCandidates(seat: Participant, out: Ship[]): Ship[] {
    out.length = 0
    for (const other of seats) {
      if (other === seat || !other.ship.alive) continue
      out.push(other.ship)
    }
    for (const pilot of pilots) {
      if (!pilot.ship.alive) continue
      out.push(pilot.ship)
    }
    return out
  }

  function acquireTarget(seat: Participant): void {
    const self = seat.ship
    if (!self.alive) {
      // A wreck holds no lock. Left set, the HUD would freeze a live target
      // readout over your own explosion and the respawn would inherit it.
      seat.lockedTarget = null
      return
    }

    lockCandidates(seat, candidateBuffer)
    const held = seat.lockedTarget
    if (held && !candidateBuffer.includes(held)) seat.lockedTarget = null
    if (seat.lockedTarget) return

    // Prefer whatever is closest to the nose, falling back to closest by range.
    self.forward(_forward)
    let best: Ship | null = null
    let bestScore = -Infinity
    for (const enemy of candidateBuffer) {
      _toEnemy.subVectors(enemy.position, self.position)
      const dist = _toEnemy.length()
      if (dist < 1e-3) continue
      const alignment = _forward.dot(_toEnemy) / dist
      const score = alignment * 2 - dist / 4000
      if (score > bestScore) {
        bestScore = score
        best = enemy
      }
    }
    seat.lockedTarget = best
  }

  /**
   * Where `self` must aim for a bolt to meet `target`. One Newton step on
   * `|target + v·t − self| = boltSpeed·t` is plenty at these ranges.
   */
  function solveLead(self: Ship, target: Ship, out: THREE.Vector3): void {
    const boltSpeed = self.spec.boltSpeed + Math.max(0, self.speed) * 0.35
    let t = target.position.distanceTo(self.position) / boltSpeed
    for (let i = 0; i < 2; i++) {
      out.copy(target.position).addScaledVector(target.velocity, t)
      t = out.distanceTo(self.position) / boltSpeed
    }
    out.copy(target.position).addScaledVector(target.velocity, t)
  }

  /** True when the seat's nose is close enough to its lead point to connect. */
  function onTarget(seat: Participant): boolean {
    const self = seat.ship
    const held = seat.lockedTarget
    if (!self.alive || !held || !held.targetable) return false
    solveLead(self, held, _lead)
    _toEnemy.subVectors(_lead, self.position)
    const dist = _toEnemy.length()
    if (dist > 1600 || dist < 1e-3) return false
    self.forward(_forward)
    // The angle the hull subtends, plus a little slack for the reticle to feel
    // responsive rather than binary.
    const gate = Math.atan2(held.radius * 2.2, dist)
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
    pilotIds.clear()
    mirrored = false
    mirroredQueued = 0
    for (const seat of seats) {
      scene.remove(seat.ship.visual.group)
      seat.ship.dispose()
    }
    seats = []
    localIndex = 0
    bolts.clear()
    fx.clear()
    boltTargets = []
    contactBuffer.length = 0
  }

  /**
   * The scoreline at the instant the run resolves, for the seat being drawn.
   *
   * Sealed here rather than read at `finish`, because a loss keeps the arena
   * running for `DEATH_SEQUENCE` seconds afterwards — long enough for a hostile
   * to fly into the star and post a bounty to a pilot who is already dead.
   *
   * Reports the local seat because `RunResult` is what the debrief and the score
   * store consume, and both are single-player shaped: one ship, one score, one
   * accuracy. A match-wide result — every seat's line, a winner, a placing — is
   * milestone 8's, and inventing the shape now would mean guessing at the rules
   * it has to describe.
   *
   * **Reads state and writes none**, which it did not used to do: the win bonuses
   * were added to the running score. That was invisible with one seat and is a
   * leak with more than one — the seat being *drawn* would end the match with a
   * different score from the seat beside it, so which machine was watching would
   * change a number the simulation owns. Who deserves a win bonus in a match with
   * several seats is a match rule, and until milestone 8 decides one, the bonus
   * belongs to the report rather than to the scoreline.
   *
   * **No test covers this, and it is not for want of trying.** Restoring the
   * mutation — `seat.score += bonus` — leaves all 292 checks green, because with
   * today's call sites the write is unobservable: `sealResult(true)` is reached
   * from exactly one place, `finish(sealResult(true))`, and `finish` calls
   * `clearArena` before returning, so no caller can read a seat's score between
   * the two. On a loss the bonus is zero and the write is a no-op. The purity is
   * therefore defensive rather than currently load-bearing — it becomes real at
   * milestone 8, where a win stops ending the match. Written down because a
   * mutation that survives is worth a sentence, not a pretend assertion.
   */
  function sealResult(won: boolean): RunResult {
    const seat = local()
    if (!seat) return { ship: 'hornet', score: 0, kills: 0, time: elapsed, won, accuracy: 0 }

    // Reward finishing intact and finishing fast, in that order.
    const bonus = won
      ? Math.round(seat.ship.hullFraction * 1200) + Math.max(0, Math.round(4000 - elapsed * 25))
      : 0

    return {
      ship: seat.ship.spec.id,
      score: seat.score + bonus,
      kills: seat.kills,
      time: elapsed,
      won,
      accuracy: accuracyOf(seat),
    }
  }

  function finish(result: RunResult): void {
    if (!active) return
    active = false
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
    // Other seats first, then the squadron. A contact is "something airborne that
    // is not me", which was the same list as "the enemies" only because there was
    // one seat; another participant is a hostile hull with a hull bar like any
    // other. Order is stable so the markers do not swap places between frames.
    const watcher = local()
    for (const seat of seats) {
      if (seat === watcher || !seat.ship.alive || seat.phase.kind !== 'flying') continue
      contactBuffer.push({
        position: seat.ship.visual.group.position,
        hullFraction: seat.ship.hullFraction,
        accent: seat.ship.spec.accent,
        sinceHit: seat.ship.sinceHit,
      })
    }
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
   * Hand a seat's hull to its wreck.
   *
   * For the local seat this also banks the scoreline, and everything after it is
   * presentation. For any other seat it is only the wreck: their result belongs
   * to their own machine.
   */
  function beginDeathSequence(seat: Participant): void {
    if (seat.phase.kind !== 'flying') return
    const ship = seat.ship

    seat.deaths++
    seat.lockedTarget = null
    seat.phase = {
      kind: 'wrecked',
      timer: 0,
      nextBlast: 0,
      emissive: ship.visual.hullMat.emissive.clone(),
    }

    // `syncVisual` hid the hull the frame it died. Put it back — it has a
    // tumble to perform first — and cut the engines.
    ship.visual.group.visible = true
    ship.visual.thrusterMat.opacity = 0

    if (seat !== local()) return

    // A match with respawn has not resolved anything, so there is nothing to
    // seal. Sealing anyway would bank a loss that never gets reported and would
    // add the win bonuses to a scoreline that is still being played.
    if (!respawns) pendingResult = sealResult(false)

    hud.callout('HULL BREACH', '#ff3b4e', 3)

    // Freeze the instruments on the moment of death: a lock pip or a live target
    // readout floating over your own wreck is a lie. The reticle keeps its last
    // projection rather than snapping to centre.
    hud.update({
      hullFraction: 0,
      quirkValue: ship.quirkValue,
      quirkAlarming: false,
      score: seat.score,
      multiplier: seat.multiplier,
      best,
      enemiesTotal: PER_ENEMY_TYPE * 2,
      enemiesRemaining: queuedCount() + pilots.length,
      speed: ship.velocity.length(),
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
  }

  /**
   * Put a seat back in the arena.
   *
   * `Ship.spawn` is the whole respawn: it resets flight state, hull and the warp
   * timer, leaves `shotsFired` and the scoreline alone — so accuracy survives a
   * death rather than restarting — and `syncVisual` inside it undoes the wreck's
   * accumulated tumble, its cooked emissive and its dead thrusters. Reusing the
   * hull rather than building a new one keeps the mesh and its scene membership
   * stable, which is also what stops a respawn from allocating in the middle of a
   * match.
   */
  function respawnSeat(seat: Participant): void {
    seat.phase = FLYING
    seat.lockedTarget = null
    lastHitter.delete(seat.ship)
    pickRespawnPoint(seat, _spawnPos)
    fightCentre(_anchor)
    seat.ship.spawn(_spawnPos, _anchor)

    if (seat !== local()) return
    // The hull teleported, so the camera has to as well: smoothing it across the
    // arena would fly the shot through everything in between.
    chase.reset(seat.ship)
    overdriveWarned = false
    shieldWarned = false
    alarmTimer = 0
    searAlarmTimer = 0
    wasSearing = false
    hud.callout('RESPAWN', '#6be6ff', 1.2)
  }

  /**
   * Where a seat comes back.
   *
   * Its own rejection sampler rather than `pickSpawnPoint`, because it is
   * answering a different question: an arriving hostile wants to be *near* the
   * fight, and somebody rejoining it wants not to materialise on top of the ship
   * that just killed them. So this samples the arena rather than a shell around
   * the fight, and keeps clear of every live hull as well as the hazards.
   *
   * Falls back to the seat's launch point, which is far from the fight by
   * construction and always legal. A fallback that could fail would make the
   * respawn worse than the death.
   */
  function pickRespawnPoint(seat: Participant, out: THREE.Vector3): THREE.Vector3 {
    const CLEARANCE = 700

    for (let attempt = 0; attempt < 16; attempt++) {
      const u = respawnRng.range(-1, 1)
      const theta = respawnRng.range(0, Math.PI * 2)
      const r = Math.sqrt(Math.max(0, 1 - u * u))
      _spawnDir.set(r * Math.cos(theta), u, r * Math.sin(theta))
      out.copy(_spawnDir).multiplyScalar(respawnRng.range(600, ARENA_RADIUS * 0.8))

      let clear = true
      for (const hazard of environment.hazards) {
        if (out.distanceTo(hazard.center) < hazard.radius + 220) {
          clear = false
          break
        }
      }
      if (clear && environment.minefield.findContact(out, 140)) clear = false
      if (clear) {
        for (const other of boltTargets) {
          if (other === seat.ship || !other.alive) continue
          if (out.distanceTo(other.position) < CLEARANCE) {
            clear = false
            break
          }
        }
      }
      if (clear) return out
    }
    return launchPoint(seat.index, seats.length, out)
  }

  /**
   * One tick of one seat's death animation.
   *
   * This used to be the whole tick: the game entered a `dying` mode, returned
   * early, and ran a second copy of the arena loop — squadron, bolts, retire —
   * inside the cutscene. That works for exactly one dying participant and cannot
   * be made to work for two, so the arena loop is now the only arena loop and
   * this is just a hull that happens to be dead. The squadron kept flying before
   * and keeps flying now, for the same reason: freezing the arena the instant
   * somebody dies reads as the game crashing rather than as a kill.
   *
   * Safe to run with a corpse in the roster, unchanged from before — `takeDamage`
   * and `Ship.step` both bail on a dead hull and bolts skip anything untargetable.
   *
   * It is still the one place in the simulation half that calls `Math.random()`,
   * for spark timing and blast scatter, and the exemption still holds but now has
   * a second half worth stating. The old argument was that the scoreline was
   * already sealed, so nothing rolled here could change what the run reported.
   * With respawn on, nothing is sealed — so the argument is instead that none of
   * these draws touch simulation state: the tumble is a mesh write, the sparks
   * and blasts are particles, and the one thing that *is* simulation, the wreck's
   * drift, is pure arithmetic on `dt`. Two viewers may see different sparks; they
   * may not see the wreck in different places.
   */
  function stepWreck(seat: Participant, dt: number): void {
    const wreck = seat.phase
    if (wreck.kind !== 'wrecked') return
    const ship = seat.ship
    const watching = seat === local()
    wreck.timer += dt

    /* The wreck */
    const g = ship.visual.group
    if (wreck.timer < WRECK_TUMBLE) {
      // Coast on the last velocity, so the camera has something to trail rather
      // than a hull that stopped dead in space. Airspeed bleeds with it, which
      // is what walks the camera's speed FOV back down as the wreck slows.
      // Same start-of-tick snapshot `Ship.step` takes, for the same reason: the
      // chase camera interpolates the wreck's drift, and without this it would
      // blend against whatever pose the last living tick left behind.
      ship.prevPosition.copy(ship.position)
      ship.prevQuaternion.copy(ship.quaternion)

      const drag = Math.exp(-WRECK_DRAG * dt)
      ship.velocity.multiplyScalar(drag)
      ship.speed *= drag
      ship.position.addScaledVector(ship.velocity, dt)

      // Tumble the *visual* only. The chase camera sits in the ship's own frame,
      // so spinning `ship.quaternion` would spin the shot instead of the hull
      // and make the last two seconds of the run unwatchable.
      //
      // This rotation is the one mesh write the simulation half is allowed, and
      // it earns the exemption by accumulating: it multiplies into whatever the
      // mesh already holds rather than being a function of the timer. Move it
      // to `render` and the tumble rate becomes frame-rate dependent, which is
      // the exact thing the fixed step exists to prevent. The wreck's *position*
      // has no such excuse — it is a plain interpolation, so `render` owns it.
      _spin.set(WRECK_PITCH * dt, WRECK_YAW * dt, WRECK_ROLL * dt)
      _spinQuat.setFromEuler(_spin)
      g.quaternion.multiply(_spinQuat).normalize()

      ship.visual.hullMat.emissive
        .copy(wreck.emissive)
        .lerp(WRECK_HOT, wreck.timer / WRECK_TUMBLE)

      if (Math.random() < WRECK_SPARK_RATE * dt) fx.spark(ship.position, ship.accent, 6)
    } else if (g.visible) {
      // The ship itself is gone. Debris and cook-offs carry the rest.
      g.visible = false
    }

    fireDueBlasts(seat, watching)
  }

  /**
   * Every detonation on the timeline the wreck's clock has passed, once each.
   * Shared with `apply`, which drives the same timeline from a snapshot's clock.
   */
  function fireDueBlasts(seat: Participant, watching: boolean): void {
    const wreck = seat.phase
    if (wreck.kind !== 'wrecked') return
    const ship = seat.ship
    while (wreck.nextBlast < DEATH_BLASTS.length && wreck.timer >= DEATH_BLASTS[wreck.nextBlast].at) {
      const blast = DEATH_BLASTS[wreck.nextBlast++]
      _blast.copy(ship.position)
      if (blast.spread > 0) {
        _blast.x += (Math.random() * 2 - 1) * blast.spread
        _blast.y += (Math.random() * 2 - 1) * blast.spread
        _blast.z += (Math.random() * 2 - 1) * blast.spread
      }
      fx.explode(_blast, ship.accent, blast.scale)
      audio.explosion(blast.big)
      // Only the seat being drawn gets knocked about by its own explosion.
      if (watching) chase.shake(blast.shake)
    }
  }

  function queuedCount(): number {
    return mirrored ? mirroredQueued : queue.length
  }

  /* ---- Prediction --------------------------------------------------------- */

  /**
   * Fly one seat one tick, locally and provisionally.
   *
   * What a joined client does with its own intent instead of waiting a round
   * trip to see it: the hull moves now, on the same flight model the host runs,
   * and the host's next snapshot either lands exactly where this predicted —
   * the normal case, since flight is deterministic — or corrects it. Flight
   * only: the guns fire into `dryCtx`, and nothing here decides a hit.
   */
  function predict(seat: number, controls: Controls): void {
    const s = seats[seat]
    if (!s || s.phase.kind !== 'flying' || !s.ship.alive) return
    recordControls(s, controls)
    s.ship.step(s.lastControls, STEP, dryCtx)
  }

  /**
   * After `apply`, re-fly what the host has not heard yet.
   *
   * `apply` has just put this seat's hull at the host's truth, which is where
   * the hull was as of the intent tick the host acknowledged. Every intent sent
   * since is replayed on top, so the hull ends up where a prediction that had
   * known the truth would have put it. The pose the frame interpolates from is
   * kept at where the hull was *drawn* last tick — `apply` saved it as the
   * previous pose and each replayed step would overwrite it — so a correction
   * is a smooth slide over one frame rather than a snap.
   */
  function reconcile(seat: number, replay: readonly Controls[]): void {
    const s = seats[seat]
    if (!s || s.phase.kind !== 'flying' || !s.ship.alive) return
    _drawnPos.copy(s.ship.prevPosition)
    _drawnQuat.copy(s.ship.prevQuaternion)
    for (const c of replay) s.ship.step(c, STEP, dryCtx)
    s.ship.prevPosition.copy(_drawnPos)
    s.ship.prevQuaternion.copy(_drawnQuat)
  }

  /** The host recording which of a seat's intent ticks it just flew. */
  function acknowledge(seat: number, tick: number): void {
    if (seat >= 0 && seat < acks.length) acks[seat] = tick
  }

  /**
   * The mirror's tick when nothing arrived.
   *
   * A paced client applies one snapshot per tick of its own, so the pose the
   * frame blends from is always one tick behind the pose it blends to. On a
   * tick the wire delivered nothing there is no new pose, and leaving the pair
   * alone is wrong in a way that is visible: the blend factor restarts at zero
   * against the *same* pair, so every hull slides back up to a tick and
   * re-covers it. Copying the pose forward instead freezes everything for a
   * tick. Carrying it along the last velocity — exactly what `Ship.step` and
   * the bolt pool do to a position in one tick — is a hold that keeps moving,
   * and on straight flight it lands where the missing snapshot would have.
   * Orientation is held: a hull's turn rate is not sent.
   *
   * Only hulls the mirror does not fly: the predicted seat has its own step
   * this tick, and a wreck's drift is the same coast the host does.
   */
  function coast(except: number): void {
    if (!mirrored) return
    for (const seat of seats) {
      if (seat.index === except || seat.phase.kind === 'eliminated') continue
      carry(seat.ship)
    }
    for (const pilot of pilots) carry(pilot.ship)
    bolts.coast(STEP)
  }

  function carry(ship: Ship): void {
    ship.prevPosition.copy(ship.position)
    ship.prevQuaternion.copy(ship.quaternion)
    ship.position.addScaledVector(ship.velocity, STEP)
  }

  /* ---- Snapshots --------------------------------------------------------- */

  function readShip(ship: Ship): ShipState {
    return {
      position: { x: ship.position.x, y: ship.position.y, z: ship.position.z },
      quaternion: { x: ship.quaternion.x, y: ship.quaternion.y, z: ship.quaternion.z, w: ship.quaternion.w },
      velocity: { x: ship.velocity.x, y: ship.velocity.y, z: ship.velocity.z },
      speed: ship.speed,
      hull: ship.hull,
      throttle: ship.throttle,
      alive: ship.alive,
      warpTimer: ship.warpTimer,
      flash: ship.flash,
      sinceHit: ship.sinceHit,
      heat: ship.heat,
      heatLocked: ship.heatLocked,
      dashTimer: ship.dashTimer,
      dashCooldown: ship.dashCooldown,
      overdriveTimer: ship.overdriveTimer,
      shieldTimer: ship.shieldTimer,
      solarExposure: ship.solarExposure,
      shotsFired: ship.shotsFired,
    }
  }

  /**
   * Write a hull's state, keeping the previous tick's transform for
   * interpolation: the mirror renders between the last two snapshots exactly as
   * the host renders between the last two ticks.
   */
  function writeShip(ship: Ship, s: ShipState): void {
    ship.prevPosition.copy(ship.position)
    ship.prevQuaternion.copy(ship.quaternion)
    ship.position.set(s.position.x, s.position.y, s.position.z)
    ship.quaternion.set(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w)
    ship.velocity.set(s.velocity.x, s.velocity.y, s.velocity.z)
    ship.speed = s.speed
    ship.hull = s.hull
    ship.throttle = s.throttle
    ship.alive = s.alive
    ship.warpTimer = s.warpTimer
    ship.flash = s.flash
    ship.sinceHit = s.sinceHit
    ship.heat = s.heat
    ship.heatLocked = s.heatLocked
    ship.dashTimer = s.dashTimer
    ship.dashCooldown = s.dashCooldown
    ship.overdriveTimer = s.overdriveTimer
    ship.shieldTimer = s.shieldTimer
    ship.solarExposure = s.solarExposure
    ship.shotsFired = s.shotsFired
  }

  function lockOf(seat: Participant): LockRef {
    const held = seat.lockedTarget
    if (!held) return { kind: 'none' }
    const asSeat = seats.find((s) => s.ship === held)
    if (asSeat) return { kind: 'seat', index: asSeat.index }
    for (const pilot of pilots) {
      if (pilot.ship === held) return { kind: 'squadron', id: pilotIds.get(pilot) ?? 0 }
    }
    return { kind: 'none' }
  }

  function resolveLock(lock: LockRef): Ship | null {
    if (lock.kind === 'seat') return seats[lock.index]?.ship ?? null
    if (lock.kind === 'squadron') {
      for (const pilot of pilots) if (pilotIds.get(pilot) === lock.id) return pilot.ship
    }
    return null
  }

  function capture(): WorldSnapshot {
    const seatStates: SeatState[] = seats.map((seat) => ({
      ship: readShip(seat.ship),
      score: seat.score,
      kills: seat.kills,
      multiplier: seat.multiplier,
      hits: seat.hits,
      deaths: seat.deaths,
      phase: seat.phase.kind,
      wreckTimer: seat.phase.kind === 'wrecked' ? seat.phase.timer : 0,
      throttle: seat.lastControls.throttle,
      ackTick: acks[seat.index] ?? -1,
      lock: lockOf(seat),
    }))
    const squadronStates: SquadronState[] = pilots.map((pilot) => ({
      id: pilotIds.get(pilot) ?? 0,
      spec: pilot.ship.spec.id,
      ship: readShip(pilot.ship),
    }))
    const boltStates: WorldSnapshot['bolts'] = []
    bolts.each((slot, b) => {
      boltStates.push({
        slot,
        pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z },
        prev: { x: b.prev.x, y: b.prev.y, z: b.prev.z },
        vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z },
        faction: b.faction,
        color: { x: b.color.r, y: b.color.g, z: b.color.b },
      })
    })
    return {
      tick,
      seed: runSeed,
      elapsed,
      active,
      paused,
      queued: queuedCount(),
      seats: seatStates,
      feed: feed.map((e) => ({ ...e })),
      squadron: squadronStates,
      bolts: boltStates,
      pods: environment.pickups.pods.map((pod) => ({ live: pod.live, respawnIn: pod.respawnIn })),
      mines: environment.minefield.mines.map((mine) => mine.live),
    }
  }

  /**
   * Become the host's world for this tick.
   *
   * Everything a snapshot carries is written; nothing it does not carry is
   * touched, so the AI brains, the queue and the RNG streams stay whatever they
   * were — which for a mirror is empty and unused. Squadron hulls are created and
   * retired as ids come and go, and the presentation the host's own tick would
   * have produced along the way — warp-in, a retired hull's explosion, a seat's
   * death sequence — is produced here from the transitions instead.
   */
  function apply(s: WorldSnapshot): void {
    if (s.seats.length !== seats.length) {
      throw new RangeError(`snapshot has ${s.seats.length} seat(s), this match has ${seats.length}`)
    }
    mirrored = true
    mirroredQueued = s.queued
    tick = s.tick
    elapsed = s.elapsed
    active = s.active
    paused = s.paused

    /* Squadron: match hulls to ids. */
    const seen = new Set<number>()
    for (const hull of s.squadron) {
      seen.add(hull.id)
      let pilot = pilots.find((p) => pilotIds.get(p) === hull.id)
      if (!pilot) {
        const ship = new Ship(SHIPS[hull.spec], FACTION_AI)
        ship.position.set(hull.ship.position.x, hull.ship.position.y, hull.ship.position.z)
        ship.quaternion.set(
          hull.ship.quaternion.x,
          hull.ship.quaternion.y,
          hull.ship.quaternion.z,
          hull.ship.quaternion.w,
        )
        scene.add(ship.visual.group)
        pilot = new EnemyPilot(ship)
        pilotIds.set(pilot, hull.id)
        pilots.push(pilot)
        fx.warpIn(ship.position, ship.accent)
        audio.warp()
      }
      writeShip(pilot.ship, hull.ship)
    }
    for (let i = pilots.length - 1; i >= 0; i--) {
      const pilot = pilots[i]
      if (seen.has(pilotIds.get(pilot) ?? -1)) continue
      const ship = pilot.ship
      // A hull the host stopped sending was retired, and a hull is retired dead.
      fx.explode(ship.position, ship.accent, ship.spec.id === 'drone' ? 1.5 : 1.1)
      audio.explosion(ship.spec.id === 'drone')
      scene.remove(ship.visual.group)
      ship.dispose()
      pilotIds.delete(pilot)
      pilots.splice(i, 1)
    }
    refreshTargets()

    /* Seats. */
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i]
      const state = s.seats[i]
      const ship = seat.ship
      writeShip(ship, state.ship)
      // The HUD reads the seat's flown throttle, and a mirror flies nothing.
      seat.lastControls.throttle = state.throttle
      acks[i] = state.ackTick
      seat.score = state.score
      seat.kills = state.kills
      seat.multiplier = state.multiplier
      seat.hits = state.hits
      seat.deaths = state.deaths

      const was = seat.phase.kind
      if (state.phase === 'wrecked') {
        if (was !== 'wrecked') {
          seat.lockedTarget = null
          seat.phase = {
            kind: 'wrecked',
            timer: state.wreckTimer,
            nextBlast: 0,
            emissive: ship.visual.hullMat.emissive.clone(),
          }
          ship.visual.group.visible = true
          ship.visual.thrusterMat.opacity = 0
          if (seat === local()) hud.callout('HULL BREACH', '#ff3b4e', 3)
        }
        const wreck = seat.phase as Extract<SeatPhase, { kind: 'wrecked' }>
        wreck.timer = state.wreckTimer
        const g = ship.visual.group
        if (wreck.timer < WRECK_TUMBLE) {
          // The tumble is cosmetic and the host's spin is not sent, so it is
          // rebuilt here from the clock rather than integrated tick by tick.
          _spin.set(WRECK_PITCH * wreck.timer, WRECK_YAW * wreck.timer, WRECK_ROLL * wreck.timer)
          _spinQuat.setFromEuler(_spin)
          g.quaternion.copy(ship.quaternion).multiply(_spinQuat).normalize()
          ship.visual.hullMat.emissive.copy(wreck.emissive).lerp(WRECK_HOT, wreck.timer / WRECK_TUMBLE)
        } else if (g.visible) {
          g.visible = false
        }
        fireDueBlasts(seat, seat === local())
      } else if (state.phase === 'eliminated') {
        seat.phase = ELIMINATED
        ship.visual.group.visible = false
      } else if (was !== 'flying') {
        seat.phase = FLYING
        seat.lockedTarget = null
        ship.visual.group.visible = true
        // No previous transform to interpolate from on the tick a seat returns.
        ship.prevPosition.copy(ship.position)
        ship.prevQuaternion.copy(ship.quaternion)
        if (seat === local()) {
          chase.reset(ship)
          hud.callout('RESPAWN', '#6be6ff', 1.2)
        }
      }
    }
    // Locks resolve after every hull exists.
    for (let i = 0; i < seats.length; i++) seats[i].lockedTarget = resolveLock(s.seats[i].lock)

    // The feed: whatever this snapshot carries that has not been shown. Kept
    // as the host's ring so a re-capture is the host's bytes.
    for (const e of s.feed) {
      if (e.seq > feedSeen) {
        feedSeen = e.seq
        announceKill(e)
      }
    }
    feed = s.feed.map((e) => ({ ...e }))
    feedSeq = feed.length > 0 ? feed[feed.length - 1].seq : feedSeq

    bolts.restore(s.bolts)

    const pods = environment.pickups.pods
    for (let i = 0; i < pods.length && i < s.pods.length; i++) {
      pods[i].live = s.pods[i].live
      pods[i].respawnIn = s.pods[i].respawnIn
    }
    const mines = environment.minefield.mines
    for (let i = 0; i < mines.length && i < s.mines.length; i++) mines[i].live = s.mines[i]
  }

  /**
   * What a finished cutscene hands over to.
   *
   * The two policies meet here and nowhere else, which is the point of doing it
   * this way: with respawn the seat comes back, without it it stays dead. Both
   * exits are unconditional once the timer is up, so a match cannot sit in a
   * cutscene waiting for a result that never arrives.
   */
  function resolveWreck(seat: Participant): void {
    if (respawns) {
      respawnSeat(seat)
      return
    }

    // Elimination, and it is its own phase rather than an absent wreck. Reusing
    // `null` for "never died" and "died, cutscene over" is what let the tick
    // restart an eliminated seat's cutscene every 2.4 seconds — see `SeatPhase`.
    seat.phase = ELIMINATED
    seat.ship.visual.group.visible = false

    // The run is over when every seat is out — *not* when the seat being drawn
    // dies, which is the reading that first suggests itself and is wrong. With one
    // seat the two are the same sentence. With more than one, tying it to `local`
    // would mean two machines watching one match resolved it at different moments,
    // which is presentation deciding an outcome. What the local seat still decides
    // is what the *report* says, because `RunResult` is one participant's run; when
    // it ends is the match's business.
    //
    // "Every seat is out" and not "nobody is flying", which is the weaker test this
    // replaces: a seat still mid-cutscene is neither flying nor finished, so the
    // first wreck to resolve used to call `finish` — and `clearArena` with it —
    // straight through a second wreck that was 85 ticks into its own 144. The
    // match waits for every cutscene it started.
    if (!matchStillRunning()) finish(pendingResult ?? sealResult(false))
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
  function step(intents: readonly Controls[]): void {
    const live = active && !paused && seats.length > 0

    /*
     * Refused before anything moves, including the environment.
     *
     * The check used to sit after `environment.step`, so a rejected tick still
     * advanced the world clock — mine and pod respawn timers among it. A caller
     * that caught the error and retried with the right array therefore advanced the
     * environment twice for one tick of simulation. A call that throws must cost
     * nothing.
     */
    if (live && intents.length !== seats.length) {
      throw new RangeError(
        `step needs one intent per seat: got ${intents.length} for ${seats.length} seat(s)`,
      )
    }

    /*
     * The environment advances only while the match does.
     *
     * It used to run before the early return, so a paused game kept its pod respawn
     * clocks ticking and a player who paused for a minute came back to a re-armed
     * arena. That predates the roster — byte for byte the same on the base commit —
     * and it is fixed here because this is the line the roster work moved, and
     * leaving a known-wrong neighbour untouched is how it gets inherited again.
     */
    if (!live) return
    environment.step(STEP)

    elapsed += STEP
    tick++

    /* Spawning */
    if (spawnTimer > 0) spawnTimer -= STEP
    while (pilots.length < MAX_ACTIVE && queue.length > 0 && spawnTimer <= 0) {
      spawnEnemy()
      spawnTimer = SPAWN_INTERVAL
    }

    /* The roster. A wreck tumbles instead of flying; everyone else flies on the
       intent supplied for their seat, whoever supplied it. */
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i]
      if (seat.phase.kind === 'wrecked') {
        stepWreck(seat, STEP)
        continue
      }
      if (seat.phase.kind === 'eliminated' || !seat.ship.alive) continue
      recordControls(seat, intents[i])
      // The hull flies the *record*, not the caller's struct: admission — `aim`
      // dropped, `spread` zeroed — happens in `recordControls`, and flying its
      // output is what makes the record the truth rather than a copy of it.
      seat.ship.step(seat.lastControls, STEP, ctx)
    }

    /* Enemies. Each pilot thinks and immediately steps, so `controls.aim` is
       consumed before the next pilot's turn. */
    squadron.length = 0
    for (const pilot of pilots) squadron.push(pilot.ship)
    for (const pilot of pilots) {
      const quarry = nearestSeat(pilot.ship.position)
      if (!quarry) continue
      const controls = pilot.think(quarry, squadron, avoidList, STEP)
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

    /* Target lock, per seat. Simulation rather than display: the lock decides
       which hull the lead solution is computed against, `onTarget` gates the
       reticle a pilot shoots on, and `snapshot(seat)` reports the bearing a
       scripted pilot flies. Every seat gets one, not just the drawn one — a host
       that only locked for the participant it happened to be watching would
       hand a different fight to every machine. */
    for (const seat of seats) acquireTarget(seat)

    /* Instruments. All of this is the *local* seat's, and all of it is gated on
       that seat being alive: an alarm beating over your own explosion is what
       the old early-return prevented by accident, and the merged loop has to
       prevent it on purpose. */
    const watcher = local()
    if (watcher && watcher.ship.alive) {
      const self = watcher.ship

      if (self.hullFraction <= CRITICAL_HULL) {
        alarmTimer -= STEP
        if (alarmTimer <= 0) {
          audio.alarm()
          alarmTimer = 1.4
        }
      }

      /* Solar proximity. The alarm tightens as the hull heats, so the interval
         itself tells you whether you are getting out or getting worse. */
      const exposure = self.solarExposure
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
      if (self.overdriven && self.overdriveTimer <= TIMED_WARN_AT && !overdriveWarned) {
        overdriveWarned = true
        audio.alarm()
      }
      if (self.shielded && self.shieldTimer <= TIMED_WARN_AT && !shieldWarned) {
        shieldWarned = true
        audio.alarm()
      }
    }

    retireDead()

    /* Resolution.
       A seat that has just died hands its hull to a wreck; a wreck that has
       finished either comes back or ends the run. Ordered this way round so a
       death costs the full `DEATH_SEQUENCE`: checking the timer first would let a
       seat that died this very tick resolve on the same tick it started. */
    for (const seat of seats) {
      if (seat.phase.kind === 'flying' && !seat.ship.alive) beginDeathSequence(seat)
    }
    for (const seat of seats) {
      if (seat.phase.kind === 'wrecked' && seat.phase.timer >= DEATH_SEQUENCE) resolveWreck(seat)
      if (!active) return
    }

    /* A cleared squadron is still the win, and still the only one. What it means
       with more than one seat in the arena — shared, first past a post, highest
       score — is a match rule, and match rules are milestone 8.

       Gated on nobody being mid-cutscene as well as somebody being alive, and both
       halves are load-bearing. The squadron can empty on the very tick a seat dies
       — one mine takes the last hostile and a participant together — and a win
       reported over a wreck both hands a loss a victory banner and truncates the
       explosion, because `finish` clears the arena. Before the tick was merged this
       was unreachable rather than handled: the cutscene returned early, so the win
       branch could not run while anybody was dying. */
    if (queue.length === 0 && pilots.length === 0 && anySeatFlying() && !anySeatWrecked()) {
      /*
       * A sealed result outranks a fresh one, and the case is not hypothetical.
       *
       * In a two-seat match without respawn, the drawn seat can be eliminated — sealing
       * its loss — and a surviving participant can then clear the squadron. Reporting
       * `sealResult(true)` there hands a dead participant the win: their own run ended
       * at their death, and a teammate finishing the job afterwards is not their
       * victory. It also computes the win bonuses off a hull that is at zero.
       *
       * `pendingResult` is only ever set by the local seat's death in a match without
       * respawn, so preferring it changes nothing for the single-seat game — where the
       * only way to reach this branch is to still be alive, and `pendingResult` is null.
       */
      if (!pendingResult) hud.callout('SECTOR CLEAR', '#b6ff3d', 3)
      finish(pendingResult ?? sealResult(true))
    }
  }

  /** At least one seat is alive and not mid-cutscene. */
  function anySeatFlying(): boolean {
    for (const seat of seats) {
      if (seat.phase.kind === 'flying' && seat.ship.alive) return true
    }
    return false
  }

  /** At least one seat's explosion is still playing. */
  function anySeatWrecked(): boolean {
    for (const seat of seats) {
      if (seat.phase.kind === 'wrecked') return true
    }
    return false
  }

  /**
   * At least one seat is not finished with the match.
   *
   * Deliberately not "somebody is flying": a seat mid-cutscene is neither flying
   * nor done, and treating it as done is what let one wreck's resolution clear
   * another wreck out from under itself.
   */
  function matchStillRunning(): boolean {
    for (const seat of seats) {
      if (seat.phase.kind !== 'eliminated') return true
    }
    return false
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

    /* Nothing is advancing, so nothing is worth re-posing: a varying alpha
       against a frozen simulation would swing every hull back and forth between
       the last two ticks. Leaving the meshes where the final frame drew them is
       both correct and cheaper. */
    const watcher = local()
    if (!active || paused || !watcher) {
      fx.update(frameDt, camera)
      hud.tick(frameDt)
      return
    }

    /* Every hull, at one blend.

       `syncVisual` is deliberately not called for a *wreck* — it would overwrite
       the accumulated tumble with the ship's own unrotated quaternion — so a
       wreck's position is interpolated here by hand, at the same `alpha` as
       everything else in the frame. Skipping that is a real artefact rather than
       a theoretical one: the camera is locked to the wreck, so a wreck sitting on
       raw tick positions while the camera moves smoothly shimmers against the one
       thing the player is looking at.

       Which hulls those are is now a per-seat question rather than a mode the
       whole frame is in, and the invariant is the same either way: everything
       drawn in one frame depicts one instant. */
    for (const seat of seats) {
      if (seat.phase.kind === 'wrecked') {
        seat.ship.visual.group.position.lerpVectors(
          seat.ship.prevPosition,
          seat.ship.position,
          alpha,
        )
      } else {
        seat.ship.syncVisual(alpha)
      }
    }
    for (const pilot of pilots) pilot.ship.syncVisual(alpha)
    bolts.render(alpha)

    fx.update(frameDt, camera)
    // After `syncVisual`, and at the same blend, so the camera follows the pose
    // actually on screen rather than the tick-quantized one behind it.
    chase.update(watcher.ship, frameDt, alpha)

    refreshContacts()

    /* The instruments stay frozen where `beginDeathSequence` left them while the
       local seat's wreck is on screen. Everything above still runs, because the
       arena is still moving and the camera is still following the wreck. */
    if (watcher.phase.kind === 'wrecked') {
      hud.updateContacts(contactBuffer, camera)
      hud.tick(frameDt)
      return
    }

    const self = watcher.ship
    // Hostiles left, which used to be readable straight off `contactBuffer.length`
    // because the two lists were the same list. They are not any more — another
    // seat is a contact and is not a hostile off the squadron roster — so this
    // counts the squadron instead of the markers.
    let airborne = 0
    for (const pilot of pilots) if (pilot.ship.alive) airborne++
    const remaining = queuedCount() + airborne
    const critical = self.hullFraction <= CRITICAL_HULL

    // Project the gun line so the crosshair marks where shots actually go.
    self.forward(_forward)
    _reticle.copy(self.position).addScaledVector(_forward, RETICLE_RANGE).project(camera)

    function targetReadout(seat: Participant): HudTarget | null {
      const held = seat.lockedTarget
      if (!held || !held.alive) return null
      solveLead(self, held, _lead)
      _leadNdc.copy(_lead).project(camera)
      return {
        name: held.spec.name.toUpperCase(),
        accent: held.spec.accent,
        hullFraction: held.hullFraction,
        range: held.position.distanceTo(self.position),
        leadNdcX: _leadNdc.x,
        leadNdcY: _leadNdc.y,
        leadVisible: _leadNdc.z < 1 && Math.abs(_leadNdc.x) < 1 && Math.abs(_leadNdc.y) < 1,
      }
    }

    hud.update({
      hullFraction: self.hullFraction,
      quirkValue: self.quirkValue,
      quirkAlarming: self.quirkAlarming,
      score: watcher.score,
      multiplier: watcher.multiplier,
      best,
      enemiesTotal: PER_ENEMY_TYPE * 2,
      enemiesRemaining: remaining,
      speed: self.velocity.length(),
      throttle: watcher.lastControls.throttle,
      locked: onTarget(watcher),
      critical,
      reticleNdcX: _reticle.x,
      reticleNdcY: _reticle.y,
      boundaryOvershoot: self.boundaryOvershoot,
      solarExposure: self.solarExposure,
      // Both buffs stack, so the bar is clamped: past one pod's worth the
      // fraction stops meaning anything and the seconds carry the truth.
      overdrive: self.overdriven
        ? {
            remaining: self.overdriveTimer,
            fraction: Math.min(1, self.overdriveTimer / OVERDRIVE_DURATION),
            expiring: self.overdriveTimer <= TIMED_WARN_AT,
          }
        : null,
      shield: self.shielded
        ? {
            remaining: self.shieldTimer,
            fraction: Math.min(1, self.shieldTimer / SHIELD_DURATION),
            expiring: self.shieldTimer <= TIMED_WARN_AT,
          }
        : null,
      target: targetReadout(watcher),
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
      return local()?.phase.kind === 'wrecked'
    },

    get seatCount() {
      return seats.length
    },

    start(setup) {
      /*
       * Everything that can refuse the setup happens before anything is torn down.
       *
       * `clearArena` used to run first, so a refused roster left the previous match
       * disposed and replaced by nothing: `active` still true, `seatCount` zero, a
       * blank zombie that `step` silently skipped forever. A call that throws has to
       * leave the running match exactly as it found it.
       */
      const specs = setup.ships.map((id) => SHIPS[id])
      for (let i = 0; i < specs.length; i++) {
        if (!specs[i]) throw new RangeError(`seat ${i} asks for an unknown hull: ${setup.ships[i]}`)
      }
      const seed = (setup.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0
      // Built before the teardown for the same reason — `createSeats` refuses an
      // empty roster, and that refusal must not cost the caller their match.
      const built = createSeats(specs, seed)

      clearArena()

      // Every stream this match draws from hangs off the seed, and must be built
      // before anything draws — `shuffled` below is the first customer.
      runSeed = seed
      pilotsSpawned = 0
      spawnRng = subRng(runSeed, STREAM.spawn)
      respawnRng = subRng(runSeed, STREAM.respawn)

      respawns = setup.respawn ?? false
      seats = built
      acks = seats.map(() => -1)
      localIndex = drawnSeatIndex(setup.local, seats.length)
      feed = []
      feedSeq = 0
      feedSeen = 0
      ctx.localFaction = seats[localIndex].faction

      for (const seat of seats) {
        const ship = seat.ship
        launchPoint(seat.index, seats.length, _spawnPos)
        ship.spawn(_spawnPos, PLAYER_SPAWN_LOOK)

        // A participant's hull pays like any other: the hit to whoever landed it,
        // the kill to whoever is owed it (`bountyGoesTo`), at `PARTICIPANT_BOUNTY_MULT`
        // times the airframe's bounty. Never to the victim, whoever the arena
        // blames: a seat cannot profit from its own death.
        ship.onDamaged = (self, amount, from) => {
          const direct = seatOf(seats, from)
          if (direct && direct !== seat) {
            lastHitter.set(self, direct)
            creditHit(direct, amount)
          }
          // Feedback is the drawn seat's, and only the drawn seat's. Another
          // participant being hit shakes their camera, on their machine.
          if (seat !== local()) return
          hud.flashDamage()
          audio.hullHit()
          chase.shake(Math.min(1.6, 0.25 + amount * 0.02))
        }
        ship.onDeath = (self, from) => {
          const owed = bountyGoesTo(from, self)
          const scorer = owed && owed !== seat ? owed : null
          const award = scorer ? creditKill(scorer, Math.round(self.spec.bounty * PARTICIPANT_BOUNTY_MULT)) : 0
          recordKill(scorer, from, seat, self.spec.id, award)
        }
        // A shielded hit has to feel like *something* or the player cannot tell
        // the shield from a lull in enemy fire. Deliberately a much smaller nudge
        // than a hull hit, and no red flash: this is the good outcome.
        ship.onShielded = (self, amount) => {
          fx.spark(self.position, PICKUP_FLASH.shield, 10)
          if (seat !== local()) return
          chase.shake(Math.min(0.35, 0.06 + amount * 0.004))
        }
        ship.onCollide = (_self, speed) => {
          if (seat !== local()) return
          hud.callout('HULL SCRAPE', '#ffb020', 0.8)
          chase.shake(Math.min(2.4, speed * 0.006))
        }
        scene.add(ship.visual.group)
      }

      const localSpec = seats[localIndex].ship.spec

      /*
       * The squadron is drawn from the hulls **seat 0** is not flying.
       *
       * Single-player has always fought the two airframes it did not pick, and with
       * one seat this is exactly that. The rule cannot generalise as written — with
       * three seats flying three hulls there is nothing left to fill the arena with
       * — and who the arena fills with is a lobby decision, milestone 9.
       *
       * What matters is that it is keyed on a *roster* position and not on the drawn
       * one. It was `otherShips(localSpec.id)`, which made the enemy hulls a
       * function of who was watching: same roster, same seed, same intents, and a
       * different squadron on each machine. Reproduced across seven seeds — six
       * diverged, and the one my presentation check happened to use was the one that
       * did not. Seat 0 is arbitrary in the same way `bountyGoesTo`'s fallback is
       * arbitrary, and deterministic in the way that matters.
       */
      const squad: ShipId[] = []
      for (const id of otherShips(seats[0].ship.spec.id)) {
        for (let i = 0; i < PER_ENEMY_TYPE; i++) squad.push(id)
      }
      queue = shuffled(squad)
      pilots = []
      refreshTargets()

      spawnTimer = OPENING_CALM
      elapsed = 0
      tick = 0
      alarmTimer = 0
      searAlarmTimer = 0
      wasSearing = false
      overdriveWarned = false
      shieldWarned = false
      pendingResult = null
      best = deps.bestScoreFor(localSpec.id)

      environment.minefield.reset()
      environment.pickups.reset()
      rebuildAvoidList()

      hud.setShip(localSpec)
      hud.show()
      hud.callout('ENGAGE', `#${localSpec.accent.toString(16).padStart(6, '0')}`, 1.6)
      chase.reset(seats[localIndex].ship)

      active = true
      paused = false
    },

    step,
    render,

    pause() {
      /*
       * Never mid-death: freezing here strands the player in a paused explosion,
       * with a debrief queued behind it or a respawn that never comes.
       *
       * Asked of the *roster* rather than of the drawn seat, which is the third
       * outcome `local` was reaching. `paused` stops the whole simulation, so a
       * guard that consulted the drawn seat meant the same match in the same state
       * — one wreck, one hull still flying — could be frozen from one machine and
       * not from another. With one seat the two readings are the same sentence.
       */
      if (!active || anySeatWrecked()) return false
      paused = true
      input.reset()
      input.releasePointerLock()
      return true
    },

    resume() {
      if (!active) return
      paused = false
      input.reset()
    },

    snapshot(at = localIndex) {
      const seat = seats[at]
      if (!seat) return null
      const self = seat.ship

      /** World point → yaw/pitch in this seat's own frame. */
      function bearingTo(point: THREE.Vector3): { yaw: number; pitch: number } {
        _toEnemy.subVectors(point, self.position)
        _inverseQuat.copy(self.quaternion).invert()
        _toEnemy.applyQuaternion(_inverseQuat)
        return {
          yaw: Math.atan2(_toEnemy.x, -_toEnemy.z),
          pitch: Math.atan2(_toEnemy.y, Math.hypot(_toEnemy.x, _toEnemy.z)),
        }
      }

      let bearing: RunSnapshot['target'] = null
      const held = seat.lockedTarget
      if (held && held.alive) {
        solveLead(self, held, _lead)
        bearing = {
          ...bearingTo(_lead),
          range: held.position.distanceTo(self.position),
          hull: held.hullFraction,
        }
      }

      const nearestPods = Object.fromEntries(
        PICKUP_KINDS.map((k) => [k, null]),
      ) as RunSnapshot['pickups']
      for (const pod of environment.pickups.pods) {
        if (!pod.live) continue
        const range = pod.position.distanceTo(self.position)
        const nearer = nearestPods[pod.kind]
        if (nearer && nearer.range <= range) continue
        nearestPods[pod.kind] = { ...bearingTo(pod.position), range }
      }

      return {
        seed: runSeed,
        seat: seat.index,
        seats: seats.length,
        phase: seat.phase.kind,
        deaths: seat.deaths,
        score: seat.score,
        kills: seat.kills,
        multiplier: seat.multiplier,
        hits: seat.hits,
        shotsFired: self.shotsFired,
        hull: self.hull,
        speed: self.velocity.length(),
        position: { x: self.position.x, y: self.position.y, z: self.position.z },
        throttle: seat.lastControls.throttle,
        enemiesAirborne: pilots.length,
        enemiesQueued: queuedCount(),
        elapsed,
        solarExposure: self.solarExposure,
        overdrive: self.overdriveTimer,
        shield: self.shieldTimer,
        target: bearing,
        pickups: nearestPods,
      }
    },

    capture,
    apply,
    predict,
    reconcile,
    acknowledge,
    coast,

    cycleTarget() {
      const seat = local()
      if (!seat) return
      const live = lockCandidates(seat, candidateBuffer).slice()
      if (live.length === 0) {
        seat.lockedTarget = null
        return
      }
      const index = seat.lockedTarget ? live.indexOf(seat.lockedTarget) : -1
      seat.lockedTarget = live[(index + 1) % live.length]
    },

    abandon() {
      active = false
      paused = false
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
