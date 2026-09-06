/**
 * Hosting and joining, from the browser.
 *
 * The glue between the tested pieces — `session.ts` over `webrtc.ts` over
 * `signal.ts` — and `main.ts`, which only has to ask "which mode?" and tick
 * the right thing. Kept out of `main.ts` so the shipped single-player path
 * does not grow a branch it never takes.
 *
 * A host *lobby* is open from the moment the page loads in host mode, so the
 * join code can be shared from the hangar and a peer can connect while the
 * host is still choosing a ship: its channel is held until the match starts
 * and seated then. The first version only listened once the host was in
 * flight, which made "open the join link too early" a silent failure.
 *
 * Nothing in here runs headless. The protocol is tested over a loopback; this
 * file is the browser residue, and the two-tab check in the README is how it
 * is exercised.
 */

import type { Game } from '../game/game'
import type { Controls } from '../game/ship'
import { SHIP_ORDER, type ShipId } from '../ships/specs'
import type { Channel } from './channel'
import { createMatchLobby } from './lobby'
import { createLinkMonitor, LINK_GRACE_MS, type LinkReport } from './link'
import { createClient, type Client, type Host, type LobbyState, type Refusal } from './session'
import { createNostrSignal, newJoinCode, type Signal } from './signal'
import { acceptAsHost, connectAsClient, type LinkHooks, type Status } from './webrtc'

export type NetMode = { kind: 'solo' } | { kind: 'host'; guest: ShipId; seats: number } | { kind: 'join'; code: string }

/** Read the mode off the page URL: `?host[=wasp]` or `?join=CODE`. */
export function modeFromLocation(search: string): NetMode {
  const params = new URLSearchParams(search)
  const join = params.get('join')
  if (join) return { kind: 'join', code: join.toUpperCase() }
  if (params.has('host')) {
    const value = params.get('host') ?? ''
    const guest = SHIP_ORDER.includes(value as ShipId) ? value as ShipId : 'wasp'
    const seats = /^[2-4]$/.test(value) ? Number(value) : 2
    return { kind: 'host', guest, seats }
  }
  return { kind: 'solo' }
}

export interface Lobby {
  readonly code: string
  readonly wing: ReturnType<typeof createMatchLobby>
  close(): void
}

/** Listen from the hangar; reservations and launch live in the headless lobby. */
export function openLobby(
  game: Game, ships: ShipId[], onChange: (state: LobbyState) => void,
  onPeer: (seat: number) => void, status: Status = () => {},
): Lobby {
  const code = newJoinCode()
  const signal: Signal = createNostrSignal(code)
  const answered = new Set<string>()
  const wing = createMatchLobby({ game, ships, onChange, onPeer })
  let closed = false
  const stop = signal.listen((message) => {
    if (closed || message.type !== 'offer' || answered.has(message.from)) return
    answered.add(message.from)
    const who = `peer ${message.from.slice(0, 6)}`
    status(`${who}: offer received`)
    const hooks: LinkHooks = {
      onIce: (state) => status(`${who}: ice ${state}`),
      onRoute: (route) => status(`${who}: route ${route}`),
    }
    acceptAsHost(signal, message, (stage) => status(`${who}: ${stage}`), hooks)
      .then((channel) => { if (closed) channel.close(); else wing.accept(channel) })
      .catch((error) => status(`${who} failed: ${error instanceof Error ? error.message : error}`))
  })
  return {
    code, wing,
    close() {
      closed = true
      stop()
      signal.close()
      wing.close()
    },
  }
}

export interface Hosting {
  readonly host: Host
  tick(local: Controls): void
  stop(): void
}

export function startHosting(lobby: Lobby): Hosting {
  const host = lobby.wing.launch()
  return { host, tick: (local) => host.tick(local), stop: () => lobby.close() }
}

export interface Joining {
  readonly client: Client
  tick(local: Controls): void
  stop(): void
}

/** What a link looks like from the join screen: the monitor's verdict plus the route it was on. */
export interface LinkStatus extends LinkReport {
  route: string
}

export interface JoinHandlers {
  /** Each stage of the handshake, until the channel opens. */
  status: Status
  active(): boolean
  onWelcome(seat: number): void
  /** The host had no seat for us. The channel is closed before this is called. */
  onRefused(reason: Refusal): void
  onLobby(state: LobbyState): void
  /**
   * The link after it opened: degraded when ICE drops, up again if it recovers
   * inside `LINK_GRACE_MS`, down — channel closed, seat freed at the host once
   * it notices — when it does not, or when ICE fails outright.
   */
  onLink(link: LinkStatus): void
}

/** Connect to a host by code. Resolves once the data channel is open; the welcome follows on it. */
export async function joinMatch(game: Game, code: string, ship: ShipId, handlers: JoinHandlers): Promise<Joining> {
  const signal = createNostrSignal(code)
  let channel: Channel | null = null
  let route = ''
  let poll = 0
  let stopped = false
  const monitor = createLinkMonitor({
    grace: LINK_GRACE_MS,
    now: () => performance.now(),
    onChange(report) {
      if (stopped) return
      if (report.state === 'down') {
        window.clearInterval(poll)
        channel?.close()
      }
      handlers.onLink({ ...report, route })
    },
  })
  const hooks: LinkHooks = {
    onIce: (state) => monitor.ice(state),
    onRoute: (r) => {
      route = r
      console.log('[neon-orbit] link route:', r)
    },
  }
  try {
    channel = await connectAsClient(signal, handlers.status, hooks)
  } finally {
    signal.close()
  }
  if (!handlers.active()) { channel.close(); throw new Error('join cancelled') }
  const open = channel
  open.onClose(() => monitor.closed())
  poll = window.setInterval(() => monitor.poll(), 500)
  handlers.status('connected — waiting for the host to launch')
  const client = createClient({
    game,
    channel: open,
    ship,
    onLobby: handlers.onLobby,
    onWelcome: handlers.onWelcome,
    onRefused: (reason) => {
      stopped = true
      window.clearInterval(poll)
      open.close()
      handlers.onRefused(reason)
    },
  })
  return {
    client,
    tick: (local) => client.tick(local),
    stop() {
      stopped = true
      window.clearInterval(poll)
      open.close()
    },
  }
}
