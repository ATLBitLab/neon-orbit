import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { Channel } from '../net/channel'
import { decodeHello, encodeLobby, FRAME } from '../net/session'
import { decodeResumeToken } from '../net/resume'
import { decodeStatsSession, STATS_SESSION_FRAME } from '../net/stats-session'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import { createDedicatedMatch } from './match'
import { DEDICATED_SNAPSHOT_EVERY } from './snapshot-rate'
import { PotLedger } from './pot-ledger'
import { VoltageReceive } from './voltage-receive'
import { createMatchStats, departureOf, StatsLog, type MatchStats, type Outcome } from './stats'
import { VoltageSend } from './voltage-send'
import { encodeLnurl, fixedMainnetInvoiceAmount } from './lnurl'
import { choosePotWinner } from './pot-winner'

const PORT = Number(process.env.PORT ?? 8080)
const MAX_ROOMS = 8
const MAX_ROOMS_PER_IP = 3
const MAX_PLAYERS = 12
const MAX_CONNECTIONS_PER_IP = 6
const MAX_PENDING_PER_IP = 1
const MAX_PACKET = 256
const MAX_BUFFERED = 2 * 1024 * 1024
const MAX_MESSAGES_PER_SECOND = 120
const MAX_TICK_LEAD = 600
const IDLE_MS = 30 * 60_000
const EMPTY_ROOM_MS = 60_000
const EMPTY_POT_ROOM_MS = 10 * 60_000
const END_GRACE_MS = 10_000
const RESUME_GRACE_MS = 12_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const STATS_SAMPLE_TICKS = 6
// Anonymous match stats (#64). STATS_PATH='' turns recording off.
const statsPath = process.env.STATS_PATH ?? '/var/lib/neon-orbit/match-stats.jsonl'
const statsLog = statsPath ? new StatsLog(statsPath,
  Number(process.env.STATS_MAX_BYTES ?? 50 * 1024 * 1024)) : null
const POT_ENABLED = process.env.POT_ENABLED === '1'
const POT_PUBLIC_URL = process.env.POT_PUBLIC_URL ?? 'https://104-131-185-100.sslip.io'
if (POT_ENABLED && (!/^(0|[1-9]\d{0,3})$/.test(process.env.POT_PROCESSING_FEE_BPS ?? '') ||
    Number(process.env.POT_PROCESSING_FEE_BPS) > 1000)) {
  throw new Error('POT_PROCESSING_FEE_BPS must be set from the wallet fee policy before enabling pot mode')
}
const potLedger = POT_ENABLED
  ? await PotLedger.open(process.env.POT_LEDGER_PATH ?? '/var/lib/neon-orbit/pot-ledger.json') : null
const voltage = potLedger ? new VoltageReceive(potLedger, {
  baseUrl: process.env.VOLTAGE_API_URL ?? 'https://voltageapi.com/v1',
  organizationId: '5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29',
  environmentId: '638fcc72-5f4b-4734-a2d6-8d0ef939b750',
  walletId: '5272faf9-4644-4478-bc21-9f4b57b420a0',
  apiKey: process.env.VOLTAGE_API_KEY ?? '',
}) : null
const voltageSend = potLedger ? new VoltageSend(potLedger, {
  baseUrl: process.env.VOLTAGE_API_URL ?? 'https://voltageapi.com/v1',
  organizationId: '5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29',
  environmentId: '638fcc72-5f4b-4734-a2d6-8d0ef939b750',
  walletId: '5272faf9-4644-4478-bc21-9f4b57b420a0',
  apiKey: process.env.VOLTAGE_API_KEY ?? '',
}) : null
if (potLedger) {
  // Process memory has no rooms after a restart. Every unfinished paid room
  // becomes a refund, including an interrupted match and an abandoned lobby.
  for (const saved of potLedger.listRooms()) {
    if (saved.phase !== 'resolved' && saved.phase !== 'refunding') await potLedger.interrupt(saved.code)
    await potLedger.ensureRefunds(saved.code)
  }
}

interface Member {
  channel: Channel & { receive(bytes: Uint8Array): void; control(value: object): void }
  socket: WebSocket
  ship: ShipId
  seat: number
  hello: Uint8Array | null
  ip: string
  shipChosen: boolean
  resumeToken: string
  joinedAt: number | null
  /** Random per-browser-session id for stats; never tied to IP or token. */
  session: string | null
}

interface ResumeReservation {
  seat: number
  ship: ShipId
  token: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
  claiming: boolean
}

interface Room {
  code: string
  creatorIp: string
  seats: number
  members: Member[]
  resumes: Map<number, ResumeReservation>
  abandoned: Map<number, ReturnType<typeof setTimeout>>
  state: 'lobby' | 'launching' | 'running' | 'settling' | 'finished'
  revision: number
  nextJoinOrder: number
  match: ReturnType<typeof createDedicatedMatch> | null
  timer: ReturnType<typeof setInterval> | null
  expiry: ReturnType<typeof setTimeout> | null
  lastActivity: number
  potBuyInSats: number | null
  /** Score frozen at each paid pilot's last connected tick; AI cannot improve it. */
  potLastScores: Map<number, number>
  potForfeited: Set<number>
  stats: MatchStats | null
}

const rooms = new Map<string, Room>()
const creatingRooms = new Map<string, string>()
const clientIps = new WeakMap<WebSocket, string>()
const pendingResumes = new Map<WebSocket, string>()
const withdrawLinks = new Map<string, { code: string; seat: number; expiresAt: number; used: boolean }>()

