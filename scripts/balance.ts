/**
 * Headless balance harness.
 *
 * `simcheck.ts` asserts the game *works*. This asserts the game is *fair* — or
 * at least that it is as unfair as the hangar cards say it is. It flies the
 * real flight model, the real guns and the real bolt pipeline, so every number
 * printed here is measured rather than derived from the spec sheet; the spec
 * sheet is then checked against the measurement, which is the only way a stat
 * card stays honest after someone edits a stat.
 *
 *   npm run check:balance
 *
 * Every duel is pinned: both hulls held in place at a fixed range with the
 * attacker's nose already on the target. That deliberately removes flying from
 * the question. These are ceilings — the damage an airframe lands if every
 * bolt connects — and the whole point of the Wasp is that nobody ever gets to
 * shoot it under laboratory conditions. Read the matrix as "who wins the
 * exchange neither pilot can dodge", not as "who wins".
 *
 * Trigger policies:
 *   held       — trigger down and left down. Overheats, eats the lockout.
 *   feathered  — released at 90% heat, back on the trigger at 10%.
 * For the two airframes without a heat quirk these are the same run.
 */

import * as THREE from 'three'
import type { Audio } from '../src/core/audio'
import { createBolts, FACTION_AI, FACTION_PLAYER } from '../src/game/bolts'
import { Ship, type Controls, type ShipContext } from '../src/game/ship'
import {
  SHIPS,
  SHIP_ORDER,
  alphaStrike,
  burstDps,
  sustainedDps,
  type ShipId,
  type ShipSpec,
} from '../src/ships/specs'
import { ARENA_HARD_LIMIT, SEAR_INNER, SUN_DIRECTION, SUN_DISTANCE } from '../src/world/environment'
import { MINE_DAMAGE } from '../src/world/mines'
import {
  OVERDRIVE_DURATION,
  OVERDRIVE_RATE_MULT,
  REPAIR_AMOUNT,
  SHIELD_DURATION,
  TIMED_WARN_AT,
} from '../src/world/pickups'

const STEP = 1 / 60
/** Duel range. Close enough that flight time is noise, far enough to be real. */
const RANGE = 400
/** Long enough for a heat cycle to repeat several times over. */
const WINDOW = 12
/** Trailing frames after the trigger comes up, so bolts already in flight land. */
const DRAIN = 1

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string): void {
  console.log(`\n${name}`)
}

/**
 * Audio is fire-and-forget, so a stub is enough. Deliberately a local copy of
 * the one in `simcheck.ts` rather than a shared import: these two scripts are
 * the last things that should fail together, and the stub is cheaper than the
 * coupling.
 */
function silentAudio(): Audio {
  const stub = {
    muted: true,
    resume() {},
    toggleMute() {
      return true
    },
    setEngine() {},
    setMusic() {},
    laser() {},
    hit() {},
    hullHit() {},
    explosion() {},
    warp() {},
    dash() {},
    pickup() {},
    overheat() {},
    alarm() {},
    uiSelect() {},
    uiLaunch() {},
    fanfare() {},
    dispose() {},
  }
  return stub as unknown as Audio
}

function controls(overrides: Partial<Controls> = {}): Controls {
  return {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
    ...overrides,
  }
}

type Policy = 'held' | 'feathered'

/**
 * Trigger discipline as a state machine. Hysteresis rather than a single
 * threshold, because a pilot who taps at exactly the redline is not a pilot,
 * it is a frame-perfect robot.
 */
function trigger(spec: ShipSpec, policy: Policy): (ship: Ship) => boolean {
  const q = spec.quirk
  if (policy === 'held' || q.kind !== 'heat') return () => true

  let venting = false
  return (ship: Ship): boolean => {
    if (venting) {
      if (ship.heat <= q.max * 0.1) venting = false
    } else if (ship.heat >= q.max * 0.9) {
      venting = true
    }
    return !venting
  }
}

/* -------------------------------------------------------------------------- */
/* Rigs                                                                       */
/* -------------------------------------------------------------------------- */

