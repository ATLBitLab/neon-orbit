import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { Channel } from '../net/channel'
import { decodeHello, encodeLobby, FRAME } from '../net/session'
import type { ShipId } from '../ships/specs'
import { createDedicatedMatch } from './match'

const PORT = Number(process.env.PORT ?? 8080)
const MAX_ROOMS = 8
const MAX_PLAYERS = 6
const MAX_PACKET = 256
const MAX_BUFFERED = 2 * 1024 * 1024
const MAX_MESSAGES_PER_SECOND = 120
const IDLE_MS = 30 * 60_000
const END_GRACE_MS = 10_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface Member {
  channel: Channel & { receive(bytes: Uint8Array): void; control(value: object): void }
  socket: WebSocket
  ship: ShipId
  seat: number
  hello: Uint8Array | null
}

interface Room {
  code: string
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

function code(): string {
  for (;;) {
    const bytes = randomBytes(6)
    const next = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    if (!rooms.has(next)) return next
  }
}

function totalPlayers(): number {
  return [...rooms.values()].reduce((sum, room) => sum + room.members.length, 0)
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
  room.match?.close()
  for (const member of [...room.members]) member.channel.close()
  room.members.length = 0
}

function startRoom(room: Room): void {
  if (room.state !== 'lobby') return
  if (room.members.length < 2) throw new Error('at least two players must join before launch')
  const ships = Array.from({ length: room.seats }, (_, i) =>
    room.members.find(m => m.seat === i)?.ship ?? 'hornet')
  const match = createDedicatedMatch({ setup: { ships, seed: randomBytes(4).readUInt32LE(), respawn: true } })
  room.match = match
  room.state = 'running'
  broadcast(room)
  // The lobby consumed the first HELLO. Deliver it to the match after its
  // channel handler is installed, in seat order, preserving the lobby seats.
  for (const member of [...room.members].sort((a, b) => a.seat - b.seat)) {
    match.connect(member.channel)
    if (member.hello) member.channel.receive(member.hello)
  }
  let next = performance.now()
  room.timer = setInterval(() => {
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
  }, 1000 / 60)
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { reply(res, 204, {}); return }
  if (req.method === 'GET' && req.url === '/health') {
    reply(res, 200, { ok: true, rooms: rooms.size, players: totalPlayers() }); return
  }
  if (req.method === 'POST' && req.url === '/rooms') {
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
      const room: Room = { code: code(), seats, members: [], state: 'lobby', revision: 0,
        match: null, timer: null, expiry: null, lastActivity: Date.now() }
      rooms.set(room.code, room)
      reply(res, 201, { code: room.code, seats })
    })
    return
  }
  reply(res, 404, { error: 'not found' })
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET, perMessageDeflate: false })
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const room = rooms.get(url.searchParams.get('room')?.toUpperCase() ?? '')
  if (url.pathname !== '/ws' || !room || room.state !== 'lobby' ||
      room.members.length >= room.seats || totalPlayers() >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, room))
})

wss.on('connection', (socket: WebSocket, room: Room) => {
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
    receive(bytes) { for (const handler of messages) handler(bytes) },
    close() { socket.close(1000) },
  }
  const member: Member = { channel, socket, seat, ship: 'hornet', hello: null }
  room.members.push(member)
  room.lastActivity = Date.now()
  broadcast(room)
  channel.onMessage(bytes => {
    if (room.state !== 'lobby' || bytes[0] !== FRAME.HELLO) return
    try {
      member.ship = decodeHello(bytes)
      member.hello = bytes
      room.lastActivity = Date.now()
      broadcast(room)
    } catch { channel.close() }
  })
  socket.on('message', (data, binary) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : Array.isArray(data) ? Buffer.concat(data) : data
    const now = Math.floor(Date.now() / 1000)
    if (now !== second) { second = now; count = 0 }
    if (++count > MAX_MESSAGES_PER_SECOND || bytes.byteLength > MAX_PACKET) {
      socket.close(1008, 'rate limit'); return
    }
    room.lastActivity = Date.now()
    if (binary) { channel.receive(new Uint8Array(bytes)); return }
    let message: { type?: string }
    try { message = JSON.parse(String(data)) } catch { socket.close(1008, 'invalid control'); return }
    if (message.type === 'start' && seat === 0) {
      try { startRoom(room) } catch (error) {
        channel.control({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  })
  socket.on('close', () => {
    if (notified) return
    notified = true
    closed = true
    for (const handler of closers) handler()
    const index = room.members.indexOf(member)
    if (index >= 0) room.members.splice(index, 1)
    if (room.members.length === 0 || (seat === 0 && room.state === 'lobby')) closeRoom(room)
    else if (room.state === 'lobby') broadcast(room)
  })
  socket.on('error', () => socket.close())
})

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state === 'lobby' && Date.now() - room.lastActivity > IDLE_MS) closeRoom(room)
  }
}, 60_000).unref()

server.listen(PORT, '0.0.0.0', () => console.log(`neon-orbit server listening on ${PORT}`))
process.on('SIGTERM', () => { for (const room of rooms.values()) closeRoom(room); server.close() })
