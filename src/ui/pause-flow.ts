/**
 * Entering and leaving the pause screen.
 *
 * This is fifteen lines in its own module because of what happened when it was
 * fifteen lines inside `boot()`. The pause guard moved from "is the drawn seat
 * exploding" to "is any seat exploding", and its caller in `src/main.ts` kept
 * deciding for itself: it tested `game.dying`, showed the panel, and called
 * `pause()` without looking at the answer. With a remote participant wrecked and the
 * local hull still flying those two disagreed, so the overlay went up over a match
 * that kept fighting behind it — 140 units of travel in the following second.
 *
 * The repair was easy and the repair was not the problem. The problem was that
 * nothing could *execute* it: `boot()` needs a canvas, an overlay and a DOM, so the
 * headless suite could assert everything about `Game.pause()` and nothing at all
 * about the one line that consumed it. Restoring the exact regression left 367
 * simulation checks and 31 mutants entirely green. A test that certifies a callee and
 * claims to protect its caller is worse than no test, because the claim is what stops
 * anyone writing the real one.
 *
 * So the decision lives here, behind an interface with no DOM in it, and `main.ts`
 * calls it rather than reimplementing it. Note the shape of the return: `enter`
 * hands back **the screen you are now on**, not a boolean saying whether it worked.
 * A boolean is a thing a caller can ignore — which is precisely the bug — and there
 * is no way to ignore a value you have to assign.
 */

/** The two screens this flow moves between. */
export type PauseScreen = 'flight' | 'paused'

export interface PauseHost {
  /**
   * Freeze the simulation, reporting whether it actually froze. Refused while any
   * participant's explosion is still playing.
   */
  pause(): boolean
  resume(): void
  showPanel(): void
  hidePanel(): void
  /** Hand the mouse back to the game. */
  grabPointer(): void
}

export interface PauseFlow {
  /**
   * Ask to pause. Returns `'paused'` when the simulation actually stopped and the
   * panel is up, and `'flight'` when the game refused — in which case nothing has
   * happened at all, which is the correct outcome rather than a silent failure: a
   * cutscene is playing and the player keeps watching it.
   */
  enter(): PauseScreen
  /** Leave the pause screen. */
  exit(): PauseScreen
}

export function createPauseFlow(host: PauseHost): PauseFlow {
  return {
    enter() {
      // The order matters and is asserted: ask first, and show nothing if the answer
      // is no. Showing the panel before asking is the same bug with better manners.
      if (!host.pause()) return 'flight'
      host.showPanel()
      return 'paused'
    },

    exit() {
      // Panel down before the simulation restarts, so the first live frame is never
      // drawn behind an overlay that is on its way out.
      host.hidePanel()
      host.resume()
      host.grabPointer()
      return 'flight'
    },
  }
}
