/**
 * Hosting and joining, from the browser.
 *
 * The glue between the tested pieces — `session.ts` over `webrtc.ts` over
 * `signal.ts` — and `main.ts`, which only has to ask "which mode?" and tick
 * the right thing. Kept out of `main.ts` so the shipped single-player path
 * does not grow a branch it never takes.
 *
 * Nothing in here runs headless, and the same obligation `boot()` carries is
 * named here too: the protocol is tested over a loopback; this file is the
 * browser residue, and the two-tab check in the README is how it is exercised.
 */

import type { Game, MatchSetup } from '../game/game'
import type { Controls } from '../game/ship'
import type { ShipId } from '../ships/specs'
import { createClient, createHost, type Client, type Host } from './session'
import { createNostrSignal, newJoinCode, type Signal } from './signal'
import { acceptAsHost, connectAsClient } from './webrtc'

export type NetMode = { kind: 'solo' } | { kind: 'host'; guest: ShipId } | { kind: 'join'; code: string }

/** Read the mode off the page URL: `?host[=wasp]` or `?join=CODE`. */
export function modeFromLocation(search: string): NetMode {
  const params = new URLSearchParams(search)
  const join = params.get('join')
  if (join) return { kind: 'join', code: join.toUpperCase() }
  if (params.has('host')) {
    const guest = (params.get('host') || 'wasp') as ShipId
    return { kind: 'host', guest }
  }
  return { kind: 'solo' }
}

export interface Hosting {
  readonly code: string
  readonly host: Host
  tick(local: Controls): void
  stop(): void
}

/**
 * Start a two-seat match and listen for one peer at a time on the join code.
 * Returns synchronously with the code; the match runs whether or not anyone
 * joins, and seat 1 sits idle until they do.
 */
export function startHosting(game: Game, ship: ShipId, guest: ShipId, onPeer: (seat: number) => void): Hosting {
  const code = newJoinCode()
  const setup: MatchSetup & { ships: ShipId[] } = { ships: [ship, guest], respawn: true }
  const host = createHost({ game, setup })
  host.start()

  const signal: Signal = createNostrSignal(code)
  const answered = new Set<string>()
  const stopListening = signal.listen((message) => {
    if (message.type !== 'offer' || answered.has(message.from)) return
    answered.add(message.from)
    acceptAsHost(message.sdp, (sdp) => signal.send({ type: 'answer', to: message.from, sdp }))
      .then((channel) => {
        const seat = host.accept(channel)
        if (seat >= 0) onPeer(seat)
      })
      .catch((error) => console.warn('peer failed to connect', error))
  })

  return {
    code,
    host,
    tick: (local) => host.tick(local),
    stop() {
      stopListening()
      signal.close()
    },
  }
}

export interface Joining {
  readonly client: Client
  tick(local: Controls): void
  stop(): void
}

/** Connect to a host by code. Resolves once the data channel is open; the welcome follows on it. */
export async function joinMatch(game: Game, code: string, onWelcome: (seat: number) => void): Promise<Joining> {
  const signal = createNostrSignal(code)
  const channel = await connectAsClient(
    (offer) =>
      new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          stop()
          reject(new Error(`no host answered code ${code}`))
        }, 30000)
        const stop = signal.listen((message) => {
          if (message.type !== 'answer' || message.to !== signal.pubkey) return
          clearTimeout(timeout)
          stop()
          resolve(message.sdp)
        })
        signal.send({ type: 'offer', sdp: offer }).catch(reject)
      }),
  )
  signal.close()
  const client = createClient({ game, channel, onWelcome })
  return {
    client,
    tick: (local) => client.tick(local),
    stop: () => channel.close(),
  }
}
