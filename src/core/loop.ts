/**
 * The fixed-step clock.
 *
 * Turns a stream of irregular frame times into a whole number of simulation
 * ticks plus the leftover, which is what lets the simulation run at a rate the
 * display cannot influence.
 *
 * This lives in its own module rather than inline in the render loop for one
 * reason: inline, it was the only load-bearing part of the fixed step that no
 * test could reach. `main.ts` never runs headless, so a bug here — dropping owed
 * time, or letting the accumulator run away on a slow frame — would have been
 * invisible to `npm run check` while breaking the exact property the fixed step
 * exists to provide.
 */

export interface FrameBudget {
  /** Whole simulation ticks this frame owes. */
  ticks: number
  /**
   * Real seconds this frame gets for presentation, after clamping. Particles,
   * camera follow and world spin run on this rather than on the tick, so they
   * stay smooth on a display faster than the tick rate.
   */
  frameSeconds: number
  /**
   * How far past the last tick the frame lands, 0..1. The blend factor for
   * interpolating everything drawn between two ticks.
   */
  alpha: number
}

export interface StepClock {
  /** Feed a frame's elapsed real time and get back what to run. */
  advance(elapsedSeconds: number): FrameBudget
  /** Drop owed time. For resuming from a pause without a burst of catch-up. */
  reset(): void
}

/**
 * @param step          seconds of simulation per tick
 * @param maxFrame      longest frame accepted, in seconds. Time beyond this is
 *                      discarded rather than queued: a frame that arrives late
 *                      enough would otherwise owe more simulation than the next
 *                      frame has time to run, making the next frame later
 *                      still. Dropping the excess loses a moment; queueing it
 *                      loses the session.
 */
export function createStepClock(step: number, maxFrame: number): StepClock {
  let accumulator = 0

  return {
    advance(elapsedSeconds) {
      const frameSeconds = Math.min(Math.max(0, elapsedSeconds), maxFrame)
      accumulator += frameSeconds

      // `floor` and a single subtraction rather than a while-loop: the
      // remainder has to survive into the next frame, and a loop that
      // decremented past zero would quietly discard it.
      const ticks = Math.floor(accumulator / step)
      accumulator -= ticks * step

      return { ticks, frameSeconds, alpha: accumulator / step }
    },

    reset() {
      accumulator = 0
    },
  }
}