const HOME = new THREE.Vector3(0, 0, 0)
const DOWNRANGE = new THREE.Vector3(0, 0, -RANGE)

interface Rig {
  attacker: Ship
  target: Ship
  ctx: ShipContext
  step(fire: boolean): void
  dispose(): void
}

/** Two pinned hulls, attacker nose-on at `RANGE`, nobody flying. */
function rig(attackerId: ShipId, targetId: ShipId): Rig {
  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  const attacker = new Ship(SHIPS[attackerId], FACTION_PLAYER)
  attacker.spawn(HOME, DOWNRANGE)
  attacker.warpTimer = 0

  const target = new Ship(SHIPS[targetId], FACTION_AI)
  target.spawn(DOWNRANGE, new THREE.Vector3(0, 0, -4000))
  target.warpTimer = 0

  return {
    attacker,
    target,
    ctx,
    step(fire: boolean): void {
      attacker.position.copy(HOME)
      attacker.velocity.set(0, 0, 0)
      target.position.copy(DOWNRANGE)
      target.velocity.set(0, 0, 0)

      attacker.step(controls({ fire }), STEP, ctx)
      target.step(controls(), STEP, ctx)
      bolts.update(STEP, [attacker, target], [])
    },
    dispose(): void {
      bolts.dispose()
      attacker.dispose()
      target.dispose()
    },
  }
}

/**
 * Damage per second landed on an immortal target. The dummy's hull is topped up
 * every frame and the damage counted on the way in, so a twelve-second sample
 * covers several full heat cycles instead of ending at the first kill.
 */
function measureDps(id: ShipId, policy: Policy, overdrive = false): number {
  const r = rig(id, 'drone')
  const wantsFire = trigger(SHIPS[id], policy)

  let landed = 0
  r.target.onDamaged = (_ship, amount): void => {
    landed += amount
  }

  for (let i = 0; i < WINDOW / STEP; i++) {
    r.target.hull = r.target.spec.maxHull
    // Topped up every frame for the same reason the dummy's hull is: the sample
    // window is longer than a single pod lasts, and what is being measured is
    // the buff's ceiling, not how long it runs. Its duration is a separate
    // lever, checked in the contract below.
    if (overdrive) r.attacker.overdriveTimer = OVERDRIVE_DURATION
    r.step(wantsFire(r.attacker))
  }
  // Bolts fired inside the window still count; they just have not arrived yet.
  for (let i = 0; i < DRAIN / STEP; i++) {
    r.target.hull = r.target.spec.maxHull
    r.step(false)
  }

  r.dispose()
  return landed / WINDOW
}

/** Seconds for a pinned attacker to kill a pinned, unresisting defender. */
function measureTtk(attackerId: ShipId, defenderId: ShipId, overdrive = false): number {
  const r = rig(attackerId, defenderId)
  const wantsFire = trigger(SHIPS[attackerId], 'feathered')

  let frames = 0
  const cap = 60 / STEP
  for (; frames < cap && r.target.alive; frames++) {
    if (overdrive) r.attacker.overdriveTimer = OVERDRIVE_DURATION
    r.step(wantsFire(r.attacker))
  }

  const alive = r.target.alive
  r.dispose()
  return alive ? Infinity : frames * STEP
}

