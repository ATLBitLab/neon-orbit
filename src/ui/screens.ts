/**
 * Which screen the app is on, and the transitions that decide it.
 *
 * This module owns the screen. Not a holder handed to it, not a setter it calls back
 * into — the variable itself lives here, because four review rounds on one transition
 * each ended with a production obligation that no test could execute:
 *
 * 1. `main.ts` kept its own copy of the pause condition (`game.dying`) and disagreed
 *    with `Game.pause()`. The overlay sat over a match that kept fighting: 140 units
 *    of travel in the following second.
 * 2. `Game.pause()` returned its answer and `main.ts` honoured it — but `boot()` needs
 *    a canvas, so nothing headless could run that line. Restoring the old caller left
 *    367 checks and 31 mutants green.
 * 3. A DOM-free flow returned the new screen for `main.ts` to assign. I claimed a
 *    caller "cannot ignore a value it has to assign"; that is false, and
 *    `flow.enter()` as a bare statement leaves the panel up with the screen still
 *    `'flight'`, so Resume refuses and the player is sealed in.
 * 4. The flow wrote a holder `main.ts` passed in. `createPauseFlow({ ...state }, host)`
 *    is valid TypeScript that hands over a *copy*: the app launches, the flow still
 *    sees `'hangar'`, and Escape does nothing. All 389 checks and 39 mutants green.
 *
 * The shape of the mistake was the same every time and it was never the mechanism —
 * a boolean, a return value, an object reference. It was that the last step of the
 * decision stayed in code no test could reach. So there is nothing left to pass and
 * nothing to assign: `createScreens` takes only the things it must *do*, and the app
 * reads `screens.screen`.
 *
 * `moveTo` cannot reach `'paused'`, in the type system and again at runtime. Only
 * `enterPause` may put the overlay up, which is what makes the trap those four rounds
 * kept producing unrepresentable from outside rather than merely absent today.
 *
 * What is still not covered, stated plainly because claiming otherwise is the actual
 * recurring defect here: `main.ts` still chooses *which* transition to call, and its
 * five host adapters are one-line lambdas. Nothing headless executes either, because
 * nothing headless can call `boot()`. What would close it is a browser-level test of
 * `boot()`, and that is a real dependency rather than a refactor. The residue is now
 * "did the app call the right method", not "did the app correctly finish a decision
 * the module started".
 */

export type Screen = 'hangar' | 'flight' | 'paused' | 'debrief'

/**
 * Every screen except the pause overlay.
 *
 * The overlay is reachable only through `enterPause`, because it is the one screen
 * whose transition has a precondition — the simulation has to agree to stop — and
 * every regression in the list above came from something outside this module deciding
 * it had.
 */
export type AppScreen = Exclude<Screen, 'paused'>

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

export interface Screens {
  /** The screen the app is on. The only source of truth for it. */
  readonly screen: Screen
  /**
   * Put the pause overlay up. Does nothing unless the app is in flight *and* the
   * simulation agreed to stop — a refusal leaves everything exactly as it was, which
   * is correct rather than a silent failure: a cutscene is playing and the player
   * carries on watching it.
   */
  enterPause(): void
  /** Take it down again. Does nothing unless it is up. */
  exitPause(): void
  /** What `Esc` and `P` do: up if down, down if up. */
  togglePause(): void
  /**
   * Go to a screen this module does not gate. Refuses `'paused'` — see `AppScreen`.
   */
  moveTo(screen: AppScreen): void
}

export function createScreens(host: PauseHost, start: AppScreen = 'hangar'): Screens {
  let screen: Screen = start

  const screens: Screens = {
    get screen() {
      return screen
    },

    enterPause() {
      // Both guards live here. `main.ts` used to hold the first and disagree with the
      // second.
      if (screen !== 'flight') return
      // Ask before showing anything. Showing the panel first is the same bug with
      // better manners.
      if (!host.pause()) return
      host.showPanel()
      screen = 'paused'
    },

    exitPause() {
      if (screen !== 'paused') return
      // Panel down before the simulation restarts, so the first live frame is never
      // drawn behind an overlay on its way out.
      host.hidePanel()
      host.resume()
      host.grabPointer()
      screen = 'flight'
    },

    togglePause() {
      if (screen === 'paused') screens.exitPause()
      else screens.enterPause()
    },

    moveTo(next) {
      /*
       * Refused loudly rather than ignored, and the type already forbids it, so this is
       * for the bundled JavaScript and for anyone reaching in from a console.
       *
       * The pause screen is the one screen with a precondition attached, and every
       * regression this module exists to prevent came from something outside it
       * deciding that precondition was met. A silent refusal here would leave the app
       * on a screen the caller did not expect with no signal at all, which is the
       * failure class rather than a smaller version of it.
       */
      if ((next as Screen) === 'paused') {
        throw new RangeError('only enterPause may reach the pause screen')
      }
      screen = next
    },
  }
  return screens
}
