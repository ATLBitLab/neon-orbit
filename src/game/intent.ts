/**
 * Admitting intent — the anti-cheat surface.
 *
 * `Controls` is the boundary the whole design rests on: the simulation is
 * handed intent and never asks where it came from. Milestone 1 drew the line,
 * milestone 3 made it one intent per seat, and this module is what stands on
 * the line once one of the producers is a stranger. A packet from another
 * browser is not a keyboard: every field in it is a claim, and the three ways
 * a claim can be wrong are each handled here rather than trusted away.
 *
 * - **Out of range** is a cheat — visible, bounded, correctable. `bound` answers
 *   it, and `Ship` calls the same function on its own inputs, so a value that
 *   somehow bypassed admission is still clamped at the hull. One rule, one
 *   implementation, two call sites.
 * - **Too fast** is the subtler cheat. Throttle is *commanded* with mass: the
 *   keyboard ramps it at a fixed rate, and a sender who skipped the ramp would
 *   gain an acceleration the airframe is not supposed to have. `rampThrottle`
 *   is that rate, and it is the *only* copy — the device pilot in `controls.ts`
 *   calls it too, so the keyboard and the wire agree byte for byte on what the
 *   throttle can do in one tick.
 * - **Not a number at all** is not a cheat, it is destruction: one `NaN` in a
 *   deflection puts the hull at `NaN` for the rest of the match. Missing fields,
 *   wrong types and a truncated binary frame all read this way, and none of
 *   them should be able to remove a participant from the arena.
 *
 * Two fields never survive: `aim`, a fire-direction override that only the AI
 * has a use for, and `spread`, which is zero for every seat and draws from the
 * seat's RNG when it is not. Those two are enforced at the seat itself, in
 * `recordControls`, so that they hold for *every* caller of `Game.step` and not
 * only for packets.
 *
 * Why the ramp is applied here and not inside `Game.step` for everybody: the
 * headless suite drives seats on snapped throttles and asserts on the result,
 * and a `step` that quietly ramped would make "the accepted tick actually
 * simulated at 0.5" false. `Game.step` trusts its caller's *shape* — its callers
 * are the host's own code — and defends only against *values*. The wire is
 * where strangers arrive, so the wire's unpacking boundary is what calls
 * `admitIntent`, as the note on `Game.step` has said since milestone 3.
 */

import type { Controls } from './ship'

/**
 * How fast the throttle ramps, in fraction per second.
 *
 * Asymmetric on purpose: slowing down is more urgent than speeding up, because
 * it is what saves you from a station you did not see.
 */
export const THROTTLE_UP_RATE = 0.85
export const THROTTLE_DOWN_RATE = 1.15

/**
 * Bound a commanded value, and reject one that is not a number at all.
 *
 * The finite check is not defensive padding — it is the more important half.
 * An out-of-range deflection is a *cheat*: visible, bounded, and correctable,
 * because clamping it produces a legal ship. `NaN` is not a cheat, it is
 * destruction. It propagates through the quaternion into the position, and
 * every later integration keeps it there: five honest ticks after a single
 * poisoned one, the hull is still at `NaN` and the participant is gone from the
 * arena for the rest of the match. There is no recovery path in the flight
 * model, and if it lands on the host's own ship there is nothing to roll back
 * to.
 *
 * `Math.max`/`Math.min` propagate `NaN` rather than clamping it, so the obvious
 * clamp does not help.
 *
 * And it does not take malice. A *missing* field reads as `undefined` and a
 * wrong type reads as a string, neither of which is a number at all. JSON
 * cannot carry `NaN`, but a binary snapshot format can —
 * `new Float32Array([NaN])[0]` is `NaN` — so a truncated packet does the same
 * permanent damage a deliberate one would.
 *
 * The guard is deliberately **not** `Number.isFinite`, which is the obvious
 * spelling and is wrong here: it rejects `Infinity` too, and infinity is a
 * perfectly clampable request. "Turn as hard as you can" is a legal thing to
 * ask; the bound is the honest answer. Zeroing it instead would take a hostile
 * input that the plain clamp already handled correctly and quietly neutralise
 * it — a regression hiding inside a hardening fix.
 *
 * Typed as `unknown` on purpose: the whole point is that the caller does not
 * know what it was handed.
 */
export function bound(v: unknown, lo: number, hi: number): number {
  // Not a number at all — missing field, wrong type, or NaN itself.
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  // Finite or infinite, the comparisons below bound it correctly.
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Move a held throttle toward a wanted one, by at most one tick's ramp.
 *
 * A request within reach is returned *exactly* — not `held + (wanted - held)`,
 * which is the same number on paper and a different one in floating point. That
 * is what lets the device pilot call this and still fly the recorded baseline
 * byte for byte: `rampThrottle(t, 1, dt)` is `Math.min(1, t + UP * dt)` down to
 * the last bit, because it evaluates the same expression.
 *
 * A wanted value that is not a number holds. Throttle is the one field with a
 * memory, and the honest answer to "I could not read what you asked for" is to
 * keep doing what you were doing — zero would be a stall, and a stall on a
 * dropped byte is a way to lose a fight to a bad connection.
 */
export function rampThrottle(held: number, wanted: unknown, dt: number): number {
  if (typeof wanted !== 'number' || Number.isNaN(wanted)) return held
  const target = wanted < 0 ? 0 : wanted > 1 ? 1 : wanted
  const up = held + THROTTLE_UP_RATE * dt
  const down = held - THROTTLE_DOWN_RATE * dt
  return target > up ? up : target < down ? down : target
}

/**
 * Turn whatever arrived into a legal intent for one tick.
 *
 * `raw` is a claim, `held` is the intent this seat last flew on, and `out` is
 * the struct to write — reused rather than allocated, like every other producer
 * of `Controls`, and never aliasing `raw`. Nothing in `raw` is retained.
 *
 * A packet that is not an object at all — `undefined` because the tick never
 * arrived, `null`, a number — is a *late* tick, and the answer to a late tick
 * is to hold the last intent: deflection and throttle carry on, so a hull mid-
 * turn keeps turning for a dropped frame instead of snapping level. The two
 * triggers do **not** carry: a dropped connection must not keep a gun firing or
 * a dash queued on the last thing its owner said before they vanished.
 *
 * `fire` and `dash` are admitted only as the literal `true`. A truthy string is
 * not a trigger pull, and the alternative — `Boolean(x)` — would let `"false"`
 * fire.
 */
export function admitIntent(raw: unknown, held: Controls, dt: number, out: Controls): Controls {
  if (typeof raw !== 'object' || raw === null) {
    out.pitch = held.pitch
    out.yaw = held.yaw
    out.roll = held.roll
    out.throttle = held.throttle
    out.fire = false
    out.dash = false
    out.aim = null
    out.spread = 0
    return out
  }
  const claim = raw as Record<string, unknown>
  out.pitch = bound(claim.pitch, -1, 1)
  out.yaw = bound(claim.yaw, -1, 1)
  out.roll = bound(claim.roll, -1, 1)
  out.throttle = rampThrottle(held.throttle, claim.throttle, dt)
  out.fire = claim.fire === true
  out.dash = claim.dash === true
  out.aim = null
  out.spread = 0
  return out
}
