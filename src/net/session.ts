/**
 * The session protocol: who flies which seat, and what the wire means.
 *
 * Headless and transport-agnostic — it speaks `Channel` and nothing else, so
 * every rule here is asserted in `simcheck` over a lossy loopback before a
 * real `RTCDataChannel` ever carries it.
 *
 * Frames are one type byte then a payload:
 *
 *   HELLO     client -> host   protocol version
 *   WELCOME   host -> client   the seat this peer flies, and the `MatchSetup`
 *   INTENT    client -> host   an intent frame (`wire.ts`), tick-stamped
 *   SNAPSHOT  host -> client   the world (`snapshot.ts`), tick-stamped inside
 *   REFUSED   host -> client   no seat for you
 *   RESULT    host -> client   the match has resolved: every seat's line
 *
 * Three rules carry the anti-cheat weight, and the tests name each:
 *
 * - **A peer flies the seat it was given, and only that one.** The seat in an
 *   INTENT frame is checked against the channel it arrived on; a mismatch is
 *   dropped and counted. Authorisation is by channel, not by claim.
 * - **Ticks only go forward.** An intent for a tick at or before the last one
 *   this seat flew is dropped — a retransmit is not a second turn, and a
 *   replay is not a courtesy.
 * - **A missing tick holds.** The seat's last admitted intent carries, minus
 *   the triggers (`admitIntent(undefined, …)`), so loss reads as "keep doing
 *   that" rather than as a stall or a snap to neutral.
 *
 * Everything that reaches the simulation has been through `admitIntent`;
 * this layer never constructs a `Controls` by hand.
 */

import type { MatchResult, SeatLine } from '../core/scores'
import { admitIntent } from '../game/intent'
import { STEP, type Game, type MatchSetup } from '../game/game'
import type { Controls } from '../game/ship'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import type { Channel } from './channel'
import { decodeSnapshot, encodeSnapshot, type WorldSnapshot } from './snapshot'
import { ByteReader, ByteWriter, decodeIntent, encodeIntent } from './wire'

export const PROTOCOL_VERSION = 1

/** Ticks between repeated hellos while a client waits for its welcome. */
export const HELLO_EVERY = 30

export const FRAME = {
  HELLO: 1,
  WELCOME: 2,
  INTENT: 3,
  SNAPSHOT: 4,
  REFUSED: 5,
  RESULT: 6,
} as const

/* ---- Frames --------------------------------------------------------------- */

function withType(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = type
  out.set(payload, 1)
  return out
}

export function encodeHello(): Uint8Array {
  return new Uint8Array([FRAME.HELLO, PROTOCOL_VERSION])
}

export function encodeWelcome(seat: number, setup: Required<Pick<MatchSetup, 'ships' | 'seed'>> & MatchSetup): Uint8Array {
  const w = new ByteWriter(16)
  w.u8(FRAME.WELCOME).u8(PROTOCOL_VERSION).u8(seat)
  w.bool(setup.respawn ?? false).u32(setup.seed)
  w.u8(setup.ships.length)
  for (const id of setup.ships) w.u8(SHIP_ORDER.indexOf(id))
  return w.bytes()
}

export interface Welcome {
  seat: number
  setup: MatchSetup & { ships: ShipId[]; seed: number }
}

export function decodeWelcome(bytes: Uint8Array): Welcome {
  const r = new ByteReader(bytes)
  const type = r.u8()
  if (type !== FRAME.WELCOME) throw new RangeError(`not a welcome frame: ${type}`)
  const version = r.u8()
  if (version !== PROTOCOL_VERSION) throw new RangeError(`protocol ${version}, expected ${PROTOCOL_VERSION}`)
  const seat = r.u8()
  const respawn = r.bool()
  const seed = r.u32()
  const count = r.u8()
  const ships: ShipId[] = []
  for (let i = 0; i < count; i++) {
    const id = SHIP_ORDER[r.u8()]
    if (!id) throw new RangeError('unknown hull in welcome')
    ships.push(id)
  }
  r.finish()
  if (seat >= ships.length) throw new RangeError(`welcomed to seat ${seat} of ${ships.length}`)
  return { seat, setup: { ships, seed, respawn, local: seat } }
}

