import { awardPotWinner } from '../game/game'
import type { SeatLine } from '../core/scores'

/** Only a connected paid pilot may win; abandoned AI flight never counts. */
export function choosePotWinner(lines: SeatLine[], participants: readonly number[],
  connected: readonly number[], lastConnectedScores: ReadonlyMap<number, number>,
  forfeited: ReadonlySet<number>): number | null {
  const active = connected.filter(seat => participants.includes(seat) && !forfeited.has(seat))
  if (active.length) return awardPotWinner(lines, active)
  const ranked = [...lastConnectedScores].filter(([seat]) =>
    participants.includes(seat) && !forfeited.has(seat))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
  if (!ranked.length || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return null
  return awardPotWinner(lines, [ranked[0][0]])
}
