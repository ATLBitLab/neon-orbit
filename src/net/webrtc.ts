/**
 * An `RTCDataChannel` as a `Channel`, and the handshake that opens one.
 *
 * Unordered and without retransmits, on purpose. Snapshots supersede each
 * other and intents are tick-stamped, so the session layer already treats
 * every frame as droppable and reorderable — a reliable, ordered channel would
 * only add head-of-line blocking to a game that has no use for a late frame.
 *
 * Signalling trickles: the offer and answer go out the moment they exist and
 * every ICE candidate follows as it is found, over the same `Signal`. The
 * first version waited for gathering to finish before sending one complete
 * description; Chrome never reports gathering complete while a STUN server
 * is configured, so that wait was a fixed four seconds of nothing on every
 * join, and any candidate found after it was lost.
 *
 * Every stage reports through `onStatus`, and a failure names the stage:
 * "no host answered" is signalling, "no route between browsers" is ICE. The
 * first version folded both into one message and the person testing it could
 * not tell us which had failed.
 *
 * After the channel opens the ICE state keeps changing — a link that drops is
 * reported here as `disconnected`, and the channel stays `open` while it is —
 * so those changes go to `LinkHooks.onIce` rather than to the join stages,
 * along with the candidate pair the connection settled on (`onRoute`: host,
 * srflx or relay, either end), which is the one fact that says what path two
 * machines actually took. What to do about a drop is `link.ts`, headless.
 * Closing the channel closes the peer connection with it, so the far side
 * hears the close promptly instead of waiting on ICE to time out.
 *
 * ICE servers: STUN by default, which is enough between two homes. Two
 * browsers on one machine, or behind a symmetric NAT, need a TURN relay —
 * configured through `VITE_TURN_URL` / `VITE_TURN_USERNAME` /
 * `VITE_TURN_CREDENTIAL`, none set by default because a relay is exactly the
 * infrastructure this project is trying not to run. This is browser-only and
 * carries no policy; everything it delivers goes through `session.ts`.
 */

import type { Channel } from './channel'
import type { Signal, SignalMessage } from './signal'

export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const env = import.meta.env as Record<string, string | undefined>
  const turn = env.VITE_TURN_URL
  if (turn) {
    servers.push({
      urls: turn.split(',').map((u) => u.trim()),
      username: env.VITE_TURN_USERNAME ?? '',
      credential: env.VITE_TURN_CREDENTIAL ?? '',
    })
  }
  return servers
}

const DATA_CHANNEL_LABEL = 'neon'
const DATA_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 }
const HANDSHAKE_TIMEOUT_MS = 45000

export function channelFrom(dc: RTCDataChannel, pc?: RTCPeerConnection): Channel {
  dc.binaryType = 'arraybuffer'
  const handlers: ((b: Uint8Array) => void)[] = []
  const closers: (() => void)[] = []
  let open = dc.readyState === 'open'
  dc.onopen = () => {
    open = true
  }
  dc.onmessage = (ev) => {
    const data = ev.data as ArrayBuffer | Uint8Array
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    for (const h of handlers) h(bytes)
  }
  const closed = () => {
    if (!open) return
    open = false
    for (const c of closers) c()
  }
  dc.onclose = closed
  dc.onerror = closed
  return {
    get open() {
      return open
    },
    send(bytes) {
      if (dc.readyState !== 'open') return
      // A fresh copy: the caller reuses its buffers, and `send` may not.
      dc.send(bytes.slice().buffer)
    },
    onMessage(handler) {
      handlers.push(handler)
    },
    onClose(handler) {
      closers.push(handler)
    },
    close() {
      dc.close()
      pc?.close()
      closed()
    },
  }
}

export type Status = (stage: string) => void

/** What happens to a connection after it has opened. */
export interface LinkHooks {
  /** Every ICE connection state after the channel opened. */
  onIce?: (state: RTCIceConnectionState) => void
  /** The candidate pair in use, whenever it is (re)established; see `describeRoute`. */
  onRoute?: (route: string) => void
}

/**
 * The candidate pair the connection is using, as one line:
 * `host/udp 192.168.1.20:51234 ↔ srflx 203.0.113.9:3478`. Empty when the
 * stats do not name one yet.
 */
