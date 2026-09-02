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

export function channelFrom(dc: RTCDataChannel): Channel {
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
      closed()
    },
  }
}

export type Status = (stage: string) => void

/** Reject with a named reason when ICE gives up, and resolve when the channel opens. */
function watch(pc: RTCPeerConnection, dc: Promise<RTCDataChannel>, status: Status): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the connection')), HANDSHAKE_TIMEOUT_MS)
    pc.oniceconnectionstatechange = () => {
      status(`ice ${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'failed') {
        clearTimeout(timer)
        reject(new Error('no route between browsers (ICE failed) — a TURN relay would be needed'))
      }
    }
    dc.then((channel) => {
      const done = () => {
        clearTimeout(timer)
        status('connected')
        resolve(channelFrom(channel))
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
export function connectAsClient(signal: Signal, status: Status = () => {}): Promise<Channel> {
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
    return watch(pc, Promise.resolve(dc), status)
  })()

  return connected.finally(stop)
}

/** The hosting side: answer one offer, trickle, resolve when its channel opens. */
export function acceptAsHost(signal: Signal, offer: Extract<SignalMessage, { type: 'offer' }>, status: Status = () => {}): Promise<Channel> {
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
    return watch(pc, dc, status)
  })()

  return connected.finally(stop)
}
