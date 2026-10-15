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

export async function createServerRoom(endpoint: string, seats: number): Promise<string> {
  const url = new URL('/rooms', endpoint.replace(/^ws/, 'http'))
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seats }) })
  const body = await response.json() as { code?: string; error?: string }
  if (!response.ok || !body.code) throw new Error(body.error ?? 'could not create room')
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(body.code)) throw new Error('server returned an invalid room code')
  return body.code
}

export function joinServer(
  game: Game, endpoint: string, code: string, ship: ShipId, handlers: JoinHandlers,
  resumeToken?: string,
): Promise<Joining> {
  const url = new URL('/ws', endpoint)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', code)
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
