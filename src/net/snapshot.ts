/**
 * The world, as the host sends it.
 *
 * A snapshot is everything a client needs to *draw* the match this tick, and
 * nothing it would need to *continue* it. That line is the design: under a
 * host-authoritative model the client never runs the host's simulation
 * forward, so the AI's brains, the RNG streams, the spawn queue's contents and
 * every private timer stay on the host. What crosses is the visible state of
 * every hull, the scoreline of every seat, the bolt pool by slot, and the
 * arena's pods and mines.
 *
 * Plain data, no three.js types. `capture` on the game fills one of these from
 * live objects and `apply` writes one back into them; `encode`/`decode` turn
 * one into bytes and back. Both directions are total: a snapshot that encodes
 * decodes to an equal snapshot (at float32), and a snapshot the mirror
 * re-captures after `apply` encodes to the *same bytes* — which is the test
 * that pins every field, because a field the mirror dropped would come back
 * different.
 *
 * Squadron ships carry `id`, the order in which the host spawned them, so a
 * mirror can tell "the same Wasp, moved" from "a new Wasp where the old one
 * was" and create or retire hulls as ids come and go. Seats need no id: they
 * are the roster, in order, and the mirror built the same one from the same
 * `MatchSetup`.
 */

import { FACTION_AI, type Faction } from '../game/bolts'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import { ByteReader, ByteWriter } from './wire'

export const SNAPSHOT_VERSION = 2

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

/** The visible state of one hull. Every field here is read by `syncVisual` or the HUD. */
export interface ShipState {
  position: Vec3
  quaternion: Quat
  velocity: Vec3
  speed: number
  hull: number
  throttle: number
  alive: boolean
  warpTimer: number
  flash: number
  sinceHit: number
  heat: number
  heatLocked: number
  dashTimer: number
  dashCooldown: number
  overdriveTimer: number
  shieldTimer: number
  solarExposure: number
  shotsFired: number
}

/** Who a seat is holding: nobody, a seat, or a squadron ship by id. */
export type LockRef = { kind: 'none' } | { kind: 'seat'; index: number } | { kind: 'squadron'; id: number }

export interface SeatState {
  ship: ShipState
  score: number
  kills: number
  multiplier: number
  hits: number
  deaths: number
  phase: 'flying' | 'wrecked' | 'eliminated'
  /** Seconds into the death sequence; zero unless `wrecked`. */
  wreckTimer: number
  /**
   * The throttle this seat last flew on — the seat's record, not the hull's
   * commanded value. They differ on the tick a seat respawns, and the HUD shows
   * this one.
   */
  throttle: number
  /**
   * The client intent tick this seat last flew, or -1. The host's answer to
   * "how much of what I sent have you heard?", which is what lets a predicting
   * client know which of its own intents to replay on top of this snapshot.
   */
  ackTick: number
  lock: LockRef
}

export interface SquadronState {
  id: number
  spec: ShipId
  ship: ShipState
}

export interface BoltState {
  slot: number
  pos: Vec3
  prev: Vec3
  vel: Vec3
  faction: Faction
  color: Vec3
}

/**
 * A kill, as the match announces it.
 *
 * `killer` and `victim` are seat indices, or `NOBODY` for a squadron hull and
 * `THE_ARENA` for a mine, a scrape or the star. `hull` is the victim's
 * airframe. `seq` counts up from one per match, which is what lets a mirror
 * show each kill exactly once from a stream that loses and reorders
 * snapshots: the snapshot carries the last `FEED_RING` events, and a mirror
 * announces those with a `seq` above the last it announced.
 */
export interface KillEvent {
  seq: number
  killer: number
  victim: number
  hull: ShipId
  award: number
}

/** A `KillEvent` party that is a squadron hull rather than a seat. */
export const NOBODY = -1
/** A `KillEvent` killer that is the arena: a mine, a scrape, the star. */
export const THE_ARENA = -2
/** How many of the latest kills a snapshot carries. */
export const FEED_RING = 4