export function encodeResult(result: MatchResult): Uint8Array {
  const w = new ByteWriter(64)
  w.u8(FRAME.RESULT).u8(PROTOCOL_VERSION).f32(result.time).bool(result.cleared).u8(result.lines.length)
  for (const l of result.lines) {
    w.u8(l.seat).u8(SHIP_ORDER.indexOf(l.ship)).i32(l.score).u16(l.kills).u16(l.deaths).u32(l.hits).u32(l.shots)
    w.bool(l.alive).u8(l.place).bool(l.won)
  }
  return w.bytes()
}

export function decodeResult(bytes: Uint8Array): MatchResult {
  const r = new ByteReader(bytes)
  const type = r.u8()
  if (type !== FRAME.RESULT) throw new RangeError(`not a result frame: ${type}`)
  const version = r.u8()
  if (version !== PROTOCOL_VERSION) throw new RangeError(`protocol ${version}, expected ${PROTOCOL_VERSION}`)
  const time = r.f32()
  const cleared = r.bool()
  const count = r.u8()
  const lines: SeatLine[] = []
  for (let i = 0; i < count; i++) {
    const seat = r.u8()
    const ship = SHIP_ORDER[r.u8()]
    if (!ship) throw new RangeError('unknown hull in result')
    const score = r.i32()
    const kills = r.u16()
    const deaths = r.u16()
    const hits = r.u32()
    const shots = r.u32()
    const alive = r.bool()
    const place = r.u8()
    const won = r.bool()
    if (place < 1 || place > count) throw new RangeError(`place ${place} of ${count}`)
    lines.push({ seat, ship, score, kills, deaths, hits, shots, alive, place, won })
  }
  r.finish()
  return { time, cleared, lines }
}

/* ---- Host ----------------------------------------------------------------- */

export interface HostStats {
  /** Intent frames refused because the seat claimed was not the channel's seat. */
  wrongSeat: number
  /** Intent frames for a tick already flown. */
  stale: number
  /** Frames that could not be decoded at all. */
  malformed: number
  /** Ticks a remote seat flew on a held intent because nothing arrived. */
  held: number
  /** Intents that arrived and were admitted. */
  admitted: number
  /** Peers refused for want of a seat. */
  refused: number
  /** Result frames sent: one per peer when the match resolved, and every half second after. */
  results: number
}

export interface HostOptions {
  game: Game
  setup: MatchSetup & { ships: ShipId[] }
  /** Send a snapshot every this many ticks. 1 is every tick. */
  snapshotEvery?: number
}

export interface Host {
  /** Begin the match. Seat 0 is the host's own; the rest wait for peers. */
  start(): void
  /**
   * Hand a connected channel a seat. Returns the seat, or -1 if there was none —
   * in which case the peer has been told and the channel closed.
   */
  accept(channel: Channel): number
  /**
   * Fly one tick: the host's own intent for seat 0, the latest admitted intent
   * (or a hold) for every remote seat, then a snapshot to every peer.
   */
  tick(local: Controls): void
  readonly stats: HostStats
  readonly peers: number
  readonly seed: number
}

interface Peer {
  channel: Channel
  seat: number
  /** The last tick admitted from this peer. Ticks only go forward. */
  lastTick: number
  /** The tick of the intent this seat is currently flying on; -1 before the first. */
  flownTick: number
  /** The freshest admitted intent not yet flown, if any, and its tick. */
  pending: Controls | null
  pendingTick: number
  /** What this seat last flew on — the `held` for admission. */
  held: Controls
}

function neutral(): Controls {
  return { pitch: 0, yaw: 0, roll: 0, throttle: 0.6, fire: false, dash: false, aim: null, spread: 0 }
}

