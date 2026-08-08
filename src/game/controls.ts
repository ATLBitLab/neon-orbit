/**
 * Turning a device into intent.
 *
 * `Controls` is what the flight model consumes and what `EnemyPilot` produces —
 * one struct, both sides, which is the decision the whole ship design rests on.
 * This module is the third producer: a human's keyboard and mouse.
 *
 * It lives outside `Game` on purpose. The simulation is handed intent rather
 * than reaching for a device, so the same `step` runs against a keyboard, a
 * recorded stream, or a packet from another browser and cannot tell which. That
 * is the entire boundary multiplayer needs, and it is cheaper to draw now than
 * to retrofit around a `Game` that knows what a mouse is.
 */

import type { InputState } from '../core/input'
import type { Controls } from './ship'

/**
 * How fast the throttle ramps, in fraction per second.
 *
 * Asymmetric on purpose: slowing down is more urgent than speeding up, because
 * it is what saves you from a station you did not see.
 */
const THROTTLE_UP_RATE = 0.85
const THROTTLE_DOWN_RATE = 1.15

/** Throttle a ship launches at. Enough to be flying, short of committed. */
export const LAUNCH_THROTTLE = 0.6

export interface Pilot {
  /**
   * Fold this tick's device state into the running controls and return them.
   *
   * The returned struct is reused rather than freshly allocated — this runs
   * sixty times a second — so read it or copy it before the next call.
   */
  advance(state: InputState, dt: number): Controls
  /** Back to launch conditions. Called when a run starts. */
  reset(): void
}

export function createPilot(): Pilot {
  const controls: Controls = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: LAUNCH_THROTTLE,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
  }

  return {
    advance(state, dt) {
      /*
       * Throttle integrates here rather than being read straight off a key,
       * which is what makes it a *commanded* value with mass rather than a
       * switch.
       *
       * Worth knowing before this crosses a wire: `Ship.applyThrottle` only
       * clamps the commanded value to [0, 1] — the rate limit is here, on the
       * device side. A remote client that sent `throttle: 1` outright would
       * skip the ramp entirely and gain an acceleration the airframe is not
       * supposed to have. The host will have to enforce the rate on controls it
       * receives rather than trusting them, exactly as it will for everything
       * else in this struct. See `PLANS/NEON_ORBIT_PHASE_B.md`.
       */
      if (state.throttleUp) {
        controls.throttle = Math.min(1, controls.throttle + THROTTLE_UP_RATE * dt)
      }
      if (state.throttleDown) {
        controls.throttle = Math.max(0, controls.throttle - THROTTLE_DOWN_RATE * dt)
      }

      controls.pitch = state.pitch
      controls.yaw = state.yaw
      controls.roll = state.roll
      controls.fire = state.fire
      controls.dash = state.dash
      return controls
    },

    reset() {
      controls.throttle = LAUNCH_THROTTLE
      controls.pitch = 0
      controls.yaw = 0
      controls.roll = 0
      controls.fire = false
      controls.dash = false
    },
  }
}
