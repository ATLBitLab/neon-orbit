/**
 * An `RTCDataChannel` as a `Channel`.
 *
 * Unordered and without retransmits, on purpose. Snapshots supersede each
 * other and intents are tick-stamped, so the session layer already treats
 * every frame as droppable and reorderable — a reliable, ordered channel would
 * only add head-of-line blocking to a game that has no use for a late frame.
 *
 * Signalling is non-trickle: each side waits for ICE gathering to finish and
 * publishes one complete description. Fewer messages over the signalling path
 * and nothing to correlate, at the cost of a second or so before the first
 * frame. This is browser-only and carries no policy; everything it delivers
 * goes through `session.ts`, which is what the headless suite tests.
 */

import type { Channel } from './channel'

export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

const DATA_CHANNEL_LABEL = 'neon'
const DATA_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 }

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

/** Resolve once ICE gathering is complete, so the local description is whole. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return
      pc.removeEventListener('icegatheringstatechange', done)
      resolve()
    }
    pc.addEventListener('icegatheringstatechange', done)
    // Some stacks never report `complete` when there is nothing to gather.
    setTimeout(resolve, 4000)
  })
}

/** Wait for a data channel to open, or give up. */
function opened(dc: RTCDataChannel, timeoutMs = 15000): Promise<void> {
  if (dc.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('data channel never opened')), timeoutMs)
    dc.addEventListener('open', () => {
      clearTimeout(t)
      resolve()
    })
    dc.addEventListener('error', () => {
      clearTimeout(t)
      reject(new Error('data channel failed'))
    })
  })
}

/** The joining side: make an offer, hand it out, take the answer, and connect. */
export async function connectAsClient(
  exchange: (offer: string) => Promise<string>,
): Promise<Channel> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, DATA_CHANNEL_OPTIONS)
  const channel = channelFrom(dc)
  await pc.setLocalDescription(await pc.createOffer())
  await gathered(pc)
  const answer = await exchange(pc.localDescription!.sdp)
  await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  await opened(dc)
  return channel
}

/** The hosting side: take an offer, answer it, and resolve with the channel once open. */
export async function acceptAsHost(
  offer: string,
  reply: (answer: string) => Promise<void>,
): Promise<Channel> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const channelReady = new Promise<Channel>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('peer never opened a data channel')), 20000)
    pc.ondatachannel = (ev) => {
      clearTimeout(t)
      const channel = channelFrom(ev.channel)
      opened(ev.channel).then(() => resolve(channel), reject)
    }
  })
  await pc.setRemoteDescription({ type: 'offer', sdp: offer })
  await pc.setLocalDescription(await pc.createAnswer())
  await gathered(pc)
  await reply(pc.localDescription!.sdp)
  return channelReady
}
