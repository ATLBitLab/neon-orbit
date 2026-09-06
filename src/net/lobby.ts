/** Host-owned reservations before launch. Transport is only a Channel. */
import type { Game } from '../game/game'
import type { ShipId } from '../ships/specs'
import type { Channel } from './channel'
import { createHost, decodeHello, encodeLobby, FRAME, refuse, type Host, type LobbyState } from './session'

export function createMatchLobby(options: {
  game: Game
  ships: ShipId[]
  seed?: number
  onChange?: (state: LobbyState) => void
  onPeer?: (seat: number) => void
}) {
  const ships = [...options.ships]
  if (ships.length < 2 || ships.length > 4) throw new RangeError('a wing has two to four seats')
  const peers: (Channel | null)[] = ships.map(() => null)
  const channels = new Set<Channel>()
  const transfers = new WeakMap<Channel, (host: Host) => void>()
  let revision = 0
  let host: Host | null = null
  let closed = false

  function state(seat = 0): LobbyState {
    return { revision, seat, seats: ships.map((ship, i) => ({ ship, pilot: i === 0 || peers[i] ? 'human' : 'ai' })) }
  }
  function changed() {
    revision++
    options.onChange?.(state())
    for (let i = 1; i < peers.length; i++) peers[i]?.send(encodeLobby(state(i)))
  }

  return {
    state,
    setShip(ship: ShipId) {
      if (host || closed || ships[0] === ship) return
      ships[0] = ship
      changed()
    },
    accept(channel: Channel) {
      if (closed) { channel.close(); return }
      channels.add(channel)
      let seated = -1
      let handedOver = false
      channel.onClose(() => {
        channels.delete(channel)
        if (seated >= 0 && peers[seated] === channel) {
          peers[seated] = null
          if (!host && !closed) changed()
        }
      })
      channel.onMessage((bytes) => {
        if (closed || !channel.open || handedOver || bytes[0] !== FRAME.HELLO) return
        let ship: ShipId
        try { ship = decodeHello(bytes) } catch { refuse(channel, 'version'); return }
        if (host) {
          handedOver = true
          const seat = host.accept(channel)
          if (seat >= 0) options.onPeer?.(seat)
          return
        }
        if (seated < 0) {
          seated = peers.findIndex((p, i) => i > 0 && !p)
          if (seated < 0) { refuse(channel, 'full'); return }
          peers[seated] = channel
          ships[seated] = ship
          changed()
        } else {
          // A lost roster is recovered by the client's repeated HELLO.
          channel.send(encodeLobby(state(seated)))
        }
      })
      // Launch transfers existing reservations once; this handler then stands down.
      transfers.set(channel, (match) => {
        if (seated < 0 || !channel.open) return
        handedOver = true
        match.accept(channel, seated)
      })
    },
    launch(): Host {
      if (closed) throw new Error('lobby is closed')
      if (host) return host
      host = createHost({ game: options.game, setup: { ships: [...ships], seed: options.seed, respawn: true } })
      host.start()
      for (const channel of channels) transfers.get(channel)?.(host)
      return host
    },
    close() {
      closed = true
      for (const channel of channels) channel.close()
      host?.close()
    },
  }
}