export async function describeRoute(pc: RTCPeerConnection): Promise<string> {
  let stats: RTCStatsReport
  try {
    stats = await pc.getStats()
  } catch {
    return ''
  }
  type Stat = Record<string, unknown>
  const all = [...stats.values()] as Stat[]
  const transport = all.find((s) => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string')
  const pair = (transport
    ? (stats.get(transport.selectedCandidatePairId as string) as Stat | undefined)
    : all.find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded')) as Stat | undefined
  if (!pair) return ''
  const end = (id: unknown): string => {
    const c = typeof id === 'string' ? (stats.get(id) as Stat | undefined) : undefined
    if (!c) return '?'
    const protocol = typeof c.protocol === 'string' ? `/${c.protocol}` : ''
    return `${String(c.candidateType ?? '?')}${protocol} ${String(c.address ?? c.ip ?? '?')}:${String(c.port ?? '?')}`
  }
  return `${end(pair.localCandidateId)} ↔ ${end(pair.remoteCandidateId)}`
}

/** Reject with a named reason when ICE gives up, and resolve when the channel opens. */
function watch(pc: RTCPeerConnection, dc: Promise<RTCDataChannel>, status: Status, hooks: LinkHooks): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the connection')), HANDSHAKE_TIMEOUT_MS)
    let opened = false
    const route = () => {
      void describeRoute(pc).then((r) => {
        if (r) hooks.onRoute?.(r)
      })
    }
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      if (opened) {
        // The join is over; this is the link's business now.
        hooks.onIce?.(state)
        if (state === 'connected' || state === 'completed') route()
        return
      }
      status(`ice ${state}`)
      if (state === 'failed') {
        clearTimeout(timer)
        reject(new Error('no route between browsers (ICE failed) — a TURN relay would be needed'))
      }
    }
    dc.then((channel) => {
      const done = () => {
        clearTimeout(timer)
        opened = true
        status('connected')
        resolve(channelFrom(channel, pc))
        route()
      }
      if (channel.readyState === 'open') done()
      else channel.addEventListener('open', done)
      channel.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('data channel failed'))
      })
    }, reject)
  })
}

/** The joining side: offer, trickle, take the answer, connect. */
export function connectAsClient(signal: Signal, status: Status = () => {}, hooks: LinkHooks = {}): Promise<Channel> {
  const pc = new RTCPeerConnection({ iceServers: iceServers() })
  const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, DATA_CHANNEL_OPTIONS)
  let host: string | null = null
  const queued: RTCIceCandidateInit[] = []
  /**
   * The host's candidates may reach the relays before its answer does — relays
   * do not order events, and the host trickles the moment it has them — so
   * anything from a not-yet-known sender is kept until the answer names it.
   */
  const early = new Map<string, RTCIceCandidateInit[]>()

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return
    const candidate = ev.candidate.toJSON()
    if (host) void signal.send({ type: 'ice', to: host, candidate })
    else queued.push(candidate)
  }

  const stop = signal.listen((message: SignalMessage) => {
    if (message.type === 'answer' && message.to === signal.pubkey && !host) {
      host = message.from
      status('answer received')
      void pc.setRemoteDescription({ type: 'answer', sdp: message.sdp }).then(() => {
        for (const c of early.get(host!) ?? []) void pc.addIceCandidate(c).catch(() => {})
        early.clear()
        for (const c of queued) void signal.send({ type: 'ice', to: host!, candidate: c })
        queued.length = 0
      })
    } else if (message.type === 'ice' && message.to === signal.pubkey) {
      if (message.from === host && pc.remoteDescription) {
        void pc.addIceCandidate(message.candidate).catch(() => {})
      } else if (!host) {
        const list = early.get(message.from) ?? []
        list.push(message.candidate)
        early.set(message.from, list)
      }
    }
  })

  const answered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no host answered — is the host page open on this code?')), HANDSHAKE_TIMEOUT_MS / 2)
    const poll = setInterval(() => {
      if (host) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve()
      }
    }, 100)
  })

  const connected = (async () => {
    await pc.setLocalDescription(await pc.createOffer())
    status('offer sent')
    await signal.send({ type: 'offer', sdp: pc.localDescription!.sdp })
    await answered
    status('connecting')
    return watch(pc, Promise.resolve(dc), status, hooks)
  })()

  return connected
    .catch((error: unknown) => {
      pc.close()
      throw error
    })
    .finally(stop)
}

/** The hosting side: answer one offer, trickle, resolve when its channel opens. */
export function acceptAsHost(
  signal: Signal,
  offer: Extract<SignalMessage, { type: 'offer' }>,
  status: Status = () => {},
  hooks: LinkHooks = {},
): Promise<Channel> {
  const pc = new RTCPeerConnection({ iceServers: iceServers() })
  const peer = offer.from

  pc.onicecandidate = (ev) => {
    if (ev.candidate) void signal.send({ type: 'ice', to: peer, candidate: ev.candidate.toJSON() })
  }
  const pending: RTCIceCandidateInit[] = []
  const stop = signal.listen((message) => {
    if (message.type === 'ice' && message.to === signal.pubkey && message.from === peer) {
      if (pc.remoteDescription) void pc.addIceCandidate(message.candidate).catch(() => {})
      else pending.push(message.candidate)
    }
  })

  const dc = new Promise<RTCDataChannel>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('peer never opened a data channel')), HANDSHAKE_TIMEOUT_MS)
    pc.ondatachannel = (ev) => {
      clearTimeout(timer)
      resolve(ev.channel)
    }
  })

  const connected = (async () => {
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    for (const c of pending.splice(0)) void pc.addIceCandidate(c).catch(() => {})
    await pc.setLocalDescription(await pc.createAnswer())
    status('answer sent')
    await signal.send({ type: 'answer', to: peer, sdp: pc.localDescription!.sdp })
    return watch(pc, dc, status, hooks)
  })()

  return connected
    .catch((error: unknown) => {
      pc.close()
      throw error
    })
    .finally(stop)
}
