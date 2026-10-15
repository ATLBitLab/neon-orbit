/** Dedicated-server resume proof. This frame is sent before the normal HELLO. */
export const RESUME_FRAME = 8
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export function encodeResumeToken(token: string): Uint8Array {
  if (!TOKEN.test(token)) throw new RangeError('invalid resume token')
  const frame = new Uint8Array(44)
  frame[0] = RESUME_FRAME
  frame.set(new TextEncoder().encode(token), 1)
  return frame
}

export function decodeResumeToken(frame: Uint8Array): string {
  if (frame.length !== 44 || frame[0] !== RESUME_FRAME) throw new RangeError('invalid resume frame')
  const token = new TextDecoder('ascii').decode(frame.subarray(1))
  if (!TOKEN.test(token)) throw new RangeError('invalid resume token')
  return token
}
