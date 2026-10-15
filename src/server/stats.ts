/**
 * Anonymous per-match gameplay stats (#64).
 *
 * One JSONL line per match and one per human seat. Allowed fields are listed
 * explicitly below; nothing about a connection (IP, user agent, resume token,
 * room code, pubkey, name) is ever handed to this module, so it cannot leak.
 * The only cross-match link is `session`: a random id the browser keeps in
 * sessionStorage, so repeat picks are visible without identifying anybody.
 */
import { appendFile, rename, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { MatchResult } from '../core/scores'
import type { RunSnapshot } from '../game/game'
import type { ShipId } from '../ships/specs'

export const STATS_VERSION = 1
/** Death positions are rounded to this grid (arena radius is 3400). */
const POSITION_GRID = 100
const MAX_DEATH_POSITIONS = 40

export type Departure = 'end' | 'quit' | 'disconnect'
export type Outcome = 'cleared' | 'wiped' | 'abandoned'

/** A browser closing its socket on purpose (quit, tab closed) vs. the link dropping. */
export function departureOf(code: number): Departure {
  return code === 1000 || code === 1001 || code === 1005 ? 'quit' : 'disconnect'
}

interface SeatState {
  seat: number
  ship: ShipId
  session: string | null
  kills: number
  deaths: number
  firstKillS: number | null
  lifeStart: number
  lives: number[]
  damageTaken: number
  lastHull: number | null
  deathPositions: [number, number, number][]
  left: Departure | null
}

const round1 = (value: number) => Math.round(value * 10) / 10
const grid = (value: number) => Math.round(value / POSITION_GRID) * POSITION_GRID

export interface MatchStats {
  /** Feed the current per-seat view. Call every few ticks; cheap. */
  sample(view: (seat: number) => RunSnapshot | null): void
  leave(seat: number, how: Departure): void
  rejoin(seat: number): void
  /** Seal the match. Returns the lines to write, once; later calls return []. */
  finish(outcome: Outcome, result: MatchResult | null, view: (seat: number) => RunSnapshot | null): object[]
}

export function createMatchStats(
  ships: readonly ShipId[], humans: ReadonlyMap<number, string | null>, now = Date.now(),
): MatchStats {
  const id = randomBytes(8).toString('hex')
  // Coarse: the hour the match started, never an exact instant.
  const startedHour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString()
  let elapsed = 0
  let done = false
  const seats: SeatState[] = [...humans].sort(([a], [b]) => a - b).map(([seat, session]) => ({
    seat, ship: ships[seat], session, kills: 0, deaths: 0, firstKillS: null, lifeStart: 0,
    lives: [], damageTaken: 0, lastHull: null, deathPositions: [], left: null,
  }))
  const bySeat = (seat: number) => seats.find(state => state.seat === seat)

  function sample(view: (seat: number) => RunSnapshot | null): void {
    for (const state of seats) {
      const snap = view(state.seat)
      if (!snap) continue
      elapsed = snap.elapsed
      if (snap.kills > state.kills && state.firstKillS === null) state.firstKillS = round1(snap.elapsed)
      state.kills = snap.kills
      if (snap.deaths > state.deaths) {
        state.lives.push(round1(snap.elapsed - state.lifeStart))
        if (state.deathPositions.length < MAX_DEATH_POSITIONS) {
          state.deathPositions.push([grid(snap.position.x), grid(snap.position.y), grid(snap.position.z)])
        }
        state.deaths = snap.deaths
        state.lastHull = null
      }
      if (snap.phase === 'flying') {
        if (state.lastHull === null) state.lifeStart = snap.elapsed
        else if (snap.hull < state.lastHull) state.damageTaken += state.lastHull - snap.hull
        state.lastHull = snap.hull
      }
    }
  }

  return {
    sample,
    leave(seat, how) { const state = bySeat(seat); if (state) state.left = how },
    rejoin(seat) { const state = bySeat(seat); if (state) state.left = null },
    finish(outcome, result, view) {
      if (done) return []
      done = true
      sample(view)
      const durationS = round1(result?.time ?? elapsed)
      const lines: object[] = [{
        type: 'match', v: STATS_VERSION, match: id, startedHour, durationS, outcome,
        seats: ships.length, humans: seats.length, ships: [...ships],
      }]
      for (const state of seats) {
        const line = result?.lines.find(entry => entry.seat === state.seat)
        const snap = view(state.seat)
        const shots = line?.shots ?? snap?.shotsFired ?? 0
        const hits = line?.hits ?? snap?.hits ?? 0
        const lives = snap?.phase === 'flying' ? [...state.lives, round1(durationS - state.lifeStart)] : state.lives
        lines.push({
          type: 'player', v: STATS_VERSION, match: id, seat: state.seat, ship: state.ship,
          session: state.session,
          kills: line?.kills ?? state.kills, deaths: line?.deaths ?? state.deaths,
          shots, hits, hitRate: shots > 0 ? Math.round(Math.min(1, hits / shots) * 1000) / 1000 : null,
          timeToFirstKillS: state.firstKillS, livesS: lives,
          damageTaken: Math.round(state.damageTaken), deathPositions: state.deathPositions,
          left: state.left ?? 'end', place: line?.place ?? null, won: line?.won ?? false,
        })
      }
      return lines
    },
  }
}

/**
 * Append-only JSONL file with one rotation (`path.1`), so disk use stays under
 * about twice `maxBytes`. Every failure is swallowed after one log line: a
 * stats problem must never reach a match.
 */
export class StatsLog {
  private size: number | null = null
  private queue: Promise<void> = Promise.resolve()
  private warned = false

  constructor(readonly path: string, readonly maxBytes: number) {}

  append(lines: object[]): Promise<void> {
    if (lines.length === 0) return this.queue
    let text: string
    try { text = lines.map(line => JSON.stringify(line)).join('\n') + '\n' } catch { return this.queue }
    this.queue = this.queue.then(() => this.write(text)).catch(error => {
      this.size = null
      if (!this.warned) { this.warned = true; console.error('[neon-orbit] match stats write failed', error) }
    })
    return this.queue
  }

  private async write(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text)
    if (this.size === null) this.size = await stat(this.path).then(info => info.size, () => 0)
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      await rename(this.path, `${this.path}.1`)
      this.size = 0
    }
    await appendFile(this.path, text, { mode: 0o600 })
    this.size += bytes
  }
}