export function createHost(options: HostOptions): Host {
  const { game } = options
  const snapshotEvery = Math.max(1, options.snapshotEvery ?? 1)
  const seed = (options.setup.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0
  const setup = { ...options.setup, seed, local: 0 }
  const seatCount = setup.ships.length

  const peers: (Peer | null)[] = Array.from({ length: seatCount }, () => null)
  const intents: Controls[] = Array.from({ length: seatCount }, () => neutral())
  const holds: Controls[] = Array.from({ length: seatCount }, () => neutral())
  const scratch: Controls = neutral()
  const stats: HostStats = { wrongSeat: 0, stale: 0, malformed: 0, held: 0, admitted: 0, refused: 0, results: 0 }
  let tick = 0
  let sinceSnapshot = 0
  /** The result the peers are being told, and how long since it was last said. */
  let resultSent: MatchResult | null = null
  let sinceResult = 0

  function onFrame(peer: Peer, bytes: Uint8Array): void {
    if (bytes.length === 0) {
      stats.malformed++
      return
    }
    const type = bytes[0]
    if (type === FRAME.HELLO) {
      // The welcome was lost; the peer is still asking. Say it again.
      peer.channel.send(encodeWelcome(peer.seat, setup))
      return
    }
    if (type !== FRAME.INTENT) {
      stats.malformed++
      return
    }
    let frame
    try {
      frame = decodeIntent(bytes.subarray(1), peer.held, STEP, scratch)
    } catch {
      stats.malformed++
      return
    }
    if (frame.seat !== peer.seat) {
      stats.wrongSeat++
      return
    }
    if (frame.tick <= peer.lastTick) {
      stats.stale++
      return
    }
    peer.lastTick = frame.tick
    // Copy out of the scratch: the next frame reuses it.
    peer.pending = { ...frame.controls }
    peer.pendingTick = frame.tick
    stats.admitted++
  }

  return {
    start() {
      game.start(setup)
      tick = 0
      sinceSnapshot = 0
      resultSent = null
    },

    accept(channel) {
      const seat = peers.findIndex((p, i) => i > 0 && p === null)
      if (seat < 0) {
        stats.refused++
        channel.send(new Uint8Array([FRAME.REFUSED]))
        channel.close()
        return -1
      }
      const peer: Peer = { channel, seat, lastTick: -1, flownTick: -1, pending: null, pendingTick: -1, held: holds[seat] }
      peers[seat] = peer
      channel.onMessage((bytes) => onFrame(peer, bytes))
      channel.onClose(() => {
        if (peers[seat] === peer) peers[seat] = null
      })
      channel.send(encodeWelcome(seat, setup))
      return seat
    },

    tick(local) {
      // A resolved match is told to every peer, and nothing else is sent: the
      // roster is gone, and a snapshot of nobody is not a world. Said again
      // every half second for as long as the host keeps ticking, because the
      // wire drops frames and a result that never arrived is a debrief the
      // joiner never sees; a mirror that has already concluded ignores repeats.
      if (!game.active) {
        const result = game.result
        if (!result) return
        if (result !== resultSent) {
          resultSent = result
          sinceResult = HELLO_EVERY
        }
        if (++sinceResult >= HELLO_EVERY) {
          sinceResult = 0
          const bytes = encodeResult(result)
          for (const peer of peers) {
            if (peer && peer.channel.open) {
              peer.channel.send(bytes)
              stats.results++
            }
          }
        }
        return
      }
      intents[0] = local
      for (let seat = 1; seat < seatCount; seat++) {
        const peer = peers[seat]
        const held = holds[seat]
        if (peer && peer.pending) {
          Object.assign(held, peer.pending)
          peer.flownTick = peer.pendingTick
          peer.pending = null
        } else {
          // Nothing arrived for this tick: hold, minus the triggers.
          admitIntent(undefined, held, STEP, scratch)
          Object.assign(held, scratch)
          if (peer) stats.held++
        }
        intents[seat] = held
        // Told to the seat before the tick, so the snapshot this tick carries
        // says which intent it was flown on.
        game.acknowledge(seat, peer ? peer.flownTick : -1)
      }
      game.step(intents)
      tick++

      // Not on the tick the match resolved: `finish` has cleared the roster,
      // and the result frame is what says so.
      if (++sinceSnapshot >= snapshotEvery && game.active) {
        sinceSnapshot = 0
        const bytes = withType(FRAME.SNAPSHOT, encodeSnapshot(game.capture()))
        for (const peer of peers) if (peer && peer.channel.open) peer.channel.send(bytes)
      }
    },

    get stats() {
      return stats
    },
    get peers() {
      return peers.filter((p) => p !== null).length
    },
    get seed() {
      return seed
    },
  }
}

/* ---- Client --------------------------------------------------------------- */

export interface ClientStats {
  /** Snapshots dropped for being older than one already applied or already waiting. */
  stale: number
  /** Frames that could not be decoded, or that failed to apply. */
  malformed: number
  /** Snapshots applied. */
  applied: number
  /** Intents sent. */
  sent: number
  /** Ticks flown with nothing to apply, on the last velocity. */
  coasted: number
  /** Extra snapshots applied in one tick to drain a backlog — each a tick skipped on screen. */
  skipped: number
}

/**
 * How many snapshots a client will hold back before it starts skipping them.
 *
 * A client applies one snapshot per tick of its own rather than each as it
 * arrives, and this is the depth the queue is allowed to reach before it drains
 * two a tick. Four ticks is 67 ms of jitter absorbed, and the queue only fills
 * to what the wire actually needs: a snapshot that arrives late leaves a tick
 * with nothing to apply, and the tick after it holds one more than before. See
 * `createClient`.
 */
export const SNAPSHOT_DEPTH = 4

/** Snapshots held waiting at most; beyond this the oldest are dropped unapplied. */
export const SNAPSHOT_QUEUE = 16

export interface ClientOptions {
  game: Game
  channel: Channel
  /**
   * Fly the local seat immediately on each intent and reconcile against every
   * snapshot. On by default: this is what makes the stick feel attached to the
   * ship. Off, the hull moves only when the host says so — a round trip late.
   */
  predict?: boolean
  /** Called once the host has handed over a seat and the match has started. */
  onWelcome?: (seat: number) => void
  /** Called if the host had no seat. */
  onRefused?: () => void
  /**
   * Apply snapshots one per tick of this client's own clock, holding what the
   * wire delivers early and coasting through what it delivers late. On by
   * default. Off, a snapshot is applied the moment it arrives — which draws the
   * arena to the wire's rhythm rather than the frame's, and a wire's rhythm is
   * not smooth. Left as a switch so the difference is measurable.
   */
  pace?: boolean
}

export interface Client {
  /** The seat this client flies, or -1 before the welcome. */
  readonly seat: number
  /** Intents sent and not yet acknowledged by the host — the replay window. */
  readonly unacknowledged: number
  /** Send this tick's intent. Nothing is sent before the welcome. */
  tick(controls: Controls): void
  /** The host tick of the last snapshot applied, or -1. */
  readonly hostTick: number
  /** Snapshots arrived and not yet applied. */
  readonly waiting: number
  readonly stats: ClientStats
}

export function createClient(options: ClientOptions): Client {
  const { game, channel } = options
  const stats: ClientStats = { stale: 0, malformed: 0, applied: 0, sent: 0, coasted: 0, skipped: 0 }
  const predict = options.predict ?? true
  const pace = options.pace ?? true
  let seat = -1
  let tick = 0
  let hostTick = -1
  /** Every intent sent since the last acknowledged one, oldest first. */
  const buffer: { tick: number; controls: Controls }[] = []
  /**
   * Snapshots arrived and not yet applied, oldest first.
   *
   * The wire delivers to its own rhythm — two in one tick, none the next — and
   * a mirror that applied each on arrival would draw to that rhythm: the frame
   * blends between the last two poses at a factor taken from the *local* clock,
   * so a pair that advanced twice between frames jumps and a pair that did not
   * advance slides back. Applying one per local tick instead makes the pair
   * advance exactly as the frame expects. The queue holds whatever arrived
   * early; a tick that finds it empty coasts (`Game.coast`); and a queue deeper
   * than `SNAPSHOT_DEPTH` drains two a tick, so the picture never falls further
   * behind the wire than that.
   */
  const queue: WorldSnapshot[] = []
  /** The host tick the client last coasted from, so a gap is coasted once, not forever. */
  let coastedAt = -2

  channel.send(encodeHello())

  function applySnapshot(world: WorldSnapshot): void {
    // A snapshot that throws has changed nothing (`Game.apply`'s contract), and
    // it is counted, not thrown on: this runs inside the client's own tick now,
    // not inside the wire's handler, and a host whose match has resolved sends
    // a roster of nobody until it notices.
    try {
      game.apply(world)
    } catch {
      stats.malformed++
      return
    }
    hostTick = world.tick
    stats.applied++
    if (predict) {
      // Drop everything the host has flown, replay the rest on its truth.
      const ack = world.seats[seat]?.ackTick ?? -1
      while (buffer.length > 0 && buffer[0].tick <= ack) buffer.shift()
      game.reconcile(
        seat,
        buffer.map((b) => b.controls),
      )
    }
  }

  /** Keep the queue sorted by tick, with no tick twice. Returns false for one not worth keeping. */
  function enqueue(world: WorldSnapshot): boolean {
    let at = queue.length
    while (at > 0 && queue[at - 1].tick > world.tick) at--
    if (at > 0 && queue[at - 1].tick === world.tick) return false
    queue.splice(at, 0, world)
    if (queue.length > SNAPSHOT_QUEUE) queue.shift()
    return true
  }

  function coast(): void {
    game.coast(predict ? seat : -1)
    stats.coasted++
    coastedAt = hostTick
  }

  /**
   * One tick's worth of the world: the next snapshot, a second if behind, or a
   * coast.
   *
   * A coast stands in for the tick after the last one applied, and it is taken
   * in two cases. Nothing waiting is the obvious one. The other is the next
   * snapshot waiting being *not the next tick* — the one before it is late or
   * lost — and nothing having been coasted since the last apply: one coast
   * covers the missing tick's motion either way, and if the straggler arrives
   * meanwhile it sorts to the front and is applied next. Without this, a
   * snapshot reordered past its predecessor was applied on arrival and the
   * predecessor dropped as stale — a tick skipped on screen every time the wire
   * reordered while the queue was still shallow, which is every session's first
   * hundred milliseconds.
   */
  function advance(): void {
    if (queue.length === 0) {
      if (hostTick >= 0) coast()
      return
    }
    if (hostTick >= 0 && queue[0].tick > hostTick + 1 && coastedAt !== hostTick) {
      coast()
      return
    }
    applySnapshot(queue.shift()!)
    if (queue.length > SNAPSHOT_DEPTH) {
      applySnapshot(queue.shift()!)
      stats.skipped++
    }
  }

  channel.onMessage((bytes) => {
    if (bytes.length === 0) {
      stats.malformed++
      return
    }
    const type = bytes[0]
    if (type === FRAME.WELCOME) {
      if (seat >= 0) return
      let welcome: Welcome
      try {
        welcome = decodeWelcome(bytes)
      } catch {
        stats.malformed++
        return
      }
      seat = welcome.seat
      game.start(welcome.setup)
      options.onWelcome?.(seat)
      return
    }
    if (type === FRAME.REFUSED) {
      options.onRefused?.()
      return
    }
    if (type === FRAME.RESULT) {
      if (seat < 0) return
      let result: MatchResult
      try {
        result = decodeResult(bytes)
      } catch {
        stats.malformed++
        return
      }
      // Whatever is still queued is a world that has ended; the result is the last word.
      queue.length = 0
      game.conclude(result)
      return
    }
    if (type === FRAME.SNAPSHOT) {
      if (seat < 0) return
      try {
        const world = decodeSnapshot(bytes.subarray(1))
        if (world.tick <= hostTick) {
          stats.stale++
          return
        }
        if (!pace) {
          applySnapshot(world)
          return
        }
        if (!enqueue(world)) stats.stale++
      } catch {
        stats.malformed++
      }
      return
    }
    stats.malformed++
  })

  return {
    get seat() {
      return seat
    },
    tick(controls) {
      if (!channel.open) return
      if (seat < 0) {
        // Still waiting: the hello, or the welcome, may have been lost. Ask again
        // every half second rather than every tick, so a slow host is not flooded.
        if (++tick % HELLO_EVERY === 0) channel.send(encodeHello())
        return
      }
      // The world first, then this seat's own step on top of it.
      if (pace) advance()
      const sent = tick++
      channel.send(withType(FRAME.INTENT, encodeIntent(seat, sent, controls)))
      stats.sent++
      if (predict) {
        // A copy: the producer reuses its struct, and this one has to be replayable.
        const copy = { ...controls, aim: null, spread: 0 }
        buffer.push({ tick: sent, controls: copy })
        // Bounded: a host that never acknowledges must not grow this forever.
        if (buffer.length > 240) buffer.shift()
        game.predict(seat, copy)
      }
    },
    get unacknowledged() {
      return buffer.length
    },
    get hostTick() {
      return hostTick
    },
    get waiting() {
      return queue.length
    },
    get stats() {
      return stats
    },
  }
}
