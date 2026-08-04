/**
 * High scores in localStorage.
 *
 * Deliberately the only persistence in the game. The brief called for an
 * in-client first iteration, so there is no account, no server and no sync —
 * one key holding a best-per-airframe record plus the last run.
 */

import type { ShipId } from '../ships/specs'

const KEY = 'neon-orbit.scores.v1'

export interface RunResult {
  ship: ShipId
  score: number
  kills: number
  /** Seconds elapsed. */
  time: number
  won: boolean
  accuracy: number
}

interface Best {
  score: number
  kills: number
  time: number
  won: boolean
}

interface Store {
  best: Partial<Record<ShipId, Best>>
  lastShip?: ShipId
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { best: {} }
    const parsed = JSON.parse(raw) as Store
    // Storage is user-writable and survives version changes; treat it as
    // untrusted and fall back to empty rather than crashing the boot.
    if (!parsed || typeof parsed !== 'object' || typeof parsed.best !== 'object') return { best: {} }
    return { best: parsed.best ?? {}, lastShip: parsed.lastShip }
  } catch {
    return { best: {} }
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Private browsing or a full quota. Scores are a nicety, not a feature
    // worth failing a run over.
  }
}

export function bestFor(ship: ShipId): Best | undefined {
  return read().best[ship]
}

export function overallBest(): { ship: ShipId; score: number } | undefined {
  const { best } = read()
  let top: { ship: ShipId; score: number } | undefined
  for (const [ship, entry] of Object.entries(best) as [ShipId, Best][]) {
    if (!top || entry.score > top.score) top = { ship, score: entry.score }
  }
  return top
}

export function lastShip(): ShipId | undefined {
  return read().lastShip
}

export function rememberShip(ship: ShipId): void {
  const store = read()
  store.lastShip = ship
  write(store)
}

/** Records the run. Returns true when it beat the previous best for that ship. */
export function recordRun(result: RunResult): boolean {
  const store = read()
  const previous = store.best[result.ship]
  const isRecord = !previous || result.score > previous.score

  if (isRecord) {
    store.best[result.ship] = {
      score: result.score,
      kills: result.kills,
      time: result.time,
      won: result.won,
    }
  }
  store.lastShip = result.ship
  write(store)
  return isRecord
}