/** Stats are best effort: nothing in here may throw into a room. */
function recordStats(room: Room, operation: (stats: MatchStats) => void): void {
  if (!room.stats) return
  try { operation(room.stats) } catch (error) {
    console.error('[neon-orbit] match stats failed', error)
    room.stats = null
  }
}

function finishStats(room: Room, outcome: Outcome): void {
  const match = room.match
  if (!match) return
  recordStats(room, stats => {
    void statsLog?.append(stats.finish(outcome, match.result, seat => match.view(seat)))
  })
  room.stats = null
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function availableReservation(room: Room, token: string): ResumeReservation | undefined {
  return [...room.resumes.values()].find(entry => sameToken(entry.token, token) &&
    entry.expiresAt > Date.now() && !entry.claiming &&
    !room.members.some(member => member.seat === entry.seat))
}

function members(): Member[] {
  return [...rooms.values()].flatMap(room => room.members)
}

function code(): string {
  for (;;) {
    const bytes = randomBytes(6)
    const next = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    if (!rooms.has(next) && !creatingRooms.has(next) && !potLedger?.getRoom(next)) return next
  }
}

function totalPlayers(): number {
  return members().length
}

function availableSeat(room: Room): number | undefined {
  return Array.from({ length: room.seats }, (_, i) => i).find(i =>
    !room.members.some(member => member.seat === i) &&
    (room.potBuyInSats === null || !potLedger?.getRoom(room.code)?.entries.some(entry => entry.seat === i)))
}

function reply(res: import('node:http').ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(JSON.stringify(body))
}

function launcher(room: Room): Member | undefined {
  // Joining means a valid HELLO, not merely an open (possibly idle) socket.
  let lead: Member | undefined
  for (const member of room.members) {
    if (member.joinedAt !== null && (!lead || member.joinedAt < lead.joinedAt!)) lead = member
  }
  return lead
}

function broadcast(room: Room): void {
  room.revision++
  const lead = launcher(room)
  const seats = Array.from({ length: room.seats }, (_, i) => {
    const member = room.members.find(m => m.seat === i)
    return { ship: member?.ship ?? 'hornet', pilot: member ? 'human' : 'ai' } as const
  })
  for (const member of room.members) {
    member.channel.send(encodeLobby({ revision: room.revision, seat: member.seat, seats }))
    member.channel.control({ type: 'room', code: room.code, seats: room.seats,
      players: room.members.length, state: room.state, creator: member === lead,
      launcherSeat: lead?.seat ?? -1,
      ...(room.potBuyInSats === null ? {} : { pot: {
        buyInSats: room.potBuyInSats,
        paidSeats: potLedger?.getRoom(room.code)?.entries
          .filter(entry => entry.state === 'completed' && !entry.canceled).map(entry => entry.seat) ?? [],
      } }),
    })
  }
}

function closeRoom(room: Room): void {
  if (!rooms.has(room.code)) return
  rooms.delete(room.code)
  if (room.potBuyInSats !== null && potLedger) {
    void potLedger.interrupt(room.code).then(() => potLedger.ensureRefunds(room.code))
      .catch(error => console.error(`[neon-orbit] room ${room.code} refund transition failed`, error))
  }
  if (room.timer) clearInterval(room.timer)
  if (room.expiry) clearTimeout(room.expiry)
  if (room.state === 'running') finishStats(room, 'abandoned')
  for (const reservation of room.resumes.values()) clearTimeout(reservation.timer)
  room.resumes.clear()
  for (const timer of room.abandoned.values()) clearTimeout(timer)
  room.abandoned.clear()
  for (const [socket] of pendingResumes) {
    // Pending sockets have no member yet, but must not outlive their room.
    if (socketRoom.get(socket) === room) socket.close(1000)
  }
  // Cleanup itself must not turn one failed room into a process-wide failure.
  try { room.match?.close() } catch (error) {
    console.error(`[neon-orbit] room ${room.code} cleanup failed`, error)
  }
  for (const member of [...room.members]) {
    try { member.channel.close() } catch (error) {
      console.error(`[neon-orbit] room ${room.code} socket cleanup failed`, error)
      try { member.socket.terminate() } catch { /* already closed */ }
    }
  }
  room.members.length = 0
}

function reserveSeat(room: Room, member: Member): void {
  if (room.state !== 'running' || !member.hello || room.match?.result) return
  const seat = member.seat
  const reservation: ResumeReservation = {
    seat, ship: member.ship, token: member.resumeToken,
    expiresAt: Date.now() + RESUME_GRACE_MS, claiming: false,
    timer: setTimeout(() => guardRoom(room, 'resume expiry', () => {
      if (room.resumes.get(seat) !== reservation) return
      room.resumes.delete(seat)
      if (room.potBuyInSats !== null) {
        room.potForfeited.add(seat)
        room.match?.forfeitPotSeat(seat)
      }
      else if (room.members.length === 0) closeRoom(room)
    }), RESUME_GRACE_MS),
  }
  room.resumes.set(seat, reservation)
}

function guardRoom(room: Room, phase: string, operation: () => void): void {
  if (!rooms.has(room.code)) return
  try { operation() } catch (error) {
    console.error(`[neon-orbit] room ${room.code} ${phase} failed`, error)
    closeRoom(room)
  }
}

function startRoom(room: Room): string | null {
  if (room.state !== 'lobby') return null
  if (room.members.filter(member => member.hello).length < 2) {
    return 'at least two players must join before launch'
  }
  if (room.potBuyInSats !== null) {
    const participants = room.members.filter(member => member.hello).map(member => member.seat)
    if (participants.some(seat =>
      potLedger?.getRoom(room.code)?.entries.find(entry => entry.seat === seat)?.canceled)) {
      return 'a refunded seat cannot enter the match'
    }
    if (potLedger?.getRoom(room.code)?.entries.some(entry =>
      entry.state === 'completed' && !entry.canceled && !participants.includes(entry.seat))) {
      return 'a paid player must reclaim their seat before launch'
    }
    if (participants.some(seat =>
      potLedger?.getRoom(room.code)?.entries.find(entry => entry.seat === seat)?.state !== 'completed')) {
      return 'every player must pay before launch'
    }
    room.state = 'launching'
    void potLedger!.launch(room.code, participants).then(() => {
      if (!rooms.has(room.code)) return
      launchMatch(room, participants)
    }).catch(error => {
      console.error(`[neon-orbit] room ${room.code} pot launch failed`, error)
      closeRoom(room)
    })
    return null
  }
  launchMatch(room)
  return null
}

function launchMatch(room: Room, potHumans?: number[]): void {
  const ships = Array.from({ length: room.seats }, (_, i) =>
    room.members.find(m => m.seat === i)?.ship ?? 'hornet')
  const match = createDedicatedMatch({ setup: { ships, seed: randomBytes(4).readUInt32LE(),
    respawn: !potHumans, ...(potHumans ? { potHumans } : {}) },
    snapshotEvery: DEDICATED_SNAPSHOT_EVERY })
  room.match = match
  room.state = 'running'
  if (statsLog) {
    const humans = new Map(room.members.filter(member => member.hello)
      .map(member => [member.seat, member.session] as const))
    try { room.stats = createMatchStats(ships, humans) } catch { room.stats = null }
  }
  broadcast(room)
  // The lobby consumed the first HELLO. Deliver it to the match after its
  // channel handler is installed, in seat order, preserving the lobby seats.
  for (const member of [...room.members].sort((a, b) => a.seat - b.seat)) {
    match.connect(member.channel, member.seat)
    if (member.hello) {
      member.channel.receive(member.hello)
      member.channel.control({ type: 'resume', token: member.resumeToken, graceMs: RESUME_GRACE_MS })
    }
  }
  let next = performance.now()
  room.timer = setInterval(() => guardRoom(room, 'tick', () => {
    if (room.state === 'lobby' || room.state === 'settling') return
    const now = performance.now()
    // Never let a stalled process run an unbounded burst of old ticks.
    let steps = 0
    while (next <= now && steps++ < 3) {
      match.step()
      next += 1000 / 60
      if (match.ticks % STATS_SAMPLE_TICKS === 0) recordStats(room, stats => stats.sample(match.view))
      // A paid result must be sealed in the ledger before any RESULT is sent.
      if (potHumans && match.result) break
    }
    if (steps > 3) next = now + 1000 / 60
    if (match.result && room.state === 'running') {
      if (potHumans && potLedger) {
        room.state = 'settling'
        const connected = room.members.filter(member => member.hello).map(member => member.seat)
        const winnerSeat = choosePotWinner(match.result.lines, potHumans, connected,
          room.potLastScores, room.potForfeited)
        if (winnerSeat === null) { closeRoom(room); return }
        const claimable = potLedger.previewWinner(room.code)
        void potLedger.resolve(room.code, winnerSeat).then(() => {
          if (!rooms.has(room.code)) return
          finishStats(room, match.result!.cleared ? 'cleared' : 'wiped')
          room.state = 'finished'
          match.step() // deliver the sealed RESULT after the ledger commit
          for (const member of room.members) member.channel.control({ type: 'pot-result',
            winnerSeat, claimableSats: claimable / 1000 })
          room.expiry = setTimeout(() => closeRoom(room), END_GRACE_MS)
        }).catch(error => {
          console.error(`[neon-orbit] room ${room.code} result commit failed`, error)
          closeRoom(room)
        })
      } else {
        finishStats(room, match.result.cleared ? 'cleared' : 'wiped')
        room.state = 'finished'
        room.expiry = setTimeout(() => closeRoom(room), END_GRACE_MS)
      }
    }
  }), 1000 / 60)
}

async function claimStatus(code: string, seat: number) {
  const entry = potLedger?.getRoom(code)?.entries.find(item => item.seat === seat)
  if (!entry) throw new Error('claim unavailable')
  if (entry.canceled || potLedger?.getRoom(code)?.phase === 'refunding' ||
      (potLedger?.getRoom(code)?.phase === 'resolved' &&
        !potLedger?.getRoom(code)?.participants?.includes(seat))) {
    await voltage?.poll(code, seat)
    await potLedger?.ensureRefunds(code)
  }
  const entitlement = entry.entitlement
  const latest = entitlement?.sends.at(-1)
  if (latest && latest.state !== 'completed' && latest.state !== 'failed') {
    await voltageSend?.poll(code, seat, latest.id)
  }
  const next = potLedger?.nextPayout(code, seat)
  return { phase: potLedger?.getRoom(code)?.phase ?? 'lobby',
    kind: entitlement?.kind ?? null, amountMsat: next?.amountMsat ?? latest?.amountMsat ??
      entitlement?.amountMsat ?? null,
    expiresAt: entitlement?.expiresAt ?? null,
    state: next ? 'claimable' : latest?.state ?? (entitlement ? 'claimable' : entry.state),
    paymentId: latest?.id ?? null,
    feeNotice: 'Payout or refund is the funded amount less a bounded Lightning fee allowance; unused reserve can be claimed again.' }
}

async function sendClaim(code: string, seat: number, invoice: string) {
  const entry = potLedger?.getRoom(code)?.entries.find(item => item.seat === seat)
  const entitlement = entry?.entitlement
  if (!entitlement || !voltageSend || !potLedger || Date.now() >= entitlement.expiresAt) {
    throw new Error('claim unavailable or expired')
  }
  const active = entitlement.sends.find(send => send.state !== 'failed' && send.state !== 'completed')
  if (active) {
    if (active.invoice !== invoice) throw new Error('claim already submitted')
    const result = active.state === 'prepared'
      ? await voltageSend.submit(code, seat, active.id)
      : await voltageSend.poll(code, seat, active.id)
    if (result.state === 'failed') throw new Error('payment failed; claim reopened')
    const status = await claimStatus(code, seat)
    if (active.state === 'failed') throw new Error('payment failed; claim reopened')
    return status
  }
  const next = potLedger.nextPayout(code, seat)
  if (!next || fixedMainnetInvoiceAmount(invoice) !== next.amountMsat) {
    throw new Error('invoice must be mainnet and match the exact claim amount')
  }
  const send = await potLedger.prepareSend(code, seat, invoice)
  await voltageSend.submit(code, seat, send.id)
  const result = await voltageSend.pollBounded(code, seat, send.id)
  if (result.state === 'failed') throw new Error('payment failed; claim reopened')
  const status = await claimStatus(code, seat)
  if (send.state === 'failed') throw new Error('payment failed; claim reopened')
  return status
}

function claimFromRequest(req: IncomingMessage, url: URL): { code: string; seat: number } | null {
  const code = url.searchParams.get('room') ?? ''
  const seat = Number(url.searchParams.get('seat'))
  const claim = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
  return potLedger?.ownsSeat(code, seat, claim) ? { code, seat } : null
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { reply(res, 204, {}); return }
  if (req.method === 'GET' && req.url === '/health') {
    reply(res, 200, { ok: true, rooms: rooms.size, players: totalPlayers(),
      ...(POT_ENABLED ? { potEnabled: true } : {}) }); return
  }
  if (req.url?.startsWith('/pot/claim?') && req.method === 'GET') {
    if (!potLedger) { reply(res, 404, { error: 'not found' }); return }
    let url: URL
    try { url = new URL(req.url, 'http://localhost') }
    catch { reply(res, 400, { error: 'invalid request' }); return }
    const owner = claimFromRequest(req, url)
    if (!owner) { reply(res, 403, { error: 'invalid claim' }); return }
    void claimStatus(owner.code, owner.seat).then(status => {
      const entry = potLedger.getRoom(owner.code)?.entries.find(item => item.seat === owner.seat)
      const entitlement = entry?.entitlement
      if (!entitlement || !potLedger.nextPayout(owner.code, owner.seat) ||
          Date.now() >= entitlement.expiresAt) { reply(res, 200, status); return }
      for (const [key, link] of withdrawLinks) {
        if (link.code === owner.code && link.seat === owner.seat) withdrawLinks.delete(key)
      }
      const k1 = randomBytes(32).toString('hex')
      withdrawLinks.set(k1, { ...owner, expiresAt: Date.now() + 5 * 60_000, used: false })
      const link = new URL('/lnurlw', POT_PUBLIC_URL)
      link.searchParams.set('k1', k1)
      reply(res, 200, { ...status, lnurl: encodeLnurl(link.toString()) })
    }).catch(() => reply(res, 503, { error: 'claim status unavailable' }))
    return
  }
  if (req.url === '/pot/claim' && req.method === 'POST') {
    if (!potLedger) { reply(res, 404, { error: 'not found' }); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk); if (body.length > 6000) req.destroy() })
    req.on('end', () => {
      let parsed: { code: string; seat: number; invoice: string }
      try {
        parsed = JSON.parse(body) as typeof parsed
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
      } catch {
        reply(res, 400, { error: 'invalid request' }); return
      }
      const claim = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      if (!potLedger.ownsSeat(parsed.code, parsed.seat, claim)) {
        reply(res, 403, { error: 'invalid claim' }); return
      }
      if (typeof parsed.invoice !== 'string') { reply(res, 400, { error: 'invalid invoice' }); return }
      void sendClaim(parsed.code, parsed.seat, parsed.invoice)
        .then(status => reply(res, 200, status))
        .catch(error => reply(res, 409, { error: error instanceof Error ? error.message : 'claim unavailable' }))
    })
    return
  }
  if (req.url === '/pot/cancel' && req.method === 'POST') {
    if (!potLedger) { reply(res, 404, { error: 'not found' }); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk); if (body.length > 1024) req.destroy() })
    req.on('end', () => {
      let code: string, seat: number
      try {
        const parsed = JSON.parse(body) as { code: string; seat: number }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
        code = parsed.code; seat = parsed.seat
      } catch { reply(res, 400, { error: 'invalid request' }); return }
      const claim = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      if (!potLedger.ownsSeat(code, seat, claim)) {
        reply(res, 403, { error: 'invalid claim' }); return
      }
      void potLedger.cancelSeat(code, seat).then(() => {
        const room = rooms.get(code)
        room?.members.find(member => member.seat === seat)?.socket.close(1000)
        if (room) broadcast(room)
        return claimStatus(code, seat)
      }).then(status => reply(res, 200, status))
        .catch(() => reply(res, 409, { error: 'seat cannot be canceled' }))
    })
    return
  }
  if (req.url?.startsWith('/lnurlw') && req.method === 'GET') {
    let url: URL
    try { url = new URL(req.url, 'http://localhost') }
    catch { reply(res, 400, { status: 'ERROR', reason: 'invalid request' }); return }
    const k1 = url.searchParams.get('k1') ?? ''
    const link = withdrawLinks.get(k1)
    if (!link || link.used || Date.now() >= link.expiresAt) {
      reply(res, 404, { status: 'ERROR', reason: 'withdraw link expired' }); return
    }
    if (url.pathname === '/lnurlw') {
      const entitlement = potLedger?.getRoom(link.code)?.entries.find(item => item.seat === link.seat)?.entitlement
      const next = potLedger?.nextPayout(link.code, link.seat)
      if (!entitlement || !next || Date.now() >= entitlement.expiresAt) {
        reply(res, 404, { status: 'ERROR', reason: 'claim expired' }); return
      }
      const callback = new URL('/lnurlw/cb', POT_PUBLIC_URL)
      reply(res, 200, { tag: 'withdrawRequest', callback: callback.toString(), k1,
        defaultDescription: `Neon Orbit ${entitlement.kind}`,
        minWithdrawable: next.amountMsat, maxWithdrawable: next.amountMsat })
      return
    }
    if (url.pathname === '/lnurlw/cb') {
      const invoice = url.searchParams.get('pr') ?? ''
      if (invoice.length > 5000) { reply(res, 400, { status: 'ERROR', reason: 'invoice too long' }); return }
      link.used = true
      void sendClaim(link.code, link.seat, invoice).then(status => {
        if (status.state === 'failed') {
          link.used = false
          reply(res, 200, { status: 'ERROR', reason: 'payment failed; request a new withdraw link' })
          return
        }
        withdrawLinks.delete(k1)
        reply(res, 200, { status: 'OK' })
      }).catch(error => {
        link.used = false
        reply(res, 200, { status: 'ERROR', reason: error instanceof Error ? error.message : 'claim unavailable' })
      })
      return
    }
  }
  if (req.url?.startsWith('/pot?') && req.method === 'GET') {
    if (!potLedger || !voltage) { reply(res, 404, { error: 'not found' }); return }
    const url = new URL(req.url, 'http://localhost')
    const code = url.searchParams.get('room') ?? ''
    const seat = Number(url.searchParams.get('seat'))
    const claim = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    if (!potLedger.ownsSeat(code, seat, claim)) { reply(res, 403, { error: 'invalid claim' }); return }
    void voltage.poll(code, seat).then(entry => {
      const room = rooms.get(code)
      if (room?.state === 'lobby') broadcast(room)
      reply(res, 200, { paymentId: entry.paymentId, state: entry.state, invoice: entry.invoice })
    }).catch(() => reply(res, 503, { error: 'payment status unavailable' }))
    return
  }
  if (req.url === '/pot' && req.method === 'POST') {
    if (!potLedger || !voltage) { reply(res, 404, { error: 'not found' }); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk); if (body.length > 1024) req.destroy() })
    req.on('end', () => {
      let code: string, seat: number
      try {
        const parsed = JSON.parse(body) as { code: string; seat: number }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
        code = parsed.code; seat = parsed.seat
      } catch { reply(res, 400, { error: 'invalid request' }); return }
      const claim = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      if (!potLedger.ownsSeat(code, seat, claim)) { reply(res, 403, { error: 'invalid claim' }); return }
      if (potLedger.getRoom(code)?.phase !== 'lobby' || rooms.get(code)?.state !== 'lobby') {
        reply(res, 409, { error: 'room is no longer accepting payments' }); return
      }
      if (potLedger.getRoom(code)?.entries.find(item => item.seat === seat)?.canceled) {
        reply(res, 409, { error: 'seat was canceled' }); return
      }
      void (async () => {
        const current = potLedger.getRoom(code)!.entries.find(item => item.seat === seat)!
        if (current.state === 'prepared') await voltage.submit(code, seat)
        const entry = await voltage.pollUntilInvoice(code, seat)
        reply(res, 200, { paymentId: entry.paymentId, state: entry.state, invoice: entry.invoice })
      })().catch(() => reply(res, 503, { error: 'payment unavailable' }))
    })
    return
  }
  if (req.method === 'POST' && req.url === '/rooms') {
    const ip = clientIp(req)
    if ([...rooms.values()].filter(room => room.creatorIp === ip).length +
        [...creatingRooms.values()].filter(value => value === ip).length >= MAX_ROOMS_PER_IP) {
      reply(res, 429, { error: 'too many rooms from this IP' }); return
    }
    if (rooms.size + creatingRooms.size >= MAX_ROOMS || totalPlayers() >= MAX_PLAYERS) {
      reply(res, 503, { error: 'server full' }); return
    }
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
      if (body.length > 1024) req.destroy()
    })
    req.on('end', () => {
      let seats: number, potBuyInSats: number | null
      try {
        const parsed = JSON.parse(body) as { seats: number; pot?: { buyInSats: number } }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
        seats = parsed.seats
        potBuyInSats = parsed.pot === undefined ? null : (parsed.pot?.buyInSats ?? NaN)
      } catch { reply(res, 400, { error: 'invalid request' }); return }
      if (!Number.isInteger(seats) || seats < 2 || seats > 4) {
        reply(res, 400, { error: 'seats must be 2 to 4' }); return
      }
      if (potBuyInSats !== null && (!potLedger || !Number.isInteger(potBuyInSats) ||
          potBuyInSats < 10 || potBuyInSats > 1000)) {
        reply(res, 400, { error: 'pot unavailable or invalid buy-in' }); return
      }
      // Recheck after reading the body because another request may have created a room.
      if ([...rooms.values()].filter(room => room.creatorIp === ip).length +
          [...creatingRooms.values()].filter(value => value === ip).length >= MAX_ROOMS_PER_IP) {
        reply(res, 429, { error: 'too many rooms from this IP' }); return
      }
      if (rooms.size + creatingRooms.size >= MAX_ROOMS || totalPlayers() >= MAX_PLAYERS) {
        reply(res, 503, { error: 'server full' }); return
      }
      const room: Room = { code: code(), creatorIp: ip, seats, members: [], resumes: new Map(),
        abandoned: new Map(), potLastScores: new Map(), potForfeited: new Set(), state: 'lobby',
        revision: 0, nextJoinOrder: 0,
        match: null, timer: null, expiry: null, lastActivity: Date.now(), potBuyInSats, stats: null }
      creatingRooms.set(room.code, ip)
      void (async () => {
        if (potBuyInSats !== null) await potLedger!.createRoom(room.code, seats, potBuyInSats)
        creatingRooms.delete(room.code)
        rooms.set(room.code, room)
        reply(res, 201, { code: room.code, seats,
          ...(potBuyInSats === null ? {} : { pot: { buyInSats: potBuyInSats } }) })
      })().catch(() => { creatingRooms.delete(room.code); reply(res, 503, { error: 'room unavailable' }) })
    })
    return
  }
  reply(res, 404, { error: 'not found' })
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET, perMessageDeflate: false })
const socketRoom = new WeakMap<WebSocket, Room>()
function clientIp(request: IncomingMessage): string {
  const direct = request.socket.remoteAddress ?? 'unknown'
  // Only the loopback Caddy hop may supply the actual public client IP.
  return (direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1')
    ? String(request.headers['x-real-ip'] ?? direct) : direct
}
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  let claimed: ResumeReservation | undefined
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const room = rooms.get(url.searchParams.get('room')?.toUpperCase() ?? '')
    const ip = clientIp(request)
    const sameIp = members().filter(member => member.ip === ip)
    const resumeToken = url.searchParams.get('resume')
    const potSeatParam = url.searchParams.get('potSeat')
    const potSeat = potSeatParam !== null && /^\d$/.test(potSeatParam) ? Number(potSeatParam) : null
    const potClaim = !!(room && room.state === 'lobby' && room.potBuyInSats !== null &&
      potSeat !== null && potSeat < room.seats &&
      potLedger?.getRoom(room.code)?.entries.some(entry => entry.seat === potSeat) &&
      !room.members.some(member => member.seat === potSeat))
    // Query-token admission remains for one release while the already-deployed
    // client rolls forward. New clients prove ownership in their first WS frame.
    const reservation = room?.state === 'running' && resumeToken
      ? availableReservation(room, resumeToken) : undefined
    const frameResume = room?.state === 'running' && resumeToken === null && room.resumes.size > 0
    if (url.pathname !== '/ws' || !room ||
        (room.state !== 'lobby' && !reservation && !frameResume) ||
        (room.state === 'lobby' && resumeToken !== null) ||
        (room.state === 'lobby' && availableSeat(room) === undefined && !potClaim) ||
        (potSeatParam !== null && !potClaim) ||
        room.members.length >= room.seats || totalPlayers() >= MAX_PLAYERS ||
        sameIp.length + [...pendingResumes.values()].filter(value => value === ip).length >= MAX_CONNECTIONS_PER_IP ||
        sameIp.filter(member => !member.hello).length +
          [...pendingResumes.values()].filter(value => value === ip).length >= MAX_PENDING_PER_IP ||
        pendingResumes.size >= MAX_PLAYERS) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (reservation) {
      reservation.claiming = true
      claimed = reservation
    }
    wss.handleUpgrade(request, socket, head, ws => {
      clientIps.set(ws, ip)
      socketRoom.set(ws, room)
      wss.emit('connection', ws, room, reservation, frameResume, potClaim ? potSeat : undefined)
    })
  } catch {
    if (claimed) claimed.claiming = false
    // A malformed request target can make URL parsing throw. Reject just this
    // connection; an uncaught upgrade error would end every active match.
    try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch { /* already closed */ }
    socket.destroy()
  }
})

