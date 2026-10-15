import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { Channel } from '../net/channel'
import { decodeHello, encodeLobby, FRAME } from '../net/session'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import { createDedicatedMatch } from './match'

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
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface Member {
  channel: Channel & { receive(bytes: Uint8Array): void; control(value: object): void }
  socket: WebSocket
  ship: ShipId
  seat: number
  hello: Uint8Array | null
  ip: string
  shipChosen: boolean
}

interface Room {
  code: string
  creatorIp: string
  seats: number
  members: Member[]
  state: 'lobby' | 'running' | 'finished'
  revision: number
  match: ReturnType<typeof createDedicatedMatch> | null
  timer: ReturnType<typeof setInterval> | null
  expiry: ReturnType<typeof setTimeout> | null
  lastActivity: number
}

const rooms = new Map<string, Room>()
const clientIps = new WeakMap<WebSocket, string>()

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

function broadcast(room: Room): void {
  room.revision++
  const seats = Array.from({ length: room.seats }, (_, i) => {
    const member = room.members.find(m => m.seat === i)
    return { ship: member?.ship ?? 'hornet', pilot: member ? 'human' : 'ai' } as const
  })
  for (const member of room.members) {
    member.channel.send(encodeLobby({ revision: room.revision, seat: member.seat, seats }))
    member.channel.control({ type: 'room', code: room.code, seats: room.seats,
      players: room.members.length, state: room.state, creator: member.seat === 0 })
  }
}

function closeRoom(room: Room): void {
  if (!rooms.has(room.code)) return
  rooms.delete(room.code)
  if (room.timer) clearInterval(room.timer)
  if (room.expiry) clearTimeout(room.expiry)
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
  const match = createDedicatedMatch({ setup: { ships, seed: randomBytes(4).readUInt32LE(), respawn: true } })
  room.match = match
  room.state = 'running'
  broadcast(room)
  // The lobby consumed the first HELLO. Deliver it to the match after its
  // channel handler is installed, in seat order, preserving the lobby seats.
  for (const member of [...room.members].sort((a, b) => a.seat - b.seat)) {
    match.connect(member.channel, member.seat)
    if (member.hello) member.channel.receive(member.hello)
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
      const room: Room = { code: code(), creatorIp: ip, seats, members: [], state: 'lobby', revision: 0,
        match: null, timer: null, expiry: null, lastActivity: Date.now() }
      rooms.set(room.code, room)
      reply(res, 201, { code: room.code, seats })
    })
    return
  }
  reply(res, 404, { error: 'not found' })
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET, perMessageDeflate: false })
function clientIp(request: IncomingMessage): string {
  const direct = request.socket.remoteAddress ?? 'unknown'
  // Only the loopback Caddy hop may supply the actual public client IP.
  return (direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1')
    ? String(request.headers['x-real-ip'] ?? direct) : direct
}
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const room = rooms.get(url.searchParams.get('room')?.toUpperCase() ?? '')
  const ip = clientIp(request)
  const sameIp = members().filter(member => member.ip === ip)
  if (url.pathname !== '/ws' || !room || room.state !== 'lobby' ||
      room.members.length >= room.seats || totalPlayers() >= MAX_PLAYERS ||
      sameIp.length >= MAX_CONNECTIONS_PER_IP ||
      sameIp.filter(member => !member.hello).length >= MAX_PENDING_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, ws => {
    clientIps.set(ws, ip)
    wss.emit('connection', ws, room)
  })
})

function connectSocket(socket: WebSocket, room: Room): void {
  const seat = Array.from({ length: room.seats }, (_, i) => i).find(i =>
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
  const member: Member = { channel, socket, seat, ship: 'hornet', hello: null,
    ip: clientIps.get(socket) ?? 'unknown', shipChosen: false }
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
    if (room.state !== 'lobby' || bytes[0] !== FRAME.HELLO) return
    let ship: ShipId
    try { ship = decodeHello(bytes) } catch { channel.close(); return }
    if (!member.shipChosen) member.ship = ship
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
    let message: { type?: string; ship?: unknown }
    try { message = JSON.parse(String(data)) } catch { socket.close(1008, 'invalid control'); return }
    if (message.type === 'ship' && room.state === 'lobby' && member.hello &&
        SHIP_ORDER.includes(message.ship as ShipId)) {
      member.ship = message.ship as ShipId
      member.shipChosen = true
      broadcast(room)
      return
    }
    if (message.type === 'start' && seat === 0) {
      const error = startRoom(room)
      if (error) channel.control({ type: 'error', message: error })
    }
  }))
  socket.on('close', () => {
    if (notified) return
    notified = true
    closed = true
    clearTimeout(helloTimeout)
    clearInterval(heartbeat)
    guardRoom(room, 'disconnect', () => {
      for (const handler of closers) handler()
      const index = room.members.indexOf(member)
      if (index >= 0) room.members.splice(index, 1)
      if (room.members.length === 0 || (seat === 0 && room.state === 'lobby')) closeRoom(room)
      else if (room.state === 'lobby') broadcast(room)
    })
  })
  socket.on('error', () => guardRoom(room, 'socket error', () => socket.close()))
  room.members.push(member)
  room.lastActivity = Date.now()
  broadcast(room)
}

wss.on('connection', (socket: WebSocket, room: Room) => {
  guardRoom(room, 'connection', () => connectSocket(socket, room))
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
