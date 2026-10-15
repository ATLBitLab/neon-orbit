/**
 * Anonymous match stats (#64): recorder against a real headless match, and the
 * size-capped log. The listener path is covered by scripts/server-stats.mjs.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SeatLine } from '../src/core/scores'
import { createDedicatedMatch } from '../src/server/match'
import { createMatchStats, departureOf, StatsLog } from '../src/server/stats'
import { createHeadlessGame } from '../src/server/match'
import { joinServer } from '../src/net/server'
import { decodeStatsSession, encodeStatsSession, STATS_SESSION_FRAME } from '../src/net/stats-session'
import { RESUME_FRAME } from '../src/net/resume'

export const MATCH_KEYS = ['durationS', 'humans', 'match', 'outcome', 'seats', 'ships', 'startedHour', 'type', 'v']
export const PLAYER_KEYS = ['damageTaken', 'deathPositions', 'deaths', 'hitRate', 'hits', 'kills', 'left',
  'livesS', 'match', 'place', 'seat', 'session', 'ship', 'shots', 'timeToFirstKillS', 'type', 'v', 'won']

let failures = 0
function check(label: string, run: () => void | Promise<void>) {
  return Promise.resolve().then(run).then(() => console.log(`  ok  ${label}`), (error: unknown) => {
    failures++
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  })
}

console.log('Anonymous match stats')

await check('a headless AI match to its end produces exact-key match and player lines', () => {
  const match = createDedicatedMatch({ setup: { ships: ['drone', 'hornet', 'wasp'], seed: 7, respawn: true } })
  try {
    const session = 'AbCdEfGhIjKlMnOpQrStUv'
    const stats = createMatchStats(['drone', 'hornet', 'wasp'], new Map([[0, session], [2, null]]),
      Date.UTC(2026, 9, 15, 14, 37, 12))
    let ticks = 0
    while (!match.result && ticks < 60 * 60 * 20) {
      match.step()
      if (++ticks % 6 === 0) stats.sample(match.view)
    }
    assert.ok(match.result, 'match resolved within 20 simulated minutes')
    stats.leave(2, 'disconnect')
    const lines = stats.finish(match.result.cleared ? 'cleared' : 'wiped', match.result, match.view) as Record<string, any>[]
    assert.equal(lines.length, 3, 'one match line plus one per human seat (AI seat 1 skipped)')
    assert.deepEqual(Object.keys(lines[0]).sort(), MATCH_KEYS)
    for (const line of lines.slice(1)) assert.deepEqual(Object.keys(line).sort(), PLAYER_KEYS)
    assert.equal(lines[0].startedHour, '2026-10-15T14:00:00.000Z', 'start time is coarse')
    assert.equal(lines[0].humans, 2)
    const [, p0, p2] = lines
    assert.equal(p0.session, session)
    assert.equal(p2.session, null)
    assert.equal(p0.left, 'end')
    assert.equal(p2.left, 'disconnect')
    for (const [player, seat] of [[p0, 0], [p2, 2]] as const) {
      const truth: SeatLine = match.result!.lines[seat]
      assert.equal(player.kills, truth.kills, `seat ${seat} kills`)
      assert.equal(player.deaths, truth.deaths, `seat ${seat} deaths`)
      assert.equal(player.shots, truth.shots)
      assert.equal(player.deathPositions.length, Math.min(40, truth.deaths), `seat ${seat} one position per death`)
      assert.ok(player.livesS.length >= truth.deaths, 'a life per death')
      if (truth.kills > 0) assert.ok(player.timeToFirstKillS > 0 && player.timeToFirstKillS <= match.result.time)
      else assert.equal(player.timeToFirstKillS, null)
      for (const position of player.deathPositions) assert.ok(position.every((v: number) => v % 100 === 0))
    }
    assert.ok(lines.some(line => line.deaths > 0 && line.damageTaken > 0), 'damage taken recorded for a seat that died')
    assert.deepEqual(stats.finish('abandoned', null, match.view), [], 'finish only seals once')
  } finally { match.close() }
})

await check('session ids and close codes are parsed narrowly', () => {
  const frame = encodeStatsSession('AbCdEfGhIjKlMnOpQrStUv')
  assert.equal(frame[0], STATS_SESSION_FRAME)
  assert.equal(decodeStatsSession(frame), 'AbCdEfGhIjKlMnOpQrStUv')
  for (const bad of ['short', '127.0.0.1', 'x'.repeat(33), 'npub1abc def ghi jkl mno']) {
    const raw = new Uint8Array([STATS_SESSION_FRAME, ...new TextEncoder().encode(bad)])
    assert.equal(decodeStatsSession(raw), null, bad)
    assert.throws(() => encodeStatsSession(bad))
  }
  assert.equal(decodeStatsSession(new Uint8Array([1, ...frame.subarray(1)])), null, 'wrong frame type')
  assert.equal(departureOf(1000), 'quit')
  assert.equal(departureOf(1001), 'quit')
  assert.equal(departureOf(1005), 'quit')
  assert.equal(departureOf(1006), 'disconnect')
  assert.equal(departureOf(1008), 'disconnect')
})

await check('the log rotates at its cap and swallows write failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-stats-'))
  try {
    const path = join(dir, 'stats.jsonl')
    const log = new StatsLog(path, 1000)
    for (let i = 0; i < 30; i++) await log.append([{ type: 'player', i, pad: 'x'.repeat(80) }])
    assert.ok((await stat(path)).size <= 1000, 'current file under cap')
    assert.ok((await stat(`${path}.1`)).size <= 1000, 'one rotated file under cap')
    const tail = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(tail.at(-1).i, 29, 'newest line kept')
    const broken = new StatsLog(join(dir, 'missing', 'stats.jsonl'), 1000)
    const error = console.error
    let logged = 0
    console.error = () => { logged++ }
    try {
      await broken.append([{ a: 1 }])
      await broken.append([{ a: 2 }])
    } finally { console.error = error }
    assert.equal(logged, 1, 'a failing path logs once and never throws')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

await check('the client sends its session in a frame before HELLO, never in the URL', async () => {
  const opened: { url: string; sent: Uint8Array[]; socket: any }[] = []
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    binaryType = ''
    onopen: (() => void) | null = null
    onmessage = null; onerror = null; onclose = null
    sent: Uint8Array[] = []
    constructor(url: URL | string) { opened.push({ url: String(url), sent: this.sent, socket: this }) }
    send(data: Uint8Array | string) { if (typeof data !== 'string') this.sent.push(data) }
    close() {}
  }
  const store = new Map<string, string>()
  const globals = globalThis as any
  const saved = { WebSocket: globals.WebSocket, sessionStorage: globals.sessionStorage }
  globals.WebSocket = FakeSocket
  globals.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
  const headless = createHeadlessGame()
  try {
    const handlers = { status() {}, active: () => true, onWelcome() {}, onRefused() {}, onLobby() {}, onLink() {} }
    const join = joinServer(headless.game, 'https://example.test', 'ABCDEF', 'drone', handlers)
    opened[0].socket.onopen()
    await join
    const url = new URL(opened[0].url)
    assert.deepEqual([...url.searchParams.keys()], ['room'], 'only the room code is in the upgrade URL')
    assert.equal(opened[0].sent[0][0], STATS_SESSION_FRAME, 'session frame goes first')
    const session = decodeStatsSession(opened[0].sent[0])
    assert.ok(session, 'and decodes')
    assert.equal(opened[0].sent[1][0], 1, 'HELLO follows')
    const again = joinServer(headless.game, 'https://example.test', 'ABCDEF', 'wasp', handlers)
    opened[1].socket.onopen()
    await again
    assert.equal(decodeStatsSession(opened[1].sent[0]), session, 'same id for the whole browser session')
    const resumed = joinServer(headless.game, 'https://example.test', 'ABCDEF', 'wasp', handlers, 'r'.repeat(43))
    opened[2].socket.onopen()
    await resumed
    assert.equal(opened[2].sent[0][0], RESUME_FRAME, 'a resume sends its token first')
    assert.ok(!opened[2].sent.some(frame => frame[0] === STATS_SESSION_FRAME), 'and no session frame')
    const paid = joinServer(headless.game, 'https://example.test', 'ABCDEF', 'wasp', handlers, undefined,
      { seat: 1, token: 'p'.repeat(43) })
    opened[3].socket.onopen()
    await paid
    assert.deepEqual(opened[3].sent.map(frame => frame[0]), [9, STATS_SESSION_FRAME, 1],
      'a pot reclaim keeps its claim proof first, then the session, then HELLO')
    assert.ok(opened.every(entry => !entry.url.includes(session!)), 'the id is in no URL')
  } finally {
    headless.close()
    globals.WebSocket = saved.WebSocket
    globals.sessionStorage = saved.sessionStorage
  }
})

if (failures > 0) { console.log(`\n${failures} stats check(s) failed`); process.exit(1) }
console.log('\nstats checks passed')
