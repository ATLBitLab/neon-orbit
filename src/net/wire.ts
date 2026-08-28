/**
 * Bytes on the wire.
 *
 * Two small cursors over a `DataView`, and the one frame format that is not a
 * snapshot: a client's intent for one tick. Everything else that crosses the
 * wire is in `snapshot.ts` and is built from these.
 *
 * Little-endian throughout, float32 for every real number. Float32 is a
 * deliberate loss: the simulation runs in float64, but a client only needs to
 * *draw* what it is sent, and 1e-4 units of position at arena scale is well
 * under a pixel. The host never reads its own snapshots back, so nothing in the
 * simulation depends on the rounding.
 *
 * The reader refuses to read past the end rather than returning `undefined` or
 * `NaN`. A truncated frame is the ordinary failure of a real transport, and the
 * decoder above this must be able to reject the whole frame before any of it is
 * applied — half a snapshot is worse than none.
 */

import { admitIntent } from '../game/intent'
import type { Controls } from '../game/ship'

export class ByteWriter {
  private buffer: ArrayBuffer
  private view: DataView
  private offset = 0

  constructor(capacity = 1024) {
    this.buffer = new ArrayBuffer(capacity)
    this.view = new DataView(this.buffer)
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes <= this.buffer.byteLength) return
    let capacity = this.buffer.byteLength * 2
    while (capacity < this.offset + bytes) capacity *= 2
    const grown = new ArrayBuffer(capacity)
    new Uint8Array(grown).set(new Uint8Array(this.buffer, 0, this.offset))
    this.buffer = grown
    this.view = new DataView(grown)
  }

  u8(v: number): this {
    this.ensure(1)
    this.view.setUint8(this.offset, v)
    this.offset += 1
    return this
  }

  u16(v: number): this {
    this.ensure(2)
    this.view.setUint16(this.offset, v, true)
    this.offset += 2
    return this
  }

  u32(v: number): this {
    this.ensure(4)
    this.view.setUint32(this.offset, v >>> 0, true)
    this.offset += 4
    return this
  }

  i32(v: number): this {
    this.ensure(4)
    this.view.setInt32(this.offset, v, true)
    this.offset += 4
    return this
  }

  f32(v: number): this {
    this.ensure(4)
    this.view.setFloat32(this.offset, v, true)
    this.offset += 4
    return this
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }

  /** The bytes written so far, as a fresh copy. */
  bytes(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0, this.offset))
  }

  get length(): number {
    return this.offset
  }
}

export class ByteReader {
  private readonly view: DataView
  private offset = 0

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private need(bytes: number): void {
    if (this.offset + bytes > this.view.byteLength) {
      throw new RangeError(
        `frame is short: wanted ${bytes} byte(s) at offset ${this.offset} of ${this.view.byteLength}`,
      )
    }
  }

  u8(): number {
    this.need(1)
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.offset, true)
    this.offset += 4
    return v
  }

  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  /** True once every byte has been consumed. A frame with a tail is not this frame. */
  get done(): boolean {
    return this.offset === this.view.byteLength
  }

  /** Refuse a frame that has bytes left over: it is a different, longer format. */
  finish(): void {
    if (!this.done) {
      throw new RangeError(
        `frame is long: ${this.view.byteLength - this.offset} byte(s) left after the last field`,
      )
    }
  }
}

/* ---- Intent frames ------------------------------------------------------- */

/** The one wire format for a client's intent. Bumped when the layout changes. */
export const INTENT_VERSION = 1

/** Fixed size: version, seat, tick, four floats, two flags. */
export const INTENT_FRAME_BYTES = 1 + 1 + 4 + 4 * 4 + 2

/**
 * What a client says about one tick.
 *
 * `tick` is the host tick this intent is *for*, so a late frame can be told
 * from a lost one; `seat` is which seat is claiming it. Neither is trusted by
 * the decoder here — a seat number is authorisation, and authorisation is the
 * transport's job (milestone 6), not the codec's. The decoder only promises
 * that the bytes were well-formed and that the intent inside is legal.
 */
export interface IntentFrame {
  seat: number
  tick: number
  controls: Controls
}

export function encodeIntent(seat: number, tick: number, c: Controls, w = new ByteWriter(INTENT_FRAME_BYTES)): Uint8Array {
  w.u8(INTENT_VERSION)
  w.u8(seat)
  w.u32(tick)
  w.f32(c.pitch).f32(c.yaw).f32(c.roll).f32(c.throttle)
  w.bool(c.fire).bool(c.dash)
  return w.bytes()
}

/**
 * Read an intent frame and admit it.
 *
 * The last step is `admitIntent`, which is the point: the codec reads floats,
 * and a float can be anything — `Float32Array` carries `NaN` and infinities
 * happily. Nothing that comes out of here has bypassed the anti-cheat surface,
 * so a caller cannot forget to apply it.
 *
 * Throws `RangeError` on the wrong version, a short frame or a long one. A
 * frame that throws has changed nothing: `out` is only written on success.
 */
export function decodeIntent(bytes: Uint8Array, held: Controls, dt: number, out: Controls): IntentFrame {
  const r = new ByteReader(bytes)
  const version = r.u8()
  if (version !== INTENT_VERSION) {
    throw new RangeError(`intent frame version ${version}, expected ${INTENT_VERSION}`)
  }
  const seat = r.u8()
  const tick = r.u32()
  const claim = {
    pitch: r.f32(),
    yaw: r.f32(),
    roll: r.f32(),
    throttle: r.f32(),
    fire: r.bool(),
    dash: r.bool(),
  }
  r.finish()
  return { seat, tick, controls: admitIntent(claim, held, dt, out) }
}
