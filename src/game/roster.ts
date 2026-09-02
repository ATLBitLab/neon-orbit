/**
 * The participant roster — the thing that replaces the singular `player`.
 *
 * A *participant* is a seat in the match: a hull, a faction, and the scoreline
 * that hull earns. Before this there was one human and the arena was written
 * around them — `player.position` anchored enemy arrivals, one `score` counter
 * held the run, and `player.alive` was the run's own liveness. All three were
 * the same assumption wearing different names, and PvP breaks all three at once.
 *
 * What a seat is *not* is a kind of pilot. A seat does not know whether its
 * controls come from a keyboard, a recorded stream or another browser — that is
 * the whole point of `Controls` being the boundary, settled at milestone 1 — so
 * nothing in here mentions humans except to say that the AI squadron is not in
 * this list yet. Backfill (milestone 9) is what merges them, and the note on
 * `Roster` says what that costs.
 */

import * as THREE from 'three'
import { STREAM, subRng } from '../core/rng'
import type { ShipSpec } from '../ships/specs'
import { PLAYER_SPAWN } from '../world/environment'
import { humanFaction, type Faction } from './bolts'
import { LAUNCH_THROTTLE } from './controls'
import { Ship, type Controls } from './ship'

/**
 * Where a seat is in its life, as one field with three shapes.
 *
 * Death is a per-seat state rather than a mode the whole game enters. That is the
 * substantive change here, not a tidy-up: the previous version returned early from
 * the tick and ran a second, parallel copy of the arena loop inside the cutscene,
 * which works for exactly one dying participant and cannot be made to work for two.
 *
 * **One field rather than a nullable wreck**, and that is a bug fix rather than a
 * preference. The first version of this carried `wreck: Wreck | null` and used
 * `null` for two different things — "flying" and "cutscene finished, staying
 * dead" — so a seat that had been eliminated was indistinguishable from one that
 * had never died. The tick's own "this hull is dead and has no wreck, start its
 * cutscene" rule then fired again on the very next tick, and an eliminated seat
 * re-entered its own death sequence every 2.4 seconds: `deaths` climbing 1, 2, 3
 * while the participant sat there dead, re-sealing the local result each time.
 * Reproduced before the fix, and it is now unrepresentable rather than guarded
 * against — `eliminated` is not `flying`, so nothing can read it as one.
 */
export type SeatPhase =
  | { readonly kind: 'flying' }
  | {
      readonly kind: 'wrecked'
      /** Seconds since the fatal hit. */
      timer: number
      /** Index of the next entry in the detonation timeline still to fire. */
      nextBlast: number
      /** Hull emissive at the moment of death, cooked toward white from there. */
      readonly emissive: THREE.Color
    }
  | { readonly kind: 'eliminated' }

export const FLYING: SeatPhase = { kind: 'flying' }
export const ELIMINATED: SeatPhase = { kind: 'eliminated' }

export interface Participant {
  /**
   * Position in the roster. Also the faction, by construction — see
   * `humanFaction`. Nothing may derive one from a search; see `seatOf`.
   */
  readonly index: number
  readonly faction: Faction
  /**
   * The hull. Not replaced on respawn: `Ship.spawn` resets flight state and
   * leaves the scoreline alone, which is exactly a respawn, and reusing the
   * object keeps the mesh, the material and the scene membership stable.
   */
  readonly ship: Ship

  score: number
  kills: number
  /** Streak bonus, rebuilt from `kills`. Per seat, so streaks are personal. */
  multiplier: number
  /** Bolts that reached a hull. The numerator of the accuracy stat. */
  hits: number
  /** Times this seat has been killed. Zero in a match without respawn. */
  deaths: number

  /**
   * The hostile this seat is holding, if any.
   *
   * Per seat rather than per game, and computed for every seat rather than only
   * the presented one: the lock decides which hull the lead solution is drawn
   * against, and `snapshot(seat)` reports that bearing — which is what lets a
   * scripted pilot fly a seat it is not watching. It gates no damage, so it is
   * an aiming aid and not an outcome.
   */
  lockedTarget: Ship | null

