/**
 * `window.__neon` — the read-only view of a running game, for the dev console.
 *
 * A module rather than an object literal inside `boot()`, for the reason everything
 * else in this corner of the codebase became a module: nothing headless can call
 * `boot()`, so anything living in there is a claim rather than a check. This one had
 * already regressed once. Moving the screen state out of `main.ts` left the hook
 * reading a bare `screen`, which compiles against the DOM global — so
 * `window.__neon.screen` reported the browser's `Screen` object instead of `'hangar'`,
 * `'flight'`, `'paused'` or `'debrief'`. Types accepted it, 396 checks accepted it, 42
 * mutations accepted it, and the build accepted it.
 *
 * Two properties matter here and both are asserted through an installed hook rather
 * than through this factory's return value, because installation is where the last one
 * went wrong:
 *
 * - **Every field is live.** These are getters over the objects themselves. Snapshotting
 *   at construction would report boot-time values forever, which for a debugging surface
 *   is worse than not existing.
 * - **The sources are the real objects.** `screens` and `game` are passed whole rather
 *   than as `() => screens.screen` lambdas, so the field that regressed has no adapter
 *   left to point at the wrong thing. The one thing still handed over as a function is
 *   `start`, because it is a command rather than a reading.
 */

import type { RunSnapshot } from '../game/game'
import type { ShipId } from '../ships/specs'
import type { Screen } from '../ui/screens'
import type { InputState } from './input'

export interface DevHookSources {
  screens: { readonly screen: Screen }
  game: { snapshot(seat?: number): RunSnapshot | null }
  input: { readonly state: InputState; readonly pointerLocked: boolean }
  /** Launch a run. The one command on an otherwise read-only surface. */
  start(ship: ShipId): void
}

export interface DevHook {
  readonly screen: Screen
  readonly run: RunSnapshot | null
  readonly input: InputState & { pointerLocked: boolean }
  start(ship: ShipId): void
}

export function createDevHook(sources: DevHookSources): DevHook {
  return {
    get screen() {
      return sources.screens.screen
    },
    get run() {
      return sources.game.snapshot()
    },
    get input() {
      // Copied rather than handed over: the console should not be able to fly the ship
      // by assigning to what it is shown.
      return { ...sources.input.state, pointerLocked: sources.input.pointerLocked }
    },
    start: sources.start,
  }
}

/**
 * Put the hook on a global.
 *
 * `configurable` so a hot reload can replace it — without that, the second install of a
 * dev session throws and the console silently keeps the first game's view of a game that
 * no longer exists.
 */
export function installDevHook(target: object, hook: DevHook, name = '__neon'): void {
  Object.defineProperty(target, name, { value: hook, configurable: true })
}