function connectSocket(socket: WebSocket, room: Room, reservation?: ResumeReservation,
  potReclaimSeat?: number): void {
  const seat = reservation?.seat ?? potReclaimSeat ?? availableSeat(room)!
  const messages: ((bytes: Uint8Array) => void)[] = []
  const closers: (() => void)[] = []
  let closed = false
  let notified = false
  let count = 0
  let second = Math.floor(Date.now() / 1000)
  const channel: Member['channel'] = {
    get open() { return !closed && socket.readyState === WebSocket.OPEN },
    send(bytes) {
      if (!this.open) return
      if (socket.bufferedAmount > MAX_BUFFERED) { socket.close(1008, 'slow receiver'); return }
      socket.send(bytes, { binary: true })
    },
    control(value) {
      if (this.open) socket.send(JSON.stringify(value))
    },
    onMessage(handler) { messages.push(handler) },
    onClose(handler) { closers.push(handler) },
    receive(bytes) { for (const handler of [...messages]) handler(bytes) },
    close() { socket.close(1000) },
  }
  const member: Member = { channel, socket, seat, ship: reservation?.ship ?? 'hornet', hello: null,
    ip: clientIps.get(socket) ?? 'unknown', shipChosen: false,
    resumeToken: randomBytes(32).toString('base64url'), joinedAt: null,
    session: null }
  const helloTimeout = setTimeout(() => guardRoom(room, 'hello timeout', () => {
    if (!member.hello) socket.close(1008, 'hello timeout')
  }), 5000)
  let awaitingPong = false
  const heartbeat = setInterval(() => guardRoom(room, 'heartbeat', () => {
    if (awaitingPong) socket.terminate()
    else { awaitingPong = true; socket.ping() }
  }), 15_000)
  socket.on('pong', () => { awaitingPong = false })
  channel.onMessage(bytes => {
    if (reservation) {
      if (member.hello) return
      if (room.state !== 'running' || room.resumes.get(seat) !== reservation ||
          Date.now() >= reservation.expiresAt || bytes[0] !== FRAME.HELLO) {
        socket.close(1008, 'resume expired'); return
      }
      try { decodeHello(bytes) } catch { socket.close(1008, 'invalid hello'); return }
      member.hello = bytes
      member.joinedAt = ++room.nextJoinOrder
      clearTimeout(helloTimeout)
      clearTimeout(reservation.timer)
      room.resumes.delete(seat)
      room.match!.connect(channel, seat)
      recordStats(room, stats => stats.rejoin(seat))
      channel.receive(bytes)
      channel.control({ type: 'resume', token: member.resumeToken, graceMs: RESUME_GRACE_MS })
      return
    }
    if (room.state !== 'lobby' || bytes[0] !== FRAME.HELLO) return
    let ship: ShipId
    try { ship = decodeHello(bytes) } catch { channel.close(); return }
    if (!member.shipChosen) member.ship = ship
    const firstHello = !member.hello
    if (firstHello) member.joinedAt = ++room.nextJoinOrder
    member.hello = bytes
    if (room.abandoned.has(seat)) {
      clearTimeout(room.abandoned.get(seat)!)
      room.abandoned.delete(seat)
    }
    clearTimeout(helloTimeout)
    room.lastActivity = Date.now()
    broadcast(room)
    if (firstHello && potReclaimSeat === undefined && room.potBuyInSats !== null && potLedger) {
      void potLedger.prepareSeat(room.code, seat).then(({ entry, claim }) => {
        if (member.channel.open) channel.control({ type: 'pot', seat, buyInSats: room.potBuyInSats,
          paymentId: entry.paymentId, claim })
      }).catch(error => guardRoom(room, 'pot seat', () => { throw error }))
    }
  })
  socket.on('message', (data, binary) => guardRoom(room, 'message', () => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : Array.isArray(data) ? Buffer.concat(data) : data
    const now = Math.floor(Date.now() / 1000)
    if (now !== second) { second = now; count = 0 }
    if (++count > MAX_MESSAGES_PER_SECOND || bytes.byteLength > MAX_PACKET) {
      socket.close(1008, 'rate limit'); return
    }
    room.lastActivity = Date.now()
    if (binary) {
      // Stats session: at most once, before HELLO, and never forwarded to the match.
      if (bytes[0] === STATS_SESSION_FRAME) {
        if (!member.hello && member.session === null) member.session = decodeStatsSession(bytes)
        return
      }
      if (room.state === 'running' && bytes[0] === FRAME.INTENT && bytes.byteLength >= 7) {
        const tick = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3, true)
        if (tick > (room.match?.ticks ?? 0) + MAX_TICK_LEAD) {
          socket.close(1008, 'future tick'); return
        }
      }
      channel.receive(new Uint8Array(bytes))
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(String(data)) } catch {
      socket.close(1008, 'invalid control'); return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      socket.close(1008, 'invalid control'); return
    }
    const message = parsed as Record<string, unknown>
    if ((message.type !== 'ship' && message.type !== 'start') ||
        (message.type === 'ship' && !SHIP_ORDER.includes(message.ship as ShipId))) {
      socket.close(1008, 'invalid control'); return
    }
    if (message.type === 'ship' && room.state === 'lobby' && member.hello) {
      member.ship = message.ship as ShipId
      member.shipChosen = true
      broadcast(room)
      return
    }
    if (message.type === 'start' && member === launcher(room)) {
      const error = startRoom(room)
      if (error) channel.control({ type: 'error', message: error })
    }
  }))
  socket.on('close', (code) => {
    if (notified) return
    notified = true
    closed = true
    clearTimeout(helloTimeout)
    clearInterval(heartbeat)
    guardRoom(room, 'disconnect', () => {
      for (const handler of closers) handler()
      const index = room.members.indexOf(member)
      if (index >= 0) room.members.splice(index, 1)
      if (room.state === 'running' && member.hello) recordStats(room, stats => stats.leave(seat, departureOf(code)))
      if (room.state === 'running' && room.potBuyInSats !== null && member.hello) {
        room.potLastScores.set(seat, room.match?.view(seat)?.score ?? 0)
      }
      if (reservation && !member.hello) reservation.claiming = false
      else if (code !== 1008 && code !== 1009) reserveSeat(room, member)
      else if (room.state === 'running' && room.potBuyInSats !== null) {
        room.potForfeited.add(seat)
        room.match?.forfeitPotSeat(seat)
      }
      if (room.state === 'lobby' && room.potBuyInSats !== null && potLedger &&
          potLedger.getRoom(room.code)?.entries.some(entry => entry.seat === seat && !entry.canceled)) {
        room.abandoned.set(seat, setTimeout(() => guardRoom(room, 'abandoned seat', () => {
          if (room.members.some(other => other.seat === seat)) return
          void potLedger.cancelSeat(room.code, seat).then(() => {
            room.abandoned.delete(seat)
            if (rooms.has(room.code)) broadcast(room)
          }).catch(error => console.error(`[neon-orbit] room ${room.code} seat refund failed`, error))
        }), EMPTY_POT_ROOM_MS))
      }
      if (room.members.length === 0 && room.resumes.size === 0 && room.potBuyInSats === null) closeRoom(room)
      else if (room.state === 'lobby') broadcast(room)
    })
  })
  socket.on('error', () => guardRoom(room, 'socket error', () => socket.close()))
  room.members.push(member)
  room.lastActivity = Date.now()
  if (room.state === 'lobby') broadcast(room)
}