/** Seconds to burn up parked at full solar exposure. */
function measureSearDeath(id: ShipId): number {
  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  // Deepest point of the burn that a pilot can actually reach: the inner edge
  // of the sear ramp, where exposure saturates at 1.
  const deep = SUN_DIRECTION.clone().multiplyScalar(SUN_DISTANCE - SEAR_INNER)
  const ship = new Ship(SHIPS[id], FACTION_PLAYER)
  ship.spawn(deep, HOME)
  ship.warpTimer = 0

  let frames = 0
  const cap = 60 / STEP
  for (; frames < cap && ship.alive; frames++) {
    ship.position.copy(deep)
    ship.velocity.set(0, 0, 0)
    ship.step(controls(), STEP, ctx)
  }

  const alive = ship.alive
  const reachable = deep.length() <= ARENA_HARD_LIMIT
  bolts.dispose()
  ship.dispose()
  return alive || !reachable ? Infinity : frames * STEP
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

function pad(text: string, width: number): string {
  return text.padEnd(width)
}

function padLeft(text: string, width: number): string {
  return text.padStart(width)
}

const measured = new Map<ShipId, { held: number; feathered: number }>()
for (const id of SHIP_ORDER) {
  measured.set(id, { held: measureDps(id, 'held'), feathered: measureDps(id, 'feathered') })
}

function best(id: ShipId): number {
  const m = measured.get(id)!
  return Math.max(m.held, m.feathered)
}

console.log('\nNEON ORBIT — balance harness')
console.log(`  ${WINDOW}s samples, pinned at ${RANGE} units, every bolt on target.`)

section('Guns')
console.log(
  `  ${pad('', 8)}${padLeft('alpha', 7)}${padLeft('burst', 8)}${padLeft('held', 8)}${padLeft('feathered', 11)}${padLeft('on paper', 10)}`,
)
for (const id of SHIP_ORDER) {
  const spec = SHIPS[id]
  const m = measured.get(id)!
  console.log(
    `  ${pad(spec.name, 8)}${padLeft(alphaStrike(spec).toFixed(0), 7)}` +
      `${padLeft(burstDps(spec).toFixed(1), 8)}` +
      `${padLeft(m.held.toFixed(1), 8)}` +
      `${padLeft(m.feathered.toFixed(1), 11)}` +
      `${padLeft(sustainedDps(spec).toFixed(1), 10)}`,
  )
}
console.log('  alpha = one trigger pull, all barrels. burst = trigger down, heat ignored.')

section('Time to kill (seconds, attacker down the side)')
console.log(`  ${pad('', 8)}${SHIP_ORDER.map((id) => padLeft(SHIPS[id].name, 9)).join('')}`)
const ttk = new Map<string, number>()
for (const attacker of SHIP_ORDER) {
  const cells: string[] = []
  for (const defender of SHIP_ORDER) {
    if (attacker === defender) {
      cells.push(padLeft('—', 9))
      continue
    }
    const t = measureTtk(attacker, defender)
    ttk.set(`${attacker}>${defender}`, t)
    cells.push(padLeft(Number.isFinite(t) ? `${t.toFixed(2)}` : '∞', 9))
  }
  console.log(`  ${pad(SHIPS[attacker].name, 8)}${cells.join('')}`)
}

section('Hazards')
console.log(`  ${pad('', 8)}${padLeft('hull', 7)}${padLeft('mine', 8)}${padLeft('sear death', 12)}`)
const searDeath = new Map<ShipId, number>()
for (const id of SHIP_ORDER) {
  const spec = SHIPS[id]
  const t = measureSearDeath(id)
  searDeath.set(id, t)
  const share = ((MINE_DAMAGE / spec.maxHull) * 100).toFixed(0)
  console.log(
    `  ${pad(spec.name, 8)}${padLeft(spec.maxHull.toFixed(0), 7)}${padLeft(`${share}%`, 8)}` +
      `${padLeft(Number.isFinite(t) ? `${t.toFixed(1)}s` : '∞', 12)}`,
  )
}
console.log('  Both hazards are flat, so both are hardest on the thinnest hull. Intentional.')

section('Power-ups')
console.log(
  `  ${pad('', 8)}${padLeft('stock', 8)}${padLeft('overdrive', 11)}${padLeft('gain', 7)}` +
    `${padLeft('alpha', 8)}${padLeft('repair', 9)}`,
)
const overdriven = new Map<ShipId, number>()
for (const id of SHIP_ORDER) {
  const spec = SHIPS[id]
  const boosted = measureDps(id, 'feathered', true)
  overdriven.set(id, boosted)
  const share = ((REPAIR_AMOUNT / spec.maxHull) * 100).toFixed(0)
  console.log(
    `  ${pad(spec.name, 8)}${padLeft(best(id).toFixed(1), 8)}${padLeft(boosted.toFixed(1), 11)}` +
      `${padLeft(`${(boosted / best(id)).toFixed(2)}x`, 7)}` +
      `${padLeft(alphaStrike(spec).toFixed(0), 8)}` +
      `${padLeft(`${share}%`, 9)}`,
  )
}
console.log(
  `  Overdrive: ${OVERDRIVE_RATE_MULT}x rate, bolt damage untouched, ${OVERDRIVE_DURATION}s, ` +
    `stacking, countdown at ${TIMED_WARN_AT}s.`,
)
console.log(
  `  Shield: ${SHIELD_DURATION}s, stacking, countdown at ${TIMED_WARN_AT}s. ` +
    `Repair pod: ${REPAIR_AMOUNT} hull.`,
)
console.log(
  '  alpha is the *unboosted* column and stays that way — Overdrive adds bolts, not bolt damage.',
)
console.log(
  '  The heat airframe gains least, because Overdrive does not discount heat per shot.',
)

section('Time to kill under Overdrive (seconds, attacker down the side)')
console.log(`  ${pad('', 8)}${SHIP_ORDER.map((id) => padLeft(SHIPS[id].name, 9)).join('')}`)
const boostedTtk = new Map<string, number>()
for (const attacker of SHIP_ORDER) {
  const cells: string[] = []
  for (const defender of SHIP_ORDER) {
    if (attacker === defender) {
      cells.push(padLeft('—', 9))
      continue
    }
    const t = measureTtk(attacker, defender, true)
    boostedTtk.set(`${attacker}>${defender}`, t)
    cells.push(padLeft(Number.isFinite(t) ? `${t.toFixed(2)}` : '∞', 9))
  }
  console.log(`  ${pad(SHIPS[attacker].name, 8)}${cells.join('')}`)
}

section('Hangar cards')
for (const id of SHIP_ORDER) {
  const b = SHIPS[id].bars
  const bar = (v: number): string => '#'.repeat(Math.round(v * 10)).padEnd(10, '.')
  console.log(
    `  ${pad(SHIPS[id].name, 8)}spd ${bar(b.speed)}  agi ${bar(b.agility)}  arm ${bar(b.armor)}  gun ${bar(b.firepower)}`,
  )
}

/* -------------------------------------------------------------------------- */
/* The contract                                                               */
/* -------------------------------------------------------------------------- */

section('Balance contract')

/**
 * The design claim behind the heat quirk is that letting go of the trigger is a
 * skill. Before this harness existed it was the opposite: heat outran the vent
 * six to one and the lockout vented faster than feathering did, so mashing was
 * strictly better and the quirk was a flat tax on the airframe that advertises
 * sustained fire. If this check ever fails again, the quirk is lying.
 */
for (const id of SHIP_ORDER) {
  const spec = SHIPS[id]
  if (spec.quirk.kind !== 'heat') continue
  const m = measured.get(id)!
  check(
    `${spec.name}: trigger discipline beats holding it down`,
    m.feathered > m.held * 1.15,
    `feathered ${m.feathered.toFixed(1)} vs held ${m.held.toFixed(1)} DPS`,
  )
}

/**
 * The spec sheet has to agree with the flight model, or the cards are fiction.
 * 10% of slack because `sustainedDps` solves a continuous equilibrium while a
 * pilot works a hysteresis band — overshooting the redline by a shot and
 * re-triggering onto a gun that is already ready both pay out a little more
 * than the model promises. It should always err in that direction; a measured
 * figure *under* the paper one means the quirk is costing more than advertised.
 */
for (const id of SHIP_ORDER) {
  const spec = SHIPS[id]
  const m = measured.get(id)!
  const paper = sustainedDps(spec)
  const drift = (m.feathered - paper) / paper
  check(
    `${spec.name}: measured DPS matches the spec sheet`,
    drift > -0.02 && drift < 0.1,
    `measured ${m.feathered.toFixed(1)} vs paper ${paper.toFixed(1)} (${(drift * 100).toFixed(1)}% off)`,
  )
}

/**
 * A fleet standard that also owns the best gun is not a choice, it is a default.
 * 1.6x top to bottom leaves room for a real firepower ranking without one
 * airframe deleting the other two; the Hornet sat at 2.3x over the Drone and
 * 5.2x over the Wasp before this.
 */
const gunSpread = Math.max(...SHIP_ORDER.map(best)) / Math.min(...SHIP_ORDER.map(best))
check(
  'no airframe runs away with the firepower ranking',
  gunSpread < 1.6,
  `best-to-worst DPS spread is ${gunSpread.toFixed(2)}x`,
)

/**
 * Bars are derived, so this only fails if someone hand-writes them back in.
 * Pairs inside 5% of each other are exempt: the Wasp and the Drone currently
 * land within a percent, and which one sorts first is noise rather than a
 * claim. A card only has to be right about differences a pilot could feel.
 */
for (const a of SHIP_ORDER) {
  for (const b of SHIP_ORDER) {
    if (a >= b) continue
    const gap = Math.abs(best(a) - best(b)) / Math.min(best(a), best(b))
    if (gap < 0.05) continue
    const cardSaysAWins = SHIPS[a].bars.firepower > SHIPS[b].bars.firepower
    const gunsSayAWins = best(a) > best(b)
    check(
      `the firepower bar ranks ${SHIPS[a].name} against ${SHIPS[b].name} the way the guns do`,
      cardSaysAWins === gunsSayAWins,
      `cards ${SHIPS[a].bars.firepower.toFixed(2)} vs ${SHIPS[b].bars.firepower.toFixed(2)}, ` +
        `guns ${best(a).toFixed(1)} vs ${best(b).toFixed(1)} DPS`,
    )
  }
}

/**
 * Sub-second deaths read as a bug rather than a defeat: no hit flash, no chance
 * to break away, nothing to learn. Even pinned in the open with a Drone's
 * cannons already lined up, the thinnest hull in the fleet should get a moment.
 */
for (const [matchup, t] of ttk) {
  const [attacker, defender] = matchup.split('>')
  check(
    `${SHIPS[attacker as ShipId].name} needs a real burst to kill a ${SHIPS[defender as ShipId].name}`,
    t > 0.6,
    `${t.toFixed(2)}s`,
  )
}

/** A hazard that one-shots an airframe stops being a hazard and becomes a wall. */
for (const id of SHIP_ORDER) {
  const spec = SHIPS[id]
  check(
    `a single mine does not end a ${spec.name}`,
    MINE_DAMAGE < spec.maxHull * 0.75,
    `${MINE_DAMAGE} damage into ${spec.maxHull} hull`,
  )
}

/** Long enough to read the alarm and turn out, short enough to still be a star. */
for (const id of SHIP_ORDER) {
  const t = searDeath.get(id)!
  check(
    `the star kills a parked ${SHIPS[id].name} in a readable window`,
    t > 1.5 && t < 12,
    `${Number.isFinite(t) ? `${t.toFixed(1)}s` : 'never'}`,
  )
}

/**
 * A power-up you would not break off a fight to collect is set dressing. The
 * pods sit hundreds of units off any line you were already flying, so the buff
 * has to be worth the detour and the exposure of flying straight to get there.
 * The ceiling is 2x by construction, so this is really asking whether any
 * airframe's quirk eats so much of the buff that it stops being worth having.
 */
for (const id of SHIP_ORDER) {
  const gain = overdriven.get(id)! / best(id)
  check(
    `Overdrive is worth the detour on a ${SHIPS[id].name}`,
    gain > 1.5,
    `${gain.toFixed(2)}x sustained DPS`,
  )
}

/** And it must never exceed the rate multiplier, or bolt damage crept back in. */
for (const id of SHIP_ORDER) {
  const gain = overdriven.get(id)! / best(id)
  check(
    `Overdrive does not exceed ${OVERDRIVE_RATE_MULT}x on a ${SHIPS[id].name}`,
    gain <= OVERDRIVE_RATE_MULT * 1.05,
    `${gain.toFixed(2)}x sustained DPS`,
  )
}

/**
 * The reason Overdrive adds bolts rather than bolt damage.
 *
 * Alpha strike is what decides whether a single volley can delete a hull, and
 * an earlier version that doubled damage per bolt pushed a Drone's volley to 80
 * against a 70-hull Wasp — gone between frames, no hit flash, nothing to read.
 * Leaving `spec.damage` alone means every one-volley threshold in the game is
 * exactly where the stock matrix pinned it, boosted or not.
 */
for (const id of SHIP_ORDER) {
  const worst = Math.min(...SHIP_ORDER.filter((d) => d !== id).map((d) => SHIPS[d].maxHull))
  check(
    `an overdriven ${SHIPS[id].name} volley cannot one-shot any hull`,
    alphaStrike(SHIPS[id]) < worst,
    `alpha ${alphaStrike(SHIPS[id])} into ${worst} hull`,
  )
}

/**
 * Boosted kills roughly halve the stock time-to-kill, which is the point. The
 * floor is looser than the stock 0.6s because a power-up is allowed to feel
 * unfair — but a death still has to be *visible*: a hit flash and an explosion
 * the player can connect to their own trigger pull.
 */
for (const [matchup, t] of boostedTtk) {
  const [attacker, defender] = matchup.split('>')
  check(
    `an overdriven ${SHIPS[attacker as ShipId].name} kill on a ${SHIPS[defender as ShipId].name} is still readable`,
    t > 0.4,
    `${t.toFixed(2)}s`,
  )
}

/**
 * The repair pod is the mine's mirror and has to stay the smaller number. If a
 * pod fully paid back a mine the minefield would stop being terrain you route
 * around and become a toll — fly through anything, top up on the way out.
 */
check(
  'a repair pod does not fully undo a mine',
  REPAIR_AMOUNT < MINE_DAMAGE,
  `${REPAIR_AMOUNT} hull back against ${MINE_DAMAGE} taken`,
)

/**
 * Flat healing is worth least to the biggest hull, which is intended — it is
 * the same argument as flat mine damage, pointed the other way. But it still
 * has to be worth turning for on a Drone, or the pods are a Wasp-only feature.
 */
for (const id of SHIP_ORDER) {
  const share = REPAIR_AMOUNT / SHIPS[id].maxHull
  check(
    `a repair pod is worth collecting on a ${SHIPS[id].name}`,
    share > 0.15,
    `${(share * 100).toFixed(0)}% of the hull`,
  )
}

/** A buff with no clock is a stat change. */
for (const [name, duration] of [
  ['Overdrive', OVERDRIVE_DURATION],
  ['Shield', SHIELD_DURATION],
] as const) {
  check(
    `${name} runs out, and warns before it does`,
    duration > 0 && TIMED_WARN_AT > 0 && TIMED_WARN_AT < duration,
    `${duration}s with a countdown from ${TIMED_WARN_AT}s`,
  )
}

/**
 * A Shield refuses damage outright, so its only limit is the clock. It has to
 * be short against the thing it is protecting you from: long enough to cross
 * the star's burn zone or a knot of hostiles, short enough that it cannot carry
 * you through a whole run. Measured against the *toughest* survival window in
 * the game, the Drone's seven seconds parked at full solar exposure.
 */
const longestBurn = Math.max(...SHIP_ORDER.map((id) => searDeath.get(id)!).filter(Number.isFinite))
check(
  'a Shield cannot outlast the worst the arena can do',
  SHIELD_DURATION < longestBurn * 2,
  `${SHIELD_DURATION}s shield against a ${longestBurn.toFixed(1)}s burn`,
)

console.log(
  failures === 0
    ? '\nBalance contract holds.\n'
    : `\n${failures} balance check${failures === 1 ? '' : 's'} failed.\n`,
)
process.exit(failures === 0 ? 0 : 1)
