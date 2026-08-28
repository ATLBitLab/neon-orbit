/**
 * The one shape a wire has, as far as the game is concerned.
 *
 * Bytes go in, bytes come out, and the connection can close. That is the
 * whole interface, on purpose: everything the session layer decides — who
 * flies which seat, what a late frame means, when to send a snapshot — is
 * decided over this and tested headlessly over the loopback below. The real
 * transport (`webrtc.ts`) is one thin adapter to it and carries no policy.
 *
 * Delivery is not guaranteed and order is not guaranteed. The session layer
 * is written for that, because the real channel is configured that way: a
 * snapshot that arrives after the next one is worthless, and a retransmitted
 * intent for a tick that already ran is a cheat vector, not a courtesy.
 */

import { makeRng, type Rng } from '../core/rng'

export interface Channel {
  send(bytes: Uint8Array): void
  onMessage(handler: (bytes: Uint8Array) => void): void
  onClose(handler: () => void): void
  close(): void
  readonly open: boolean
}

/** How badly the loopback behaves. Every knob defaults to a perfect wire. */
export interface LoopbackOptions {
  /** Fraction of frames that never arrive, 0..1. */
  loss?: number
  /** Ticks a frame sits in flight before it can be delivered. */
  latency?: number
  /** Extra ticks of random delay on top of `latency`, which is what reorders frames. */
  jitter?: number
  /** Fraction of frames delivered twice. */
  duplicate?: number
  /** Seed for the loss/jitter draws, so a flaky wire is a reproducible one. */
  seed?: number
}

export interface Loopback {
  /** The two ends. Whatever `a` sends, `b` receives, and vice versa. */
  a: Channel
  b: Channel
  /**
   * Advance the wire one tick, delivering every frame whose time has come.
   * Delivery is explicit rather than immediate so a test controls exactly when
   * the far end hears something relative to its own simulation.
   */
  pump(): void
  /** Frames dropped on the floor so far. */
  readonly lost: number
  /** Change the loss rate mid-run, so a test can lose exactly the frame it means to. */
  setLoss(fraction: number): void
}

interface InFlight {
  bytes: Uint8Array
  due: number
}

export function createLoopback(options: LoopbackOptions = {}): Loopback {
  let loss = options.loss ?? 0
  const latency = options.latency ?? 0
  const jitter = options.jitter ?? 0
  const duplicate = options.duplicate ?? 0
  const rng: Rng = makeRng(options.seed ?? 1)

  let now = 0
  let lost = 0

  function end(inbox: InFlight[], outbox: InFlight[]): Channel & { deliver(): void; handlers: ((b: Uint8Array) => void)[] } {
    const handlers: ((b: Uint8Array) => void)[] = []
    const closers: (() => void)[] = []
    let open = true
    return {
      handlers,
      get open() {
        return open
      },
      send(bytes) {
        if (!open) return
        if (rng() < loss) {
          lost++
          return
        }
        // Copied: the sender reuses its buffers, and a real wire copies too.
        const copy = new Uint8Array(bytes)
        const delay = latency + (jitter > 0 ? rng.int(0, jitter) : 0)
        outbox.push({ bytes: copy, due: now + delay })
        if (duplicate > 0 && rng() < duplicate) outbox.push({ bytes: copy, due: now + delay + (jitter > 0 ? rng.int(0, jitter) : 0) })
      },
      onMessage(handler) {
        handlers.push(handler)
      },
      onClose(handler) {
        closers.push(handler)
      },
      close() {
        if (!open) return
        open = false
        for (const c of closers) c()
      },
      deliver() {
        // Everything due, in arrival order — which, with jitter, is not send order.
        const ready = inbox.filter((f) => f.due <= now)
        if (ready.length === 0) return
        inbox.splice(0, inbox.length, ...inbox.filter((f) => f.due > now))
        for (const f of ready) if (open) for (const h of handlers) h(f.bytes)
      },
    }
  }

  const toB: InFlight[] = []
  const toA: InFlight[] = []
  const a = end(toA, toB)
  const b = end(toB, toA)

  return {
    a,
    b,
    pump() {
      now++
      a.deliver()
      b.deliver()
    },
    get lost() {
      return lost
    },
    setLoss(fraction) {
      loss = fraction
    },
  }
}