  phase: SeatPhase

  /**
   * A *copy* of the controls this seat last flew on.
   *
   * Copied, not referenced, and that rule is now per seat. `Pilot` and
   * `EnemyPilot` both reuse one struct across ticks, so retaining a caller's
   * object makes this a live view of whatever the producer is doing *now*
   * instead of what the tick actually simulated — and on a client those differ
   * by a round trip. It also matters more than it used to: with a seat per
   * participant, a host that retained N of them would be holding N aliases of
   * one struct and would replay the last tick for everybody.
   */
  readonly lastControls: Controls
}

/**
 * Every seat in the match, plus which one this machine is presenting.
 *
 * `local` is presentation only. It picks the camera, the HUD, the alarms and the
 * gun pitch, and it must not reach any decision — a host simulating four seats
 * has to arrive at the same fight whichever one it happens to be drawing.
 *
 * Not yet holding the AI. The squadron is still a separate `EnemyPilot[]` with
 * its own arrival queue and its own win condition, and merging the two is
 * milestone 9's job rather than a free rename: an NPC seat needs the queue to
 * become seat assignment, the "cleared roster" win to become a match rule, and
 * an arriving human to be able to take a seat that is already flying. All three
 * are decisions, so none of them are made here.
 */
export interface Roster {
  readonly seats: readonly Participant[]
  readonly local: Participant
  /** Death returns a seat to the arena instead of resolving the run. */
  readonly respawn: boolean
}

/**
 * The seat holding `faction`, or `undefined`.
 *
 * This is the counterpart to `humanFaction` and the reason the roster can carry
 * a throwing constructor safely. `humanFaction` refuses anything that is not a
 * real roster index — the right call, since there is no stand-in for a
 * participant — but a guard that throws makes its caller's error handling
 * load-bearing, and this is the caller. Damage arrives carrying a `Faction` that
 * may well belong to nobody: the AI faction, or the arena blaming a mine on a
 * side that does not exist.
 *
 * So resolution goes *this* way round — faction to seat, by lookup, returning
 * nothing on a miss — and never `humanFaction(seats.indexOf(...))`, which is the
 * line that mints `FACTION_AI` from an `indexOf` miss and puts a human on the
 * NPC side. A miss here means "nobody is credited", which is a real answer.
 */
export function seatOf(
  seats: readonly Participant[],
  faction: Faction,
): Participant | undefined {
  for (const seat of seats) {
    if (seat.faction === faction) return seat
  }
  return undefined
}

/** True when `faction` belongs to a seat in the match. */
export function isParticipant(seats: readonly Participant[], faction: Faction): boolean {
  return seatOf(seats, faction) !== undefined
}

function freshControls(): Controls {
  return {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: LAUNCH_THROTTLE,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
  }
}

/**
 * Build the seats for a match.
 *
 * Seat `i` flies faction `i`, minted through `humanFaction` rather than cast, so
 * the identity `faction === index` is established in one place and every seat in
 * the game is findable by grep. `specs` is in seat order and must not be empty —
 * a match with no seats has nothing to simulate, nothing to draw and no result
 * to report, so it is refused here rather than producing a game that is
 * `active` and blank.
 */
export function createSeats(specs: readonly ShipSpec[], runSeed: number): Participant[] {
  if (specs.length === 0) {
    throw new RangeError('a match needs at least one seat')
  }

  return specs.map((spec, index) => {
    // Seat `i` draws its gun spread from `playerGuns + i`, so seat 0 keeps the
    // exact stream the single player has always used and a new seat cannot shift
    // an existing one. The offset stays clear of `enemyGuns` by thousands of
    // labels — see the collision note in `core/rng.ts`, which is the bug this
    // spacing exists to avoid repeating.
    const ship = new Ship(spec, humanFaction(index), subRng(runSeed, STREAM.playerGuns + index))
    return {
      index,
      faction: humanFaction(index),
      ship,
      score: 0,
      kills: 0,
      multiplier: 1,
      hits: 0,
      deaths: 0,
      lockedTarget: null,
      phase: FLYING,
      lastControls: freshControls(),
    }
  })
}

