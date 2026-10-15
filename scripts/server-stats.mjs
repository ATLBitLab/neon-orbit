// Listener path for anonymous match stats (#64): a real dedicated room over
// WebSockets, abandoned by both players, must leave exactly the allowed fields
// and nothing that identifies a connection. Run after `npm run build:server`.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const MATCH_KEYS = ['durationS', 'humans', 'match', 'outcome', 'seats', 'ships', 'startedHour', 'type', 'v']
const PLAYER_KEYS = ['damageTaken', 'deathPositions', 'deaths', 'hitRate', 'hits', 'kills', 'left',
  'livesS', 'match', 'place', 'seat', 'session', 'ship', 'shots', 'timeToFirstKillS', 'type', 'v', 'won']
const SESSION = 'TestSession_0123456789'

const dir = await mkdtemp(join(tmpdir(), 'neon-server-stats-'))
const statsPath = join(dir, 'match-stats.jsonl')
const port = await new Promise(resolve => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const endpoint = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['dist-server/listener.mjs'], {
  env: { ...process.env, PORT: String(port), STATS_PATH: statsPath, POT_ENABLED: '0' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const sockets = []

async function until(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

// The client sends its session in frame 10 before HELLO (src/net/stats-session.ts).
const sessionFrame = sid => Buffer.concat([Buffer.from([10]), Buffer.from(sid, 'ascii')])

function connect(code, { frame, urlSid } = {}) {
  const url = new URL('/ws', endpoint)
  url.protocol = 'ws:'
  url.searchParams.set('room', code)
  if (urlSid) url.searchParams.set('sid', urlSid)
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const frames = []
    const controls = []
    socket.on('message', (data, binary) => {
      if (binary) frames.push(Buffer.from(data))
      else controls.push(JSON.parse(String(data)))
    })
    socket.once('open', () => {
      sockets.push(socket)
      if (frame) socket.send(sessionFrame(frame))
      socket.send(Buffer.from([1, 3, 0]))
      resolve({ socket, frames, controls })
    })
    socket.once('error', reject)
  })
}

try {
  await until(() => fetch(`${endpoint}/health`).then(res => res.ok, () => false), 'listener')
  const { code } = await fetch(`${endpoint}/rooms`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 3 }) }).then(res => res.json())
  const first = await connect(code, { frame: SESSION })
  await until(() => first.frames.some(frame => frame[0] === 7), 'first lobby')
  // A malformed frame, and a well-formed id in the URL, which the server must ignore.
  const second = await connect(code, { frame: 'not a valid id!', urlSid: 'UrlSession_0123456789' })
  await until(() => second.frames.some(frame => frame[0] === 7), 'second lobby')
  first.socket.send(JSON.stringify({ type: 'ship', ship: 'drone' }))
  second.socket.send(JSON.stringify({ type: 'ship', ship: 'wasp' }))
  await until(() => first.frames.some(frame => frame[0] === 7 && frame[8] === 2 && frame[10] === 0), 'hull picks')
  first.socket.send(JSON.stringify({ type: 'start' }))
  await until(() => second.frames.filter(frame => frame[0] === 4).length >= 30, 'snapshots')
  const tokens = [...first.controls, ...second.controls].filter(c => c.type === 'resume').map(c => c.token)
  assert.equal(tokens.length, 2, 'both seats received resume tokens')
  first.socket.close(1000)
  second.socket.terminate()
  // Both seats wait out the 12 s resume grace, then the room closes as abandoned.
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal(await readFile(statsPath, 'utf8').catch(() => ''), '',
    'recording a departure must not skip the resume grace window')
  await until(async () => (await readFile(statsPath, 'utf8').catch(() => '')).split('\n').length >= 4,
    'stats lines', 30_000)

  const text = await readFile(statsPath, 'utf8')
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 3, 'one match line and two player lines')
  const [match, ...players] = lines
  assert.deepEqual(Object.keys(match).sort(), MATCH_KEYS)
  assert.equal(match.outcome, 'abandoned')
  assert.deepEqual(match.ships, ['drone', 'wasp', 'hornet'])
  assert.equal(match.humans, 2)
  assert.ok(match.durationS > 0)
  for (const player of players) assert.deepEqual(Object.keys(player).sort(), PLAYER_KEYS)
  const [drone, wasp] = players
  assert.equal(drone.ship, 'drone')
  assert.equal(drone.session, SESSION)
  assert.equal(drone.left, 'quit', 'clean close is a quit')
  assert.equal(wasp.ship, 'wasp')
  assert.equal(wasp.session, null, 'a malformed session frame is dropped and ?sid= is never read')
  assert.equal(wasp.left, 'disconnect', 'a dropped link is a disconnect')

  // Nothing that identifies a connection, anywhere in the file.
  for (const banned of [code, '127.0.0.1', '::1', 'ffff', 'not a valid id', 'UrlSession', ...tokens]) {
    assert.ok(!text.includes(banned), `stats file must not contain ${banned}`)
  }
  for (const key of ['ip', 'address', 'userAgent', 'user-agent', 'pubkey', 'npub', 'name', 'token', 'resume', 'room', 'code']) {
    assert.ok(!new RegExp(`"${key}"`, 'i').test(text), `stats file must not have a "${key}" field`)
  }

  const summary = JSON.parse(execFileSync(process.execPath, ['scripts/stats-summary.mjs', statsPath, '--json'], { encoding: 'utf8' }))
  assert.equal(summary.matches, 1)
  assert.equal(summary.players, 2)
  assert.deepEqual(summary.ships.map(row => row.ship).sort(), ['drone', 'wasp'])
  assert.equal(summary.ships.find(row => row.ship === 'drone').quitRate, 100)
  execFileSync(process.execPath, ['scripts/stats-summary.mjs', statsPath], { stdio: 'inherit' })
  console.log('server stats: abandoned room wrote anonymous match + player lines; summary ran')
} finally {
  for (const socket of sockets) socket.terminate()
  child.kill()
  await rm(dir, { recursive: true, force: true })
}