function awaitResume(socket: WebSocket, room: Room): void {
  const ip = clientIps.get(socket) ?? 'unknown'
  pendingResumes.set(socket, ip)
  const timeout = setTimeout(() => socket.close(1008, 'resume timeout'), 5000)
  const cleanup = () => { clearTimeout(timeout); pendingResumes.delete(socket) }
  socket.once('close', cleanup)
  socket.on('error', () => socket.terminate())
  socket.once('message', (data, binary) => {
    if (!binary) { socket.close(1008, 'invalid resume'); return }
    let token: string
    try { token = decodeResumeToken(Buffer.from(data as ArrayBuffer)) } catch {
      socket.close(1008, 'invalid resume'); return
    }
    const reservation = rooms.has(room.code) && room.state === 'running'
      ? availableReservation(room, token) : undefined
    if (!reservation) { socket.close(1008, 'invalid resume'); return }
    reservation.claiming = true
    cleanup()
    guardRoom(room, 'resume connection', () => connectSocket(socket, room, reservation))
  })
}

function awaitPotClaim(socket: WebSocket, room: Room, seat: number): void {
  const ip = clientIps.get(socket) ?? 'unknown'
  pendingResumes.set(socket, ip)
  const timeout = setTimeout(() => socket.close(1008, 'pot claim timeout'), 5000)
  const cleanup = () => { clearTimeout(timeout); pendingResumes.delete(socket) }
  socket.once('close', cleanup)
  socket.on('error', () => socket.terminate())
  socket.once('message', (data, binary) => {
    guardRoom(room, 'pot claim admission', () => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      const claim = bytes.subarray(2).toString('ascii')
      if (!binary || bytes.length !== 45 || bytes[0] !== 9 || bytes[1] !== seat ||
          !potLedger?.ownsSeat(room.code, seat, claim) ||
          potLedger.getRoom(room.code)?.entries.find(entry => entry.seat === seat)?.canceled ||
          !rooms.has(room.code) ||
          room.state !== 'lobby' || room.members.some(member => member.seat === seat)) {
        socket.close(1008, 'invalid pot claim'); return
      }
      cleanup()
      connectSocket(socket, room, undefined, seat)
    })
  })
}

