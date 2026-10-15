import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { Channel } from '../net/channel'
import { decodeHello, encodeLobby, FRAME } from '../net/session'
import { decodeResumeToken } from '../net/resume'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import { createDedicatedMatch } from './match'
import { DEDICATED_SNAPSHOT_EVERY } from './snapshot-rate'

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
const END_GRACE_MS = 10_000
const RESUME_GRACE_MS = 12_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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
  state: 'lobby' | 'running' | 'finished'
  revision: number
  nextJoinOrder: number
  match: ReturnType<typeof createDedicatedMatch> | null
  timer: ReturnType<typeof setInterval> | null
  expiry: ReturnType<typeof setTimeout> | null
  lastActivity: number
}

const rooms = new Map<string, Room>()
const clientIps = new WeakMap<WebSocket, string>()
const pendingResumes = new Map<WebSocket, string>()

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
    if (!rooms.has(next)) return next
  }
}

function totalPlayers(): number {
  return members().length
}

function reply(res: import('node:http').ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
      launcherSeat: lead?.seat ?? -1 })
  }
}

function closeRoom(room: Room): void {
  if (!rooms.has(room.code)) return
  rooms.delete(room.code)
  if (room.timer) clearInterval(room.timer)
  if (room.expiry) clearTimeout(room.expiry)
  for (const reservation of room.resumes.values()) clearTimeout(reservation.timer)
  room.resumes.clear()
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
      if (room.members.length === 0) closeRoom(room)
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
  const ships = Array.from({ length: room.seats }, (_, i) =>
    room.members.find(m => m.seat === i)?.ship ?? 'hornet')
  const match = createDedicatedMatch({ setup: { ships, seed: randomBytes(4).readUInt32LE(), respawn: true },
    snapshotEvery: DEDICATED_SNAPSHOT_EVERY })
  room.match = match
  room.state = 'running'
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
    if (room.state === 'lobby') return
    const now = performance.now()
    // Never let a stalled process run an unbounded burst of old ticks.
    let steps = 0
    while (next <= now && steps++ < 3) { match.step(); next += 1000 / 60 }
    if (steps > 3) next = now + 1000 / 60
    if (match.result && room.state === 'running') {
      room.state = 'finished'
      room.expiry = setTimeout(() => closeRoom(room), END_GRACE_MS)
    }
  }), 1000 / 60)
  return null
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { reply(res, 204, {}); return }
  if (req.method === 'GET' && req.url === '/health') {
    reply(res, 200, { ok: true, rooms: rooms.size, players: totalPlayers() }); return
  }
  if (req.method === 'POST' && req.url === '/rooms') {
    const ip = clientIp(req)
    if ([...rooms.values()].filter(room => room.creatorIp === ip).length >= MAX_ROOMS_PER_IP) {
      reply(res, 429, { error: 'too many rooms from this IP' }); return
    }
    if (rooms.size >= MAX_ROOMS || totalPlayers() >= MAX_PLAYERS) {
      reply(res, 503, { error: 'server full' }); return
    }
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
      if (body.length > 1024) req.destroy()
    })
    req.on('end', () => {
      let seats: number
      try { seats = JSON.parse(body).seats } catch { reply(res, 400, { error: 'invalid request' }); return }
      if (!Number.isInteger(seats) || seats < 2 || seats > 4) {
        reply(res, 400, { error: 'seats must be 2 to 4' }); return
      }
      // Recheck after reading the body because another request may have created a room.
      if ([...rooms.values()].filter(room => room.creatorIp === ip).length >= MAX_ROOMS_PER_IP) {
        reply(res, 429, { error: 'too many rooms from this IP' }); return
      }
      if (rooms.size >= MAX_ROOMS || totalPlayers() >= MAX_PLAYERS) {
        reply(res, 503, { error: 'server full' }); return
      }
      const room: Room = { code: code(), creatorIp: ip, seats, members: [], resumes: new Map(), state: 'lobby',
        revision: 0, nextJoinOrder: 0,
        match: null, timer: null, expiry: null, lastActivity: Date.now() }
      rooms.set(room.code, room)
      reply(res, 201, { code: room.code, seats })
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
    // Query-token admission remains for one release while the already-deployed
    // client rolls forward. New clients prove ownership in their first WS frame.
    const reservation = room?.state === 'running' && resumeToken
      ? availableReservation(room, resumeToken) : undefined
    const frameResume = room?.state === 'running' && resumeToken === null && room.resumes.size > 0
    if (url.pathname !== '/ws' || !room ||
        (room.state !== 'lobby' && !reservation && !frameResume) ||
        (room.state === 'lobby' && resumeToken !== null) ||
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
      wss.emit('connection', ws, room, reservation, frameResume)
    })
  } catch {
    if (claimed) claimed.claiming = false
    // A malformed request target can make URL parsing throw. Reject just this
    // connection; an uncaught upgrade error would end every active match.
    try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch { /* already closed */ }
    socket.destroy()
  }
})

function connectSocket(socket: WebSocket, room: Room, reservation?: ResumeReservation): void {
  const seat = reservation?.seat ?? Array.from({ length: room.seats }, (_, i) => i).find(i =>
    !room.members.some(m => m.seat === i))!
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
    resumeToken: randomBytes(32).toString('base64url'), joinedAt: null }
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
      channel.receive(bytes)
      channel.control({ type: 'resume', token: member.resumeToken, graceMs: RESUME_GRACE_MS })
      return
    }
    if (room.state !== 'lobby' || bytes[0] !== FRAME.HELLO) return
    let ship: ShipId
    try { ship = decodeHello(bytes) } catch { channel.close(); return }
    if (!member.shipChosen) member.ship = ship
    if (!member.hello) member.joinedAt = ++room.nextJoinOrder
    member.hello = bytes
    clearTimeout(helloTimeout)
    room.lastActivity = Date.now()
    broadcast(room)
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
      if (reservation && !member.hello) reservation.claiming = false
      else if (code !== 1008 && code !== 1009) reserveSeat(room, member)
      if (room.members.length === 0 && room.resumes.size === 0) closeRoom(room)
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

wss.on('connection', (socket: WebSocket, room: Room, reservation?: ResumeReservation,
  frameResume?: boolean) => {
  if (frameResume) guardRoom(room, 'resume admission', () => awaitResume(socket, room))
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
          (room.members.length === 0 ? EMPTY_ROOM_MS : IDLE_MS)) closeRoom(room)
    })
  }
}, 5_000).unref()

server.listen(PORT, '127.0.0.1', () => console.log(`neon-orbit server listening on ${PORT}`))
process.on('SIGTERM', () => { for (const room of rooms.values()) closeRoom(room); server.close() })
