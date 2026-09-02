/**
 * Signalling over Nostr.
 *
 * WebRTC needs some reachable place for two browsers to swap an offer, an
 * answer and their ICE candidates before they can talk directly. Running a
 * server for that was exactly the infrastructure the brief said not to run;
 * public Nostr relays already exist, cost nothing, and this platform speaks
 * Nostr anyway. So a match is a six-character code, and both sides meet on
 * ephemeral events (kind 20777, which relays do not store) tagged with it.
 * Each side signs with a throwaway key generated for the session; nothing
 * here is an identity.
 *
 * What is *not* solved here, named so it is not mistaken for solved: SDP and
 * candidates carry IP addresses and the events are plaintext on public
 * relays, so anyone watching the code's tag learns them. Encrypting the
 * exchange to the host's key (NIP-44) is the obvious next step and a small
 * one; it is not in this milestone. Nor is any proof of who a peer is — the
 * session layer seats whoever completes the handshake first. Lobby work.
 */

import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

export const SIGNAL_KIND = 20777
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']

export type SignalMessage =
  | { type: 'offer'; from: string; sdp: string }
  | { type: 'answer'; from: string; to: string; sdp: string }
  | { type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }

export interface Signal {
  readonly pubkey: string
  send(message: DistributiveOmit<SignalMessage, 'from'>): Promise<void>
  /** Every message on this code not sent by us. Returns an unsubscribe. */
  listen(handler: (message: SignalMessage) => void): () => void
  close(): void
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** A join code: six characters from an alphabet with no look-alikes. */
export function newJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let code = ''
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return code
}

function wellFormed(m: unknown): m is SignalMessage {
  if (typeof m !== 'object' || m === null) return false
  const x = m as Record<string, unknown>
  if (typeof x.from !== 'string') return false
  if (x.type === 'offer') return typeof x.sdp === 'string'
  if (x.type === 'answer') return typeof x.sdp === 'string' && typeof x.to === 'string'
  if (x.type === 'ice') return typeof x.to === 'string' && typeof x.candidate === 'object' && x.candidate !== null
  return false
}

export function createNostrSignal(code: string, relays = DEFAULT_RELAYS): Signal {
  const pool = new SimplePool()
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const tag = `neon-orbit:${code.toUpperCase()}`
  const closers: (() => void)[] = []

  return {
    pubkey,

    async send(message) {
      const event = finalizeEvent(
        {
          kind: SIGNAL_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['t', tag]],
          content: JSON.stringify({ ...message, from: pubkey }),
        },
        secret,
      )
      // Any one relay accepting is enough; the rest may be down.
      await Promise.any(pool.publish(relays, event))
    },

    listen(handler) {
      const sub = pool.subscribeMany(
        relays,
        { kinds: [SIGNAL_KIND], '#t': [tag], since: Math.floor(Date.now() / 1000) - 30 },
        {
          onevent(event) {
            if (event.pubkey === pubkey) return
            let message: unknown
            try {
              message = JSON.parse(event.content)
            } catch {
              return
            }
            if (!wellFormed(message)) return
            if (message.from !== event.pubkey) return // the claim has to match the signature
            handler(message)
          },
        },
      )
      closers.push(() => sub.close())
      return () => sub.close()
    },

    close() {
      for (const c of closers) c()
      pool.close(relays)
    },
  }
}
