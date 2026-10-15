import type { Controls } from '../src/game/ship'
import type { Channel } from '../src/net/channel'
import { createClient, decodeWelcome, encodeHello, FRAME } from '../src/net/session'
import { encodeSnapshot } from '../src/net/snapshot'
import { encodeIntent } from '../src/net/wire'
import { createDedicatedMatch, createHeadlessGame, HELLO_TIMEOUT_TICKS, MAX_CONNECTIONS } from '../src/server/match'

/** Synchronous bytes at the transport boundary; real codecs and simulation on both sides. */
export function testChannel() {
  let open = true
  const receivers: ((bytes: Uint8Array) => void)[] = []
  const closers: (() => void)[] = []
  const frames: Uint8Array[] = []
  const channel: Channel = {
    get open() { return open },
    send(bytes) { if (open) frames.push(bytes.slice()) },
    onMessage(fn) { receivers.push(fn) }, onClose(fn) { closers.push(fn) },
    close() { if (!open) return; open = false; for (const fn of closers) fn() },
  }
  return { channel, frames, receive(bytes: Uint8Array) {
    if (open) for (const fn of [...receivers]) fn(bytes)
  } }
}

const controls: Controls = { pitch: 0.2, yaw: -0.3, roll: 0, throttle: 1,
  fire: true, dash: false, secondary: false, aim: null, spread: 0 }

export function intent(seat: number, tick: number, input: Controls = controls) {
  const bytes = encodeIntent(seat, tick, input)
  const frame = new Uint8Array(bytes.length + 1)
  frame[0] = FRAME.INTENT
  frame.set(bytes, 1)
  return frame
}

export function testDedicatedMatch(check: (label: string, condition: boolean, detail?: string) => void) {
  console.log('\nA dedicated host admits every seat through the wire')
  const match = createDedicatedMatch({ setup: { ships: ['hornet', 'wasp', 'drone', 'hornet'], seed: 123, respawn: true } })
  const mirror = createHeadlessGame()
  const peers = Array.from({ length: 4 }, testChannel)
  try {
    const initial = match.snapshot()
    check('headless authority uses the real minefield and pickups', initial.mines.length === 26 && initial.pods.length === 13)
    for (let i = 0; i < 30; i++) match.step()
    check('all four unoccupied seats including P1 get AI backfill', match.stats.backfilled === 120)
    for (const p of peers) match.connect(p.channel)
    check('connecting does not grant a seat before HELLO', match.peers === 0 && peers.every(p => p.frames.length === 0))
    for (const p of peers) p.receive(encodeHello('drone'))
    const welcomes = peers.map(p => decodeWelcome(p.frames[0]))
    check('four remote players receive P1 through P4 without a browser host', welcomes.every((w, i) => w.seat === i) && match.peers === 4)
    check('client hull requests cannot rewrite the server match setup', welcomes.every(w => w.setup.ships.join() === 'hornet,wasp,drone,hornet'))

    let mirrorReceiver: (bytes: Uint8Array) => void = () => {}
    const client = createClient({ game: mirror.game, predict: false, pace: false, channel: {
      send: peers[0].receive, onMessage(fn) { mirrorReceiver = fn },
      onClose() {}, close: () => peers[0].channel.close(), get open() { return peers[0].channel.open },
    } })
    mirrorReceiver(peers[0].frames[0])
    peers.forEach(p => p.frames.splice(0))
    let mirrored = true
    for (let tick = 0; tick < 120; tick++) {
      client.tick(controls)
      for (let seat = 1; seat < peers.length; seat++) peers[seat].receive(intent(seat, tick))
      match.step()
      for (const frame of peers[0].frames.splice(0)) mirrorReceiver(frame)
      mirrored &&= Buffer.from(encodeSnapshot(match.snapshot())).equals(Buffer.from(encodeSnapshot(mirror.game.capture())))
      for (const p of peers.slice(1)) p.frames.splice(0)
    }
    check('P1 receives and applies the server world byte-for-byte over 120 ticks', mirrored && client.stats.applied === 120 && client.seat === 0)
    check('P1 remote inputs are flown and acknowledged', match.snapshot().seats[0].ackTick >= 119 && match.stats.backfilled === 120)

    const before = match.snapshot()
    const wrongSeat = match.stats.wrongSeat
    const stale = match.stats.stale
    const malformed = match.stats.malformed
    peers[0].receive(intent(1, 1000))
    peers[0].receive(intent(0, 0))
    peers[0].receive(new Uint8Array([FRAME.SNAPSHOT, 0, 1]))
    peers[0].receive(new Uint8Array([FRAME.INTENT]))
    check('P1 cannot fly P2, replay input or submit authoritative state', match.stats.wrongSeat === wrongSeat + 1 && match.stats.stale === stale + 1 && match.stats.malformed === malformed + 2)
    for (let tick = 1001; tick < 1101; tick++) peers[0].receive(intent(0, tick))
    check('a burst of client packets cannot advance server time', match.snapshot().tick === before.tick)
    match.step()
    check('the server flies only the latest input once per tick', match.snapshot().tick === before.tick + 1 && match.snapshot().seats[0].ackTick === 1100)

    const extra = testChannel()
    match.connect(extra.channel); extra.receive(encodeHello())
    check('a fifth player is refused without replacing any player', !extra.channel.open && extra.frames[0]?.[0] === FRAME.REFUSED && match.peers === 4)
    peers[0].channel.close()
    const backfilled = match.stats.backfilled
    match.step()
    check('a disconnected P1 returns to AI on the next tick', match.peers === 3 && match.stats.backfilled === backfilled + 1)
    const replacement = testChannel()
    match.connect(replacement.channel); replacement.receive(encodeHello())
    check('a new connection takes over P1 again', decodeWelcome(replacement.frames[0]).seat === 0 && match.peers === 4)
    match.close()
    const ended = match.ticks
    match.step(); match.close()
    const afterClose = testChannel(); match.connect(afterClose.channel)
    check('shutdown closes every peer and rejects subsequent connections and ticks', peers.every(p => !p.channel.open) && !replacement.channel.open && !afterClose.channel.open && match.ticks === ended)
  } finally { match.close(); mirror.close() }

  const admission = createDedicatedMatch({ setup: { ships: ['hornet', 'hornet'], seed: 456 } })
  try {
    const bad = testChannel(); admission.connect(bad.channel)
    bad.receive(new Uint8Array([FRAME.HELLO, 0, 0]))
    check('foreign protocol is refused before seat assignment', !bad.channel.open && bad.frames[0]?.[0] === FRAME.REFUSED && admission.peers === 0)
    const early = testChannel(); admission.connect(early.channel); early.receive(intent(0, 1))
    check('intent before HELLO cannot claim a seat', !early.channel.open && admission.peers === 0)
    const waiting = Array.from({ length: MAX_CONNECTIONS + 1 }, testChannel)
    for (const p of waiting) admission.connect(p.channel)
    check('unseated connections have a bounded count', waiting.filter(p => p.channel.open).length === MAX_CONNECTIONS)
    for (let i = 0; i < HELLO_TIMEOUT_TICKS - 1; i++) admission.step()
    check('a pending HELLO gets its full deadline', waiting[0].channel.open)
    admission.step()
    check('silent connections expire without client cooperation', waiting.every(p => !p.channel.open))
    const fresh = testChannel(); admission.connect(fresh.channel); fresh.receive(encodeHello())
    check('expired handshakes release capacity for real players', admission.peers === 1 && fresh.channel.open)
  } finally { admission.close() }
}
