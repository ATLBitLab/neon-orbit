import type { Game } from '../game/game'
import type { ShipId } from '../ships/specs'
import type { Channel } from './channel'
import { createClient, type Client } from './session'
import { encodeResumeToken } from './resume'
import type { JoinHandlers, Joining } from './browser'

/** The server URL is explicit so a preview client can point at a test droplet. */
export function serverUrl(search: string): string | null {
  const params = new URLSearchParams(search)
  if (params.has('p2p')) return null
  const value = params.get('server') || import.meta.env.VITE_SERVER_URL
  if (!value) return null
  const url = new URL(value)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('invalid server URL')
  return url.origin
}

export function serverJoinLink(code: string, endpoint: string): string {
  const url = new URL(location.pathname, location.origin)
  url.searchParams.set('join', code)
  url.searchParams.set('server', endpoint)
  return url.toString()
}

export async function serverPotEnabled(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', endpoint.replace(/^ws/, 'http')), { cache: 'no-store' })
    if (!response.ok) return false
    const body = await response.json() as { potEnabled?: unknown }
    return body.potEnabled === true
  } catch { return false }
}

export async function createServerRoom(endpoint: string, seats: number, buyInSats?: number): Promise<string> {
  const url = new URL('/rooms', endpoint.replace(/^ws/, 'http'))
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seats, ...(buyInSats === undefined ? {} : { pot: { buyInSats } }) }) })
  const body = await response.json() as { code?: string; error?: string }
  if (!response.ok || !body.code) throw new Error(body.error ?? 'could not create room')
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(body.code)) throw new Error('server returned an invalid room code')
  return body.code
}

export interface PotPaymentStatus { paymentId: string; state: string; invoice: string | null }

export async function potPayment(endpoint: string, code: string, seat: number, token: string,
  create: boolean): Promise<PotPaymentStatus> {
  const url = new URL('/pot', endpoint.replace(/^ws/, 'http'))
  if (!create) { url.searchParams.set('room', code); url.searchParams.set('seat', String(seat)) }
  const response = await fetch(url, { method: create ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(create ? { 'Content-Type': 'application/json' } : {}) },
    ...(create ? { body: JSON.stringify({ code, seat }) } : {}), cache: 'no-store' })
  const body = await response.json() as PotPaymentStatus & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'payment status unavailable')
  if (typeof body.paymentId !== 'string' || typeof body.state !== 'string') throw new Error('invalid payment status')
  return body
}

export function joinServer(
  game: Game, endpoint: string, code: string, ship: ShipId, handlers: JoinHandlers,
  resumeToken?: string,
  potClaim?: { seat: number; token: string },
): Promise<Joining> {
  const url = new URL('/ws', endpoint)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', code)
  if (potClaim && !resumeToken) url.searchParams.set('potSeat', String(potClaim.seat))
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    let opened = false
    let stopped = false
    const messages: ((bytes: Uint8Array) => void)[] = []
    const closers: (() => void)[] = []
    let client: Client
    const channel: Channel = {
      get open() { return socket.readyState === WebSocket.OPEN },
      send(bytes) { if (this.open) socket.send(Uint8Array.from(bytes)) },
      onMessage(handler) { messages.push(handler) },
      onClose(handler) { closers.push(handler) },
      close() { socket.close() },
    }
    socket.onopen = () => {
      opened = true
      if (!handlers.active()) { socket.close(); reject(new Error('join cancelled')); return }
      if (resumeToken) socket.send(Uint8Array.from(encodeResumeToken(resumeToken)))
      else if (potClaim) {
        const proof = new Uint8Array(45)
        proof[0] = 9
        proof[1] = potClaim.seat
        for (let i = 0; i < 43; i++) proof[i + 2] = potClaim.token.charCodeAt(i)
        socket.send(proof)
      }
      client = createClient({ game, channel, ship,
        onLobby: handlers.onLobby, onWelcome: handlers.onWelcome, onRefused: handlers.onRefused })
      handlers.status('connected — waiting for room status')
      handlers.onLink({ state: 'up', reason: '', route: 'server' })
      resolve({ client, tick: local => client.tick(local), stop: () => { stopped = true; socket.close() },
        start: () => socket.send(JSON.stringify({ type: 'start' })),
        selectShip: next => socket.send(JSON.stringify({ type: 'ship', ship: next })) })
    }
    socket.onmessage = event => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as {
            type: string; message?: string; creator?: boolean; launcherSeat?: number; token?: string
            claim?: string; seat?: number; buyInSats?: number; paymentId?: string
            pot?: { buyInSats?: number; paidSeats?: number[] }
          }
          if (message.type === 'resume' && typeof message.token === 'string' &&
              /^[A-Za-z0-9_-]{43}$/.test(message.token)) {
            handlers.onServerResumeToken?.(message.token)
          }
          if (message.type === 'error') {
            const reason = message.message ?? 'server error'
            handlers.status(reason)
            handlers.onServerError?.(reason)
          }
          if (message.type === 'room' && (!client || client.seat < 0)) {
            if (typeof message.creator === 'boolean' && typeof message.launcherSeat === 'number' &&
                Number.isInteger(message.launcherSeat)) {
              handlers.onServerRole?.(message.creator, message.launcherSeat)
            }
            if (message.pot && Number.isInteger(message.pot.buyInSats) &&
                Array.isArray(message.pot.paidSeats) && message.pot.paidSeats.every(Number.isInteger)) {
              handlers.onPotRoom?.({ buyInSats: message.pot.buyInSats!, paidSeats: message.pot.paidSeats })
            }
          }
          if (message.type === 'pot' && typeof message.claim === 'string' &&
              /^[A-Za-z0-9_-]{43}$/.test(message.claim) && Number.isInteger(message.seat) &&
              Number.isInteger(message.buyInSats) && typeof message.paymentId === 'string') {
            handlers.onPotClaim?.({ seat: message.seat!, buyInSats: message.buyInSats!,
              paymentId: message.paymentId, token: message.claim })
          }
        } catch { handlers.status('invalid server message') }
        return
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      for (const handler of messages) handler(bytes)
    }
    socket.onerror = () => { if (!opened) reject(new Error('server connection failed')) }
    socket.onclose = () => {
      for (const handler of closers) handler()
      if (!opened) reject(new Error('room unavailable or server offline'))
      else if (!stopped && !game.result) handlers.onLink({ state: 'down', reason: 'server disconnected', route: 'server' })
    }
  })
}
