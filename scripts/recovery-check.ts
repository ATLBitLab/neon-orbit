import { createIceRecovery } from '../src/net/recovery'
import type { Signal, SignalMessage } from '../src/net/signal'

/** Exercise negotiation ordering and loss separately from the browser's ICE engine. */
export async function testIceRecovery(check: (label: string, condition: boolean, detail?: string) => void) {
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  function rig(initiator = true) {
    let time = 0
    let listener: (message: SignalMessage) => void = () => {}
    let removed = 0
    let failures = 0
    let offers = 0
    let answers = 0
    const states: string[] = []
    const sent: SignalMessage[] = []
    const applied: RTCSessionDescriptionInit[] = []
    const candidates: RTCIceCandidateInit[] = []
    let onCandidate: (event: RTCPeerConnectionIceEvent) => void = () => {}
    const signal: Signal = {
      pubkey: 'self',
      async send(message) { sent.push({ ...message, from: 'self' } as SignalMessage) },
      listen(handler) { listener = handler; return () => { removed++; listener = () => {} } },
      close() {},
    }
    const fake = {
      iceConnectionState: 'disconnected', signalingState: 'stable',
      localDescription: null as RTCSessionDescriptionInit | null,
      async createOffer(options?: RTCOfferOptions) {
        offers++
        return { type: 'offer', sdp: options?.iceRestart ? 'restart credentials' : 'old credentials' } as RTCSessionDescriptionInit
      },
      async createAnswer() { answers++; return { type: 'answer', sdp: 'new answer' } as RTCSessionDescriptionInit },
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        fake.localDescription = description
        fake.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
      },
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        applied.push(description)
        fake.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
      },
      async addIceCandidate(candidate: RTCIceCandidateInit) { candidates.push(candidate) },
      addEventListener(_type: string, handler: typeof onCandidate) { onCandidate = handler },
      removeEventListener() { onCandidate = () => {} },
    }
    const recovery = createIceRecovery({
      pc: fake as unknown as RTCPeerConnection, signal, peer: 'peer', initiator,
      now: () => time, onIce: state => states.push(state), onFailure: () => { failures++ },
    })
    return {
      recovery, sent, applied, candidates, fake, states,
      receive: (message: SignalMessage) => listener(message),
      candidate: (candidate: RTCIceCandidateInit) => onCandidate({ candidate: { toJSON: () => candidate } } as RTCPeerConnectionIceEvent),
      tick: (value: number) => { time = value; recovery.poll() },
      counts: () => ({ removed, failures, offers, answers }),
    }
  }
  console.log('\nAn ICE restart preserves negotiation identity and has a bounded fallback')
  const client = rig()
  client.recovery.ice('failed')
  await flush()
  check('failed ICE starts a restart offer before declaring the link lost', client.states[0] === 'disconnected' && client.counts().failures === 0 && client.sent.some(m => m.type === 'restart-offer' && m.sdp === 'restart credentials'))
  client.recovery.ice('disconnected')
  await flush()
  check('repeated outage events keep one negotiation', client.counts().offers === 1)
  client.receive({ type: 'restart-answer', from: 'stranger', to: 'self', generation: 1, sdp: 'forged' })
  client.receive({ type: 'restart-answer', from: 'peer', to: 'elsewhere', generation: 1, sdp: 'misaddressed' })
  client.receive({ type: 'restart-answer', from: 'peer', to: 'self', generation: 2, sdp: 'future' })
  await flush()
  check('only the established peer and current addressed attempt can answer', client.applied.length === 0)
  client.receive({ type: 'restart-ice', from: 'peer', to: 'self', generation: 1, candidate: { candidate: 'early' } })
  await flush()
  check('early candidates wait for the matching remote description', client.candidates.length === 0)
  const beforeRetry = client.sent.length
  client.candidate({ candidate: 'local' })
  client.tick(1000)
  check('lost offers and their candidates are retransmitted', client.sent.length >= beforeRetry + 3)
  client.receive({ type: 'restart-answer', from: 'peer', to: 'self', generation: 1, sdp: 'answer' })
  await flush()
  check('the answer installs once and drains early candidates', client.applied.length === 1 && client.candidates[0]?.candidate === 'early')
  client.receive({ type: 'restart-answer', from: 'peer', to: 'self', generation: 1, sdp: 'duplicate' })
  await flush()
  check('duplicate answers cannot overwrite a settled remote description', client.applied.length === 1)
  client.fake.iceConnectionState = 'connected'
  client.recovery.ice('connected')
  client.tick(9000)
  check('connected ICE cancels the old outage deadline', client.states.at(-1) === 'connected' && client.counts().failures === 0)
  client.fake.iceConnectionState = 'failed'
  client.recovery.ice('failed')
  await flush()
  check('a later outage uses a fresh attempt on the same connection', client.counts().offers === 2 && client.sent.some(m => m.type === 'restart-offer' && m.generation === 2))
  const previousCandidates = client.candidates.length
  client.receive({ type: 'restart-ice', from: 'peer', to: 'self', generation: 1, candidate: { candidate: 'stale' } })
  await flush()
  check('old-attempt candidates cannot enter the new negotiation', client.candidates.length === previousCandidates)
  client.tick(16999)
  check('the recovery gets the full eight-second grace', client.counts().failures === 0)
  client.recovery.ice('disconnected')
  client.tick(17000)
  check('repeated disconnection cannot extend recovery indefinitely', client.counts().failures === 1 && client.states.at(-1) === 'failed')
  const endedAt = client.sent.length
  client.recovery.ice('disconnected')
  client.candidate({ candidate: 'after close' })
  client.tick(30000)
  await flush()
  check('terminal failure removes signalling and stops retries', client.sent.length === endedAt && client.counts().removed === 1)

  const host = rig(false)
  host.recovery.ice('disconnected')
  await flush()
  check('the host asks the joiner to offer instead of competing with it', host.counts().offers === 0 && host.sent[0]?.type === 'restart-request')
  host.receive({ type: 'restart-ice', from: 'peer', to: 'self', generation: 1, candidate: { candidate: 'before offer' } })
  const offer: SignalMessage = { type: 'restart-offer', from: 'peer', to: 'self', generation: 1, sdp: 'offer' }
  host.receive(offer)
  host.receive(offer)
  await flush()
  check('duplicate offers install one description and one answer', host.applied.length === 1 && host.counts().answers === 1)
  check('host candidates arriving before the offer are preserved', host.candidates[0]?.candidate === 'before offer')
  const beforeDuplicate = host.sent.length
  host.fake.iceConnectionState = 'connected'
  host.recovery.ice('connected')
  host.receive(offer)
  await flush()
  check('a lost answer can be resent even after the host reconnects', host.sent.length > beforeDuplicate && host.sent.at(-1)?.type === 'restart-answer')
  host.recovery.close()

  const cancelled = rig()
  cancelled.recovery.ice('disconnected')
  cancelled.recovery.close()
  await flush()
  check('leaving during offer creation cannot publish a late negotiation', cancelled.sent.length === 0 && cancelled.counts().removed === 1)

  const requested = rig()
  requested.receive({ type: 'restart-request', from: 'peer', to: 'self', generation: 1 })
  await flush()
  check('a host-reported outage starts recovery on the joiner', requested.counts().offers === 1)
  requested.recovery.close()
}
