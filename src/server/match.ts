/** A Node-owned match. Its caller supplies a clock and already-connected byte channels. */
import * as THREE from 'three'
import type { Audio } from '../core/audio'
import type { Input } from '../core/input'
import { createGame, type MatchSetup } from '../game/game'
import type { Hud } from '../game/hud'
import type { Channel } from '../net/channel'
import { createHost, decodeHello, FRAME, refuse } from '../net/session'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import { buildEnvironment } from '../world/environment'

const noop = () => {}

/** Real arena and simulation; only device, sound and DOM presentation are absent. */
export function createHeadlessGame() {
  const environment = buildEnvironment()
  const scene = new THREE.Scene()
  const audio: Audio = {
    muted: true, resume: noop, toggleMute: () => true, setMusic: noop,
    laser: noop, hit: noop, hullHit: noop, explosion: noop, warp: noop,
    dash: noop, pickup: noop, overheat: noop, alarm: noop, charge: noop,
    siege: noop, detonation: noop, uiSelect: noop, uiLaunch: noop,
    fanfare: noop, dispose: noop,
  }
  const input: Input = {
    state: { pitch: 0, yaw: 0, roll: 0, throttleUp: false, throttleDown: false,
      fire: false, dash: false, secondary: false },
    pointerLocked: false, invertPitch: false, update: noop,
    requestPointerLock: noop, releasePointerLock: noop,
    onPointerLockLost: noop, onKey: noop, reset: noop, dispose: noop,
  }
  const hud: Omit<Hud, 'root'> = {
    show: noop, hide: noop, setShip: noop, update: noop, updateContacts: noop,
    flashDamage: noop, callout: noop, feed: noop, setLockPrompt: noop,
    tick: noop, dispose: noop,
  }
  const game = createGame({ scene, camera: new THREE.PerspectiveCamera(),
    environment, audio, input, hud, bestScoreFor: () => 0, onEnd: noop })
  let closed = false
  return {
    game,
    close() {
      if (closed) return
      closed = true
      game.abandon()
      game.dispose()
      environment.dispose()
      scene.clear()
    },
  }
}

export interface DedicatedOptions {
  setup: Pick<MatchSetup, 'seed' | 'respawn'> & { ships: ShipId[] }
  snapshotEvery?: number
}

/** Tick deadlines belong to the server clock, never to incoming messages. */
export const HELLO_TIMEOUT_TICKS = 300
export const MAX_CONNECTIONS = 8

export function createDedicatedMatch(options: DedicatedOptions) {
  const { setup } = options
  if (setup.ships.length < 2 || setup.ships.length > 4 || setup.ships.some(id => !SHIP_ORDER.includes(id))) {
    throw new RangeError('a dedicated match requires two to four valid hulls')
  }
  if (options.snapshotEvery !== undefined && (!Number.isInteger(options.snapshotEvery) || options.snapshotEvery < 1)) {
    throw new RangeError('snapshotEvery must be a positive integer')
  }
  const headless = createHeadlessGame()
  const host = createHost({ game: headless.game, setup: { ...setup, ships: [...setup.ships] },
    dedicated: true, snapshotEvery: options.snapshotEvery })
  const channels = new Set<Channel>()
  const waiting = new Map<Channel, number>()
  let ticks = 0
  let closed = false
  host.start()
  return {
    /** A valid HELLO precedes seat assignment; hulls are fixed by server setup. */
    connect(channel: Channel, reservedSeat?: number) {
      if (closed || !channel.open || headless.game.result || channels.size >= MAX_CONNECTIONS) {
        channel.close()
        return
      }
      if (channels.has(channel)) return
      channels.add(channel)
      waiting.set(channel, ticks + HELLO_TIMEOUT_TICKS)
      channel.onClose(() => { channels.delete(channel); waiting.delete(channel) })
      channel.onMessage(bytes => {
        if (closed || !channel.open || !waiting.has(channel)) return
        if (bytes[0] !== FRAME.HELLO) { channel.close(); return }
        try { decodeHello(bytes) } catch { refuse(channel, 'version'); return }
        waiting.delete(channel)
        host.accept(channel, reservedSeat)
      })
    },
    /** Exactly one 1/60s tick; no browser input or client delta can advance time. */
    step() {
      if (closed) return
      ticks++
      for (const [channel, deadline] of waiting) if (ticks >= deadline) channel.close()
      host.tick()
    },
    snapshot: () => headless.game.capture(),
    /** One seat's read-only view, for the anonymous stats recorder. */
    view: (seat: number) => headless.game.snapshot(seat),
    get result() { return headless.game.result },
    get stats() { return host.stats },
    get peers() { return host.peers },
    get ticks() { return ticks },
    get seed() { return host.seed },
    close() {
      if (closed) return
      closed = true
      for (const channel of channels) channel.close()
      channels.clear()
      waiting.clear()
      host.close()
      headless.close()
    },
  }
}
