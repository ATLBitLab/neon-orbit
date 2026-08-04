/**
 * Deterministic randomness.
 *
 * The world is generated from a fixed seed so the planet, station layout and
 * debris field are the same every session — the arena becomes a place you can
 * learn rather than a lottery. Gameplay jitter (AI aim error, particle spread)
 * deliberately uses `Math.random()` instead, since that should vary per run.
 */

/** mulberry32 — small, fast, good enough for terrain and scatter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  (): number
  /** Uniform in [min, max). */
  range(min: number, max: number): number
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number
  /** Uniform in [-n, n). */
  spread(n: number): number
  pick<T>(items: readonly T[]): T
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed)
  const rng = (() => next()) as Rng
  rng.range = (min, max) => min + next() * (max - min)
  rng.int = (min, max) => min + Math.floor(next() * (max - min + 1))
  rng.spread = (n) => (next() * 2 - 1) * n
  rng.pick = (items) => items[Math.floor(next() * items.length)]
  return rng
}

/** The seed the shipped arena is built from. */
export const WORLD_SEED = 0x4e30b17
