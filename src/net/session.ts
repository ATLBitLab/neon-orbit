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

import { admitIntent } from '../game/intent'
import { STEP, type Game, type MatchSetup } from '../game/game'
import type { Controls } from '../game/ship'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import type { Channel } from './channel'
import { decodeSnapshot, encodeSnapshot } from './snapshot'
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
  /** The last tick this seat flew an intent *for*. Ticks only go forward. */
  lastTick: number
  /** The freshest admitted intent not yet flown, if any. */
  pending: Controls | null
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
  const stats: HostStats = { wrongSeat: 0, stale: 0, malformed: 0, held: 0, admitted: 0, refused: 0 }
  let tick = 0
  let sinceSnapshot = 0

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
    stats.admitted++
  }

  return {
    start() {
      game.start(setup)
      tick = 0
      sinceSnapshot = 0
    },

    accept(channel) {
      const seat = peers.findIndex((p, i) => i > 0 && p === null)
      if (seat < 0) {
        stats.refused++
        channel.send(new Uint8Array([FRAME.REFUSED]))
        channel.close()
        return -1
      }
      const peer: Peer = { channel, seat, lastTick: -1, pending: null, held: holds[seat] }
      peers[seat] = peer
      channel.onMessage((bytes) => onFrame(peer, bytes))
      channel.onClose(() => {
        if (peers[seat] === peer) peers[seat] = null
      })
      channel.send(encodeWelcome(seat, setup))
      return seat
    },

    tick(local) {
      intents[0] = local
      for (let seat = 1; seat < seatCount; seat++) {
        const peer = peers[seat]
        const held = holds[seat]
        if (peer && peer.pending) {
          Object.assign(held, peer.pending)
          peer.pending = null
        } else {
          // Nothing arrived for this tick: hold, minus the triggers.
          admitIntent(undefined, held, STEP, scratch)
          Object.assign(held, scratch)
          if (peer) stats.held++
        }
        intents[seat] = held
      }
      game.step(intents)
      tick++

      if (++sinceSnapshot >= snapshotEvery) {
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
  /** Snapshots dropped for being older than one already applied. */
  stale: number
  /** Frames that could not be decoded, or that failed to apply. */
  malformed: number
  /** Snapshots applied. */
  applied: number
  /** Intents sent. */
  sent: number
}

export interface ClientOptions {
  game: Game
  channel: Channel
  /** Called once the host has handed over a seat and the match has started. */
  onWelcome?: (seat: number) => void
  /** Called if the host had no seat. */
  onRefused?: () => void
}

export interface Client {
  /** The seat this client flies, or -1 before the welcome. */
  readonly seat: number
  /** Send this tick's intent. Nothing is sent before the welcome. */
  tick(controls: Controls): void
  /** The host tick of the last snapshot applied, or -1. */
  readonly hostTick: number
  readonly stats: ClientStats
}

export function createClient(options: ClientOptions): Client {
  const { game, channel } = options
  const stats: ClientStats = { stale: 0, malformed: 0, applied: 0, sent: 0 }
  let seat = -1
  let tick = 0
  let hostTick = -1

  channel.send(encodeHello())

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
    if (type === FRAME.SNAPSHOT) {
      if (seat < 0) return
      try {
        const world = decodeSnapshot(bytes.subarray(1))
        if (world.tick <= hostTick) {
          stats.stale++
          return
        }
        game.apply(world)
        hostTick = world.tick
        stats.applied++
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
      channel.send(withType(FRAME.INTENT, encodeIntent(seat, tick++, controls)))
      stats.sent++
    },
    get hostTick() {
      return hostTick
    },
    get stats() {
      return stats
    },
  }
}