wss.on('connection', (socket: WebSocket, room: Room, reservation?: ResumeReservation,
  frameResume?: boolean, potReclaimSeat?: number) => {
  if (frameResume) guardRoom(room, 'resume admission', () => awaitResume(socket, room))
  else if (potReclaimSeat !== undefined) guardRoom(room, 'pot claim admission', () => awaitPotClaim(socket, room, potReclaimSeat))
  else guardRoom(room, 'connection', () => connectSocket(socket, room, reservation))
  // A failure before the new socket joins room.members still has to close it.
  if (!rooms.has(room.code)) {
    try { socket.close(1000) } catch {
      try { socket.terminate() } catch { /* already closed */ }
    }
  }
})

setInterval(() => {
  for (const room of rooms.values()) {
    guardRoom(room, 'idle cleanup', () => {
      if (room.state === 'lobby' && Date.now() - room.lastActivity >
          (room.members.length === 0
            ? (room.potBuyInSats === null ? EMPTY_ROOM_MS : EMPTY_POT_ROOM_MS)
            : IDLE_MS)) closeRoom(room)
    })
  }
}, 5_000).unref()

if (potLedger && voltage) {
  // A payer may settle after a room has expired or after this process restarts.
  // Keep querying the persisted receive UUID and surface the refund once it is
  // truly completed. GET failures leave the liability intact for the next pass.
  let reconciling = false
  setInterval(() => {
    if (reconciling) return
    reconciling = true
    void (async () => {
      for (const saved of potLedger.listRooms()) {
        for (const entry of saved.entries) {
          if (!['prepared', 'completed', 'failed', 'expired'].includes(entry.state)) {
            await voltage.poll(saved.code, entry.seat)
          }
          for (const send of entry.entitlement?.sends ?? []) {
            if (send.state !== 'completed' && send.state !== 'failed') {
              await voltageSend?.poll(saved.code, entry.seat, send.id)
            }
          }
        }
        if (saved.phase === 'refunding' || saved.phase === 'resolved' ||
            saved.entries.some(entry => entry.canceled)) {
          await potLedger.ensureRefunds(saved.code)
        }
        const room = rooms.get(saved.code)
        if (room?.state === 'lobby') broadcast(room)
      }
      await potLedger.collect()
    })().catch(error => console.error('[neon-orbit] pot reconciliation failed', error))
      .finally(() => { reconciling = false })
  }, 15_000).unref()
}

server.listen(PORT, '127.0.0.1', () => console.log(`neon-orbit server listening on ${PORT}`))
process.on('SIGTERM', () => { for (const room of rooms.values()) closeRoom(room); server.close() })
