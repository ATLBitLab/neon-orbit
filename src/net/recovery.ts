import { LINK_GRACE_MS } from './link'
import type { RecoveryMessage, Signal } from './signal'

type Outgoing = RecoveryMessage extends infer M ? M extends RecoveryMessage ? Omit<M, 'from'> : never : never

/** Only the joiner offers, so simultaneous outages cannot produce offer glare. */
export function createIceRecovery(options: {
  pc: RTCPeerConnection
  signal: Signal
  peer: string
  initiator: boolean
  now: () => number
  onIce: (state: RTCIceConnectionState) => void
  onFailure: () => void
}) {
  const { pc, signal, peer, initiator, now, onIce, onFailure } = options
  let generation = 0
  let recovering = false
  let closed = false
  let remoteReady = false
  let busy = false
  let deadline = 0
  let sentAt = -Infinity
  let outbound: Outgoing | null = null
  let answer: Outgoing | null = null
  let localCandidates: RTCIceCandidateInit[] = []
  const early = new Map<number, RTCIceCandidateInit[]>()

  function send(message: Outgoing) {
    if (!closed) void signal.send(message).catch(() => {}) // poll retries until the existing grace expires
  }

  function resend(message = outbound) {
    if (!message) return
    sentAt = now()
    send(message)
    for (const candidate of localCandidates) {
      send({ type: 'restart-ice', to: peer, generation, candidate })
    }
  }

  function begin() {
    if (recovering) return
    recovering = true
    remoteReady = false
    deadline = now() + LINK_GRACE_MS
    onIce('disconnected')
  }

  function fail() {
    if (closed) return
    close()
    onIce('failed')
    onFailure()
  }

  function settled() {
    if (closed || !recovering || !remoteReady || busy || pc.signalingState !== 'stable') return
    if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return
    recovering = false
    outbound = null
    onIce(pc.iceConnectionState)
  }

  function prepare(next: number) {
    generation = next
    remoteReady = false
    answer = null
    localCandidates = []
    for (const key of early.keys()) if (key !== generation) early.delete(key)
  }

  async function applyRemote(description: RTCSessionDescriptionInit) {
    await pc.setRemoteDescription(description)
    if (closed) return
    remoteReady = true
    for (const candidate of early.get(generation) ?? []) {
      await pc.addIceCandidate(candidate).catch(() => {})
    }
    early.delete(generation)
  }

  async function offer() {
    if (closed || busy || recovering) return
    begin()
    prepare(generation + 1)
    busy = true
    try {
      const description = await pc.createOffer({ iceRestart: true })
      if (closed) return
      await pc.setLocalDescription(description)
      if (closed) return
      outbound = { type: 'restart-offer', to: peer, generation, sdp: pc.localDescription!.sdp }
      resend()
    } catch { fail() } finally { busy = false }
  }

  function request() {
    if (recovering || closed) return
    if (initiator) { void offer(); return }
    begin()
    outbound = { type: 'restart-request', to: peer, generation: generation + 1 }
    resend()
  }

  async function receive(message: RecoveryMessage) {
    if (closed || message.from !== peer || message.to !== signal.pubkey) return
    if (message.type === 'restart-request') {
      if (!initiator) return
      if (message.generation === generation + 1) request()
      else if (recovering && message.generation === generation) resend()
      return
    }
    if (message.type === 'restart-ice') {
      if (message.generation < generation || message.generation > generation + (initiator ? 0 : 1)) return
      if (message.generation === generation && remoteReady) {
        await pc.addIceCandidate(message.candidate).catch(() => {})
      } else {
        const queue = early.get(message.generation) ?? []
        if (queue.length < 64) queue.push(message.candidate)
        early.set(message.generation, queue)
      }
      return
    }
    if (message.type === 'restart-offer') {
      if (initiator) return
      if (message.generation === generation) { if (answer) resend(answer); return }
      if (message.generation !== generation + 1 || busy) return
      begin()
      prepare(message.generation)
      busy = true
      try {
        await applyRemote({ type: 'offer', sdp: message.sdp })
        if (closed) return
        const description = await pc.createAnswer()
        if (closed) return
        await pc.setLocalDescription(description)
        if (closed) return
        answer = outbound = { type: 'restart-answer', to: peer, generation, sdp: pc.localDescription!.sdp }
        resend()
      } catch { fail() } finally { busy = false }
      settled()
      return
    }
    if (!initiator || message.generation !== generation || remoteReady || busy || !recovering) return
    busy = true
    try {
      await applyRemote({ type: 'answer', sdp: message.sdp })
    } catch { fail() } finally { busy = false }
    settled()
  }

  const stop = signal.listen(message => {
    if (message.type.startsWith('restart-')) void receive(message as RecoveryMessage)
  })
  const candidate = (event: RTCPeerConnectionIceEvent) => {
    if (closed || generation === 0 || !event.candidate) return
    const value = event.candidate.toJSON()
    if (localCandidates.length < 64) localCandidates.push(value)
    send({ type: 'restart-ice', to: peer, generation, candidate: value })
  }
  pc.addEventListener('icecandidate', candidate)

  function close() {
    if (closed) return
    closed = true
    stop()
    pc.removeEventListener('icecandidate', candidate)
    early.clear()
    localCandidates = []
  }

  return {
    ice(state: RTCIceConnectionState) {
      if (closed) return
      if (state === 'disconnected' || state === 'failed') { request(); return }
      if (recovering && (state === 'connected' || state === 'completed')) { settled(); return }
      onIce(state)
    },
    poll() {
      if (closed || !recovering) return
      if (now() >= deadline) { fail(); return }
      if (now() - sentAt >= 1000) resend()
    },
    close,
  }
}
