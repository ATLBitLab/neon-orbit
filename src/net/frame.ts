import type { Game } from '../game/game'
import type { Controls } from '../game/ship'
import type { Hosting, Joining, NetMode } from './browser'

/** A networked match never becomes a local one just because its link closed. */
export function stepSession(
  mode: NetMode, hosting: Pick<Hosting, 'tick'> | null, joining: Pick<Joining, 'tick'> | null,
  game: Pick<Game, 'step'>, intents: readonly Controls[],
): void {
  if (hosting) hosting.tick(intents[0])
  else if (joining) joining.tick(intents[0])
  else if (mode.kind === 'solo') game.step(intents)
}
