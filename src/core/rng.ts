/**
 * Deterministic randomness.
 *
 * The world is generated from a fixed seed so the planet, station layout and
 * debris field are the same every session — the arena becomes a place you can
 * learn rather than a lottery.
 *
 * Gameplay jitter — AI wander, break timing, gun spread, arrival points — draws
 * from a per-run seed instead, so a run varies but is still reproducible from
 * its seed plus its inputs. That is what makes a run replayable, and it is the
 * precondition for a server or a host peer arriving at the same result from the
 * same inputs. Nothing that decides an outcome may call `Math.random()`.
 *
 * Purely cosmetic scatter — particles, camera shake, wreck sparks — is exempt
 * and deliberately still uses `Math.random()`. Two viewers of one run may see
 * different sparks; they may not see different hulls.
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

/**
 * An independent stream derived from a run seed.
 *
 * Every consumer that draws during a run gets its own substream rather than
 * sharing one. If they all drew from a single stream, adding or removing a
 * single draw anywhere — one more AI state, one fewer spawn retry — would shift
 * every later draw in the run, and a replay recorded before the change would
 * stop reproducing. Substreams keep a change local to the consumer that made
 * it.
 *
 * `label` distinguishes consumers: a constant per call site, plus the entity
 * index where there are several of a kind. The odd multiplier scatters adjacent
 * labels so pilot 0 and pilot 1 do not start from neighbouring seeds.
 */
export function subRng(seed: number, label: number): Rng {
  return makeRng((seed ^ Math.imul(label + 1, 0x9e3779b1)) >>> 0)
}

/**
 * A stream that is not reproducible, for callers outside a seeded run.
 *
 * Exists so constructing a bare `Ship` in a test or a harness does not have to
 * invent a seed it does not care about. Anything that needs a run to replay —
 * `createGame` above all — passes a real substream instead.
 */
export function unseededRng(): Rng {
  const rng = (() => Math.random()) as Rng
  rng.range = (min, max) => min + Math.random() * (max - min)
  rng.int = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
  rng.spread = (n) => (Math.random() * 2 - 1) * n
  rng.pick = (items) => items[Math.floor(Math.random() * items.length)]
  return rng
}

/** The seed the shipped arena is built from. */
export const WORLD_SEED = 0x4e30b17

/**
 * Labels for the substreams a run draws from. Values are arbitrary but must
 * stay stable: changing one changes every future replay of an old seed.
 */
export const STREAM = {
  /** Squadron order and arrival points. */
  spawn: 0x5171,
  /** Per-pilot wander, break timing and dash rolls. Offset by pilot index. */
  pilot: 0x9110,
  /**
   * Per-enemy gun spread. Offset by the pilot's arrival index.
   *
   * Kept distinct from `playerGuns` rather than sharing a base and letting the
   * player take index -1 or the enemies start at 1: an off-by-one between two
   * labels is silent, because two streams that collide still each produce
   * perfectly good random numbers. The first version of this had exactly that
   * bug — the player and the first enemy drew the identical sequence — and it
   * was invisible only because the player's spread is always zero, so it never
   * drew at all.
   */
  enemyGuns: 0x6011,
  /**
   * Gun spread for a seat in the roster, offset by seat index.
   *
   * Seat 0 draws from the bare label, which is the stream the single player has
   * always used, so adding seats cannot move an existing one. Thousands of
   * labels clear of `enemyGuns` above, which is the collision that bug describes.
   */
  playerGuns: 0x3d02,
  /**
   * Where a seat comes back. Its own label rather than sharing `spawn`, so a
   * respawn cannot shift the enemy arrival points for the rest of the match — a
   * run in which nobody dies must draw the same squadron as one in which
   * somebody does.
   */
  respawn: 0xb0c4,
} as const