export interface PodState {
  live: boolean
  respawnIn: number
}

export interface WorldSnapshot {
  tick: number
  seed: number
  elapsed: number
  active: boolean
  paused: boolean
  /** Hulls still waiting to warp in. The mirror reports it; it does not spawn them. */
  queued: number
  seats: SeatState[]
  squadron: SquadronState[]
  bolts: BoltState[]
  pods: PodState[]
  mines: boolean[]
  /** The latest kills, oldest first, at most `FEED_RING`. */
  feed: KillEvent[]
}

/* ---- Encoding ------------------------------------------------------------ */

const PHASES = ['flying', 'wrecked', 'eliminated'] as const

function writeVec3(w: ByteWriter, v: Vec3): void {
  w.f32(v.x).f32(v.y).f32(v.z)
}

function readVec3(r: ByteReader): Vec3 {
  return { x: r.f32(), y: r.f32(), z: r.f32() }
}

function writeShip(w: ByteWriter, s: ShipState): void {
  writeVec3(w, s.position)
  w.f32(s.quaternion.x).f32(s.quaternion.y).f32(s.quaternion.z).f32(s.quaternion.w)
  writeVec3(w, s.velocity)
  w.f32(s.speed).f32(s.hull).f32(s.throttle).bool(s.alive)
  w.f32(s.warpTimer).f32(s.flash).f32(s.sinceHit)
  w.f32(s.heat).f32(s.heatLocked).f32(s.dashTimer).f32(s.dashCooldown)
  w.f32(s.overdriveTimer).f32(s.shieldTimer).f32(s.solarExposure)
  w.u32(s.shotsFired)
}

function readShip(r: ByteReader): ShipState {
  return {
    position: readVec3(r),
    quaternion: { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() },
    velocity: readVec3(r),
    speed: r.f32(),
    hull: r.f32(),
    throttle: r.f32(),
    alive: r.bool(),
    warpTimer: r.f32(),
    flash: r.f32(),
    sinceHit: r.f32(),
    heat: r.f32(),
    heatLocked: r.f32(),
    dashTimer: r.f32(),
    dashCooldown: r.f32(),
    overdriveTimer: r.f32(),
    shieldTimer: r.f32(),
    solarExposure: r.f32(),
    shotsFired: r.u32(),
  }
}

function writeLock(w: ByteWriter, lock: LockRef): void {
  if (lock.kind === 'none') w.u8(0).u32(0)
  else if (lock.kind === 'seat') w.u8(1).u32(lock.index)
  else w.u8(2).u32(lock.id)
}

function readLock(r: ByteReader): LockRef {
  const kind = r.u8()
  const ref = r.u32()
  if (kind === 0) return { kind: 'none' }
  if (kind === 1) return { kind: 'seat', index: ref }
  if (kind === 2) return { kind: 'squadron', id: ref }
  throw new RangeError(`unknown lock kind ${kind}`)
}

export function encodeSnapshot(s: WorldSnapshot, w = new ByteWriter(4096)): Uint8Array {
  w.u8(SNAPSHOT_VERSION)
  w.u32(s.tick).u32(s.seed).f32(s.elapsed).bool(s.active).bool(s.paused).u16(s.queued)

  w.u8(s.seats.length)
  for (const seat of s.seats) {
    writeShip(w, seat.ship)
    w.i32(seat.score).u16(seat.kills).f32(seat.multiplier).u32(seat.hits).u16(seat.deaths)
    w.u8(PHASES.indexOf(seat.phase)).f32(seat.wreckTimer).f32(seat.throttle).i32(seat.ackTick)
    writeLock(w, seat.lock)
  }

  w.u8(s.squadron.length)
  for (const hull of s.squadron) {
    w.u32(hull.id).u8(SHIP_ORDER.indexOf(hull.spec))
    writeShip(w, hull.ship)
  }

  w.u16(s.bolts.length)
  for (const b of s.bolts) {
    w.u16(b.slot)
    writeVec3(w, b.pos)
    writeVec3(w, b.prev)
    writeVec3(w, b.vel)
    w.i32(b.faction)
    writeVec3(w, b.color)
  }

  w.u8(s.pods.length)
  for (const pod of s.pods) w.bool(pod.live).f32(pod.respawnIn)

  w.u16(s.mines.length)
  for (const live of s.mines) w.bool(live)

  w.u8(s.feed.length)
  for (const e of s.feed) w.u32(e.seq).i32(e.killer).i32(e.victim).u8(SHIP_ORDER.indexOf(e.hull)).i32(e.award)

  return w.bytes()
}