/**
 * Copy this tick's intent into the seat, without retaining the caller's object —
 * and, since milestone 4, this copy is what the seat's hull actually flies.
 *
 * The record and the simulated intent used to be two things: `step` copied the
 * caller's struct here and then flew the caller's struct. Now `Game.step` flies
 * `seat.lastControls`, so "what was recorded" and "what was simulated" are one
 * object by construction, and this function is where a seat's intent is *admitted*
 * rather than merely noted. Two fields do not survive admission, deliberately:
 *
 * - **`aim` is dropped.** It is the AI's lead solution and the AI never sits in a
 *   seat. Left in the struct that is about to become the packet format, it is a
 *   fire-direction override: a sender who sets one vector shoots wherever they
 *   like regardless of where the nose points. A seat shoots along its nose, full
 *   stop, and the flight model reads `null` as exactly that.
 * - **`spread` is zeroed.** The only legal value for a seat is already zero, so
 *   this changes nothing for any producer that exists — but a positive spread
 *   also *draws from the seat's gun RNG*, so a remote sender could desynchronise
 *   the fight for everyone by supplying one. Zero draws nothing.
 *
 * Deflection and throttle are *not* bounded here: `Ship` clamps them itself, and
 * a rule with two implementations is the defect this repository keeps finding.
 * Rate-limiting the throttle is a wire-boundary policy and lives in
 * `admitIntent` — see `intent.ts` for why it is not applied to every caller.
 */
export function recordControls(seat: Participant, c: Controls): void {
  const held = seat.lastControls
  held.pitch = c.pitch
  held.yaw = c.yaw
  held.roll = c.roll
  held.throttle = c.throttle
  held.fire = c.fire
  held.dash = c.dash
  held.aim = null
  held.spread = 0
}

/**
 * Credit a landed bolt: the damage as points, and one more hit for accuracy.
 *
 * The bounty for the kill is separate — see `creditKill` — because the two have
 * different answers to "and if nobody did it": a hit with no author scores
 * nothing, while a hostile that flies into the star still clears the roster.
 */
export function creditHit(seat: Participant, amount: number): void {
  seat.hits++
  creditDamage(seat, amount)
}

/**
 * Credit damage that was not a bolt — a mine or a scrape the seat is owed
 * for (`hitCredit` in `game.ts`). Points, but not a hit: accuracy is bolts
 * landed over bolts fired, and a mine is neither.
 */
export function creditDamage(seat: Participant, amount: number): void {
  seat.score += Math.round(amount)
}

/** Credit a kill and advance the streak. */
export function creditKill(seat: Participant, bounty: number): number {
  seat.kills++
  seat.multiplier = Math.min(3, 1 + seat.kills * 0.25)
  const award = Math.round(bounty * seat.multiplier)
  seat.score += award
  return award
}

/** The accuracy stat for one seat, 0 when it has not fired. */
export function accuracyOf(seat: Participant): number {
  const shots = seat.ship.shotsFired
  return shots > 0 ? Math.min(1, seat.hits / shots) : 0
}

const _launchAxis = new THREE.Vector3(0, 1, 0)

/**
 * Where seat `index` of `count` launches from.
 *
 * Seat 0 gets `PLAYER_SPAWN` itself — the arena's designated spawn, chosen to
 * face the middle with a clear run in — and the rest are spaced evenly around
 * the same ring so a two-seat match does not start with both hulls inside each
 * other. Returned directly for seat 0 rather than as a zero rotation of itself,
 * because it is a designated point rather than a derived one.
 */
export function launchPoint(index: number, count: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(PLAYER_SPAWN)
  if (index === 0) return out
  return out.applyAxisAngle(_launchAxis, (index / count) * Math.PI * 2)
}
