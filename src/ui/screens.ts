/**
 * The screen state, and the one transition that has earned a test.
 *
 * This module exists because of a bug that has now been fixed three times, each fix
 * moving the tested boundary one layer inward and each time leaving the shipped caller
 * outside it. Worth the whole history, because the history is the argument:
 *
 * 1. The pause guard widened from "is the drawn seat exploding" to "is any seat
 *    exploding". Its caller in `main.ts` kept its own answer — it tested `game.dying`,
 *    showed the panel, then called `pause()` without looking. The overlay sat over a
 *    match that kept fighting: 140 units of travel in the following second.
 * 2. `Game.pause()` started returning whether it paused, and `main.ts` honoured it.
 *    But `boot()` needs a canvas, so nothing headless could run that line: restoring
 *    the old caller left 367 checks and 31 mutants green.
 * 3. The decision moved into a DOM-free flow returning the new screen, and `main.ts`
 *    assigned it. I wrote that a caller "cannot ignore a value it has to assign".
 *    **That is false.** `pauseFlow.enter()` as a bare statement is valid TypeScript
 *    that discards the result — after which the panel goes up, `screen` stays
 *    `'flight'`, and Resume refuses because it is not on the pause screen. The player
 *    is trapped behind the overlay, with every gate green. Reproduced before this
 *    rewrite.
 *
 * So the state itself lives here rather than the answer about it. `enter` and `exit`
 * return `void` and write `state.screen` themselves, and they own their own
 * preconditions too — there is no decision left in `main.ts` to be inconsistent with,
 * and nothing for a caller to discard. The lesson generalises past pause: **a seam that
 * hands a decision back to untested code has not moved the decision.**
 *
 * Only the pause transition is in here. Hangar, launch and debrief still write
 * `state.screen` from `main.ts`, and they should move the day one of them earns it the
 * same way this did — by breaking.
 */

export type Screen = 'hangar' | 'flight' | 'paused' | 'debrief'

/**
 * The single screen variable, shared by reference.
 *
 * A holder rather than a setter callback, deliberately: a callback is another line of
 * untested adapter in `main.ts` that could be wired to nothing. There is one variable,
 * this module writes it, and `main.ts` reads the same one.
 */
export interface ScreenState {
  screen: Screen
}

export interface PauseHost {
  /**
   * Freeze the simulation, reporting whether it actually froze. Refused while any
   * participant's explosion is still playing — see `Game.pause`.
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
   * Put the pause screen up. Does nothing unless the game is in flight *and* the
   * simulation agreed to stop — a refusal leaves everything exactly as it was, which
   * is correct rather than a silent failure: a cutscene is playing and the player
   * carries on watching it.
   */
  enter(): void
  /** Take it down again. Does nothing unless it is up. */
  exit(): void
  /** What `Esc` and `P` do: up if down, down if up. */
  toggle(): void
}

export function createPauseFlow(state: ScreenState, host: PauseHost): PauseFlow {
  const flow: PauseFlow = {
    enter() {
      // Both guards live here, not at the call site. `main.ts` used to hold the first
      // one and disagree with the second.
      if (state.screen !== 'flight') return
      // Ask before showing anything. Showing the panel first is the same bug with
      // better manners.
      if (!host.pause()) return
      host.showPanel()
      state.screen = 'paused'
    },

    exit() {
      if (state.screen !== 'paused') return
      // Panel down before the simulation restarts, so the first live frame is never
      // drawn behind an overlay on its way out.
      host.hidePanel()
      host.resume()
      host.grabPointer()
      state.screen = 'flight'
    },

    toggle() {
      if (state.screen === 'paused') flow.exit()
      else flow.enter()
    },
  }
  return flow
}