/**
 * Bytes back into a snapshot.
 *
 * Throws `RangeError` — and returns nothing — on the wrong version, a short
 * frame, a long frame, or a field outside its enumeration. The caller applies
 * a snapshot only after this returns, so a bad frame changes nothing.
 */
export function decodeSnapshot(bytes: Uint8Array): WorldSnapshot {
  const r = new ByteReader(bytes)
  const version = r.u8()
  if (version !== SNAPSHOT_VERSION) {
    throw new RangeError(`snapshot version ${version}, expected ${SNAPSHOT_VERSION}`)
  }
  const tick = r.u32()
  const seed = r.u32()
  const elapsed = r.f32()
  const active = r.bool()
  const paused = r.bool()
  const queued = r.u16()

  const seats: SeatState[] = []
  const seatCount = r.u8()
  for (let i = 0; i < seatCount; i++) {
    const ship = readShip(r)
    const score = r.i32()
    const kills = r.u16()
    const multiplier = r.f32()
    const hits = r.u32()
    const deaths = r.u16()
    const phaseIndex = r.u8()
    const phase = PHASES[phaseIndex]
    if (!phase) throw new RangeError(`unknown seat phase ${phaseIndex}`)
    const wreckTimer = r.f32()
    const throttle = r.f32()
    const ackTick = r.i32()
    const lock = readLock(r)
    seats.push({ ship, score, kills, multiplier, hits, deaths, phase, wreckTimer, throttle, ackTick, lock })
  }

  const squadron: SquadronState[] = []
  const squadronCount = r.u8()
  for (let i = 0; i < squadronCount; i++) {
    const id = r.u32()
    const specIndex = r.u8()
    const spec = SHIP_ORDER[specIndex]
    if (!spec) throw new RangeError(`unknown hull ${specIndex}`)
    squadron.push({ id, spec, ship: readShip(r) })
  }

  const bolts: BoltState[] = []
  const boltCount = r.u16()
  for (let i = 0; i < boltCount; i++) {
    bolts.push({
      slot: r.u16(),
      pos: readVec3(r),
      prev: readVec3(r),
      vel: readVec3(r),
      faction: r.i32() as Faction,
      color: readVec3(r),
    })
  }

  const pods: PodState[] = []
  const podCount = r.u8()
  for (let i = 0; i < podCount; i++) pods.push({ live: r.bool(), respawnIn: r.f32() })

  const mines: boolean[] = []
  const mineCount = r.u16()
  for (let i = 0; i < mineCount; i++) mines.push(r.bool())

  const feed: KillEvent[] = []
  const feedCount = r.u8()
  if (feedCount > FEED_RING) throw new RangeError(`${feedCount} kills in a feed of ${FEED_RING}`)
  for (let i = 0; i < feedCount; i++) {
    const seq = r.u32()
    const killer = r.i32()
    const victim = r.i32()
    const hullIndex = r.u8()
    const hull = SHIP_ORDER[hullIndex]
    if (!hull) throw new RangeError(`unknown hull ${hullIndex} in the feed`)
    const award = r.i32()
    feed.push({ seq, killer, victim, hull, award })
  }

  r.finish()
  return { tick, seed, elapsed, active, paused, queued, seats, squadron, bolts, pods, mines, feed }
}

/** A faction that is nobody's seat, for a bolt whose owner the mirror cannot see. */
export const NO_FACTION: Faction = FACTION_AI
