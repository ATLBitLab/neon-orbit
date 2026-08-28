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
import { rampThrottle } from './intent'
import type { Controls } from './ship'

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
       * The ramp itself is `rampThrottle`, shared with the wire boundary. That
       * is not tidiness: this used to be the only place the rate lived, so a
       * remote client that sent `throttle: 1` outright skipped the ramp and
       * gained an acceleration the airframe is not supposed to have. The host
       * now enforces the same rate on intents it admits — see `intent.ts` —
       * and because it is one function, the local keyboard and a stranger's
       * packet cannot drift apart on what "as fast as the throttle moves" means.
       */
      if (state.throttleUp) controls.throttle = rampThrottle(controls.throttle, 1, dt)
      if (state.throttleDown) controls.throttle = rampThrottle(controls.throttle, 0, dt)

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
