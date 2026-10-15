/**
 * Anonymous-stats session id (#64), sent in its own frame before HELLO rather
 * than in the WebSocket URL, so no proxy log can pair it with an IP. A server
 * without stats ignores the frame in the lobby, like any non-HELLO frame.
 */
export const STATS_SESSION_FRAME = 10
const SESSION = /^[A-Za-z0-9_-]{16,32}$/

export function encodeStatsSession(session: string): Uint8Array {
  if (!SESSION.test(session)) throw new RangeError('invalid stats session')
  const bytes = new TextEncoder().encode(session)
  const frame = new Uint8Array(bytes.length + 1)
  frame[0] = STATS_SESSION_FRAME
  frame.set(bytes, 1)
  return frame
}

/** The session id, or null for anything malformed. Never throws. */
export function decodeStatsSession(frame: Uint8Array): string | null {
  if (frame.length < 17 || frame.length > 33 || frame[0] !== STATS_SESSION_FRAME) return null
  const session = new TextDecoder('ascii').decode(frame.subarray(1))
  return SESSION.test(session) ? session : null
}
