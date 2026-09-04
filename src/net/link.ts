/**
 * Whether a peer link is still a link.
 *
 * WebRTC reports the ICE connection state as it changes, and once the data
 * channel is open those changes are the only warning that the path between
 * two browsers has gone: the channel stays `open` while ICE is `disconnected`,
 * so a client keeps sending into the void and a mirror stops getting snapshots
 * with nobody saying so. The first two-device test to hit this sat on "ice
 * disconnected" for good — the join screen reprinted the state, nothing
 * closed, nothing retried.
 *
 * This is the policy, kept out of `webrtc.ts` so it runs headless. `connected`
 * or `completed` is *up*. `disconnected` is *degraded* — ICE does come back
 * from it, after a Wi-Fi hiccup or a candidate pair switch — and stays
 * degraded for a grace period before it is *down*. `failed`, `closed`, or the
 * channel closing is down at once. Down is terminal: the caller closes the
 * connection and offers a fresh join, which is the one recovery that does not
 * need the signalling to still be open.
 */

export type LinkState = 'up' | 'degraded' | 'down'

export interface LinkReport {
  state: LinkState
  /** Why, in words the join screen can show. */
  reason: string
}

export interface LinkMonitor {
  readonly state: LinkState
  /** An ICE connection state, as `RTCPeerConnection.iceConnectionState` reports it. */
  ice(state: string): void
  /** The data channel closed. */
  closed(): void
  /** Hold the grace period against the clock. Call on a timer while degraded. */
  poll(): void
}

export interface LinkMonitorOptions {
  /** Milliseconds ICE may sit `disconnected` before the link is down. */
  grace: number
  now: () => number
  onChange: (report: LinkReport) => void
}

/** Long enough for ICE to switch pairs after a hiccup, short enough that a person is not left staring. */
export const LINK_GRACE_MS = 8000

export function createLinkMonitor(options: LinkMonitorOptions): LinkMonitor {
  const { grace, now, onChange } = options
  let state: LinkState = 'up'
  let degradedAt = 0

  function move(next: LinkState, reason: string): void {
    if (state === 'down' || next === state) return
    state = next
    onChange({ state, reason })
  }

  return {
    get state() {
      return state
    },
    ice(ice) {
      if (ice === 'connected' || ice === 'completed') {
        move('up', `ice ${ice}`)
      } else if (ice === 'disconnected') {
        if (state === 'up') degradedAt = now()
        move('degraded', 'ice disconnected')
      } else if (ice === 'failed' || ice === 'closed') {
        move('down', `ice ${ice}`)
      }
      // `new` and `checking` change nothing: checking after a drop is ICE trying, still degraded.
    },
    closed() {
      move('down', 'channel closed')
    },
    poll() {
      if (state !== 'degraded') return
      const held = now() - degradedAt
      if (held >= grace) move('down', `ice disconnected for ${Math.round(held / 1000)} s`)
    },
  }
}
