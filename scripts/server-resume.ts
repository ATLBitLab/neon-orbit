import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { decodeSnapshot, type WorldSnapshot } from '../src/net/snapshot'
import { decodeWelcome, encodeHello, FRAME, type Welcome } from '../src/net/session'
import { encodeResumeToken } from '../src/net/resume'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:8080'
const graceMs = 12_000
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, description: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await wait(20)
  }
}

interface Peer {
  socket: WebSocket
  welcomes: Welcome[]
  snapshots: WorldSnapshot[]
  token: string | null
}

function wsUrl(code: string, legacyToken?: string): URL {
  const url = new URL('/ws', endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', code)
  if (legacyToken) url.searchParams.set('resume', legacyToken)
  return url
}

async function join(code: string, token?: string, legacy = false): Promise<Peer> {
  const url = wsUrl(code, legacy ? token : undefined)
  if (!legacy) assert.equal(url.searchParams.has('resume'), false,
    'new client never puts the secret in its URL')
  const socket = new WebSocket(url)
  const peer: Peer = { socket, welcomes: [], snapshots: [], token: null }
  socket.on('message', (data, binary) => {
    if (!binary) {
      const control = JSON.parse(String(data)) as { type?: string; token?: string }
      if (control.type === 'resume' && typeof control.token === 'string') peer.token = control.token
      return
    }
    const bytes = Buffer.from(data as ArrayBuffer)
    if (bytes[0] === FRAME.WELCOME) peer.welcomes.push(decodeWelcome(bytes))
    if (bytes[0] === FRAME.SNAPSHOT) peer.snapshots.push(decodeSnapshot(bytes.subarray(1)))
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  if (token && !legacy) socket.send(encodeResumeToken(token))
  socket.send(encodeHello())
  return peer
}

const joinLegacy = (code: string, token: string) => join(code, token, true)

async function refused(code: string, token?: string): Promise<number> {
  const socket = new WebSocket(wsUrl(code, token))
  return await new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => { socket.close(); reject(new Error('unauthorized seat was admitted')) })
    socket.once('error', reject)
  })
}

async function refusedFrame(code: string, token?: string): Promise<number> {
  const socket = new WebSocket(wsUrl(code))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => reject(new Error(`unexpected ${response.statusCode}`)))
  })
  socket.send(token ? encodeResumeToken(token) : encodeHello())
  return await new Promise<number>((resolve, reject) => {
    socket.once('close', code => resolve(code))
    socket.once('error', reject)
  })
}

const response = await fetch(`${endpoint}/rooms`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 2 }) })
assert.equal(response.status, 201)
const { code } = await response.json() as { code: string }
let first: Peer | null = null
let second: Peer | null = null
let resumed: Peer | null = null
try {
  first = await join(code)
  second = await join(code)
  first.socket.send(JSON.stringify({ type: 'start' }))
  await until(() => !!first?.token && !!second?.token && first.snapshots.length > 2 &&
    second.snapshots.length > 2, 'welcome, token, and snapshots')
  assert.equal(first.welcomes[0].seat, 0)
  assert.equal(second.welcomes[0].seat, 1)
  assert.match(second.token!, /^[A-Za-z0-9_-]{43}$/, 'seat token has 256 random bits')
  assert.notEqual(first.token, second.token, 'each seat has its own secret')
  const initial = second.snapshots.at(-1)!
  const seed = second.welcomes[0].setup.seed
  const token = second.token!
  const closed = new Promise(resolve => second!.socket.once('close', resolve))
  second.socket.close()
  await closed
  await until(() => first!.snapshots.at(-1)!.tick > initial.tick + 15, 'AI takeover ticks')
  const gapWorld = first.snapshots.at(-1)!
  assert.equal(gapWorld.seats[1].ackTick, -1, 'the vacant seat is AI-controlled')
  assert.notDeepEqual(gapWorld.seats[1].ship.position, initial.seats[1].ship.position,
    'the AI flies the existing hull during the gap')
  assert.equal(await refusedFrame(code), 1008, 'room code alone cannot reclaim a running seat')
  assert.equal(await refusedFrame(code, 'A'.repeat(43)), 1008,
    'same-length wrong token fails the timing-safe comparison path')
  const pending = new WebSocket(wsUrl(code))
  await new Promise<void>((resolve, reject) => {
    pending.once('open', () => resolve())
    pending.once('error', reject)
  })
  pending.send(encodeResumeToken(token))
  assert.equal(await refused(code, token), 429, 'one token cannot claim two sockets at once')
  const pendingClosed = new Promise(resolve => pending.once('close', resolve))
  pending.close()
  await pendingClosed
  resumed = await join(code, token)
  await until(() => !!resumed?.token && resumed.welcomes.length > 0 && resumed.snapshots.length > 0,
    'authenticated resume')
  assert.equal(resumed.welcomes[0].seat, 1, 'resume reclaimed the same seat')
  assert.equal(resumed.welcomes[0].setup.seed, seed, 'resume did not start a fresh match')
  assert.notEqual(resumed.token, token, 'a successful resume rotates the secret')
  const world = resumed.snapshots[0]
  await until(() => first!.snapshots.some(snapshot => snapshot.tick === world.tick),
    'other client saw the same authoritative tick')
  const peerWorld = first.snapshots.find(snapshot => snapshot.tick === world.tick)!
  assert.equal(world.seats[1].score, peerWorld.seats[1].score,
    'resumed seat received its existing score')
  assert.deepEqual(world.seats[1].ship, peerWorld.seats[1].ship,
    'resumed seat received its existing hull state')
  assert.ok(world.tick > initial.tick, 'match time continued across disconnect')
  const resumedClosed = new Promise(resolve => resumed!.socket.once('close', resolve))
  resumed.socket.close()
  await resumedClosed
  assert.equal(await refusedFrame(code, token), 1008, 'old token is invalid after rotation')
  const legacy = await joinLegacy(code, resumed.token!)
  await until(() => legacy.welcomes.length > 0 && !!legacy.token, 'legacy client resume')
  assert.equal(legacy.welcomes[0].seat, 1, 'old query-token client stays compatible for one release')
  assert.notEqual(legacy.token, resumed.token, 'legacy resume rotates the secret too')
  const legacyClosed = new Promise(resolve => legacy.socket.once('close', resolve))
  legacy.socket.close()
  await legacyClosed
  await wait(graceMs + 250)
  assert.equal(await refused(code, legacy.token!), 429, 'expired token cannot reclaim a seat')
  assert.ok(first.snapshots.at(-1)!.tick > world.tick + 10, 'AI kept the match ticking after expiry')
  assert.equal((await fetch(`${endpoint}/health`).then(res => res.json())).players, 1)
} finally {
  first?.socket.close()
  second?.socket.close()
  resumed?.socket.close()
}
await wait(graceMs + 250)
assert.equal((await fetch(`${endpoint}/health`).then(res => res.json())).rooms, 0,
  'room closes after the last disconnected seat exhausts its grace window')
console.log('same-seat/score resume, wrong-token refusal, expiry, and empty-room cleanup passed')
