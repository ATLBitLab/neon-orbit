/**
 * Headless simulation checks.
 *
 * The flight model, projectiles and AI are pure maths over three.js vector
 * types — none of it needs a canvas — so the combat contract can be asserted
 * without a browser. This exists because in-browser verification turned out to
 * be unreliable: a throttled tab stops firing `requestAnimationFrame`, which
 * silently freezes the game loop and makes every behavioural observation
 * meaningless. These checks are deterministic and run in about a second.
 *
 *   npm run check:sim
 */

import * as THREE from 'three'
import type { Audio } from '../src/core/audio'
import type { Input, InputState } from '../src/core/input'
import type { RunResult } from '../src/core/scores'
import { createBolts, FACTION_AI, FACTION_PLAYER, humanFaction } from '../src/game/bolts'
import { createStepClock } from '../src/core/loop'
import { createPilot, type Pilot } from '../src/game/controls'
import { admitIntent, bound, rampThrottle, THROTTLE_DOWN_RATE, THROTTLE_UP_RATE } from '../src/game/intent'
import {
  decodeSnapshot,
  encodeSnapshot,
  SNAPSHOT_VERSION,
  type ShipState,
  type WorldSnapshot,
} from '../src/net/snapshot'
import { decodeIntent, encodeIntent, INTENT_FRAME_BYTES, INTENT_VERSION } from '../src/net/wire'
import { createLoopback } from '../src/net/channel'
import { modeFromLocation } from '../src/net/browser'
import { createClient, createHost, decodeWelcome, encodeWelcome, FRAME } from '../src/net/session'
import { createGame, DEATH_SEQUENCE, type Game, type GameDeps, type RunSnapshot } from '../src/game/game'
import { barBrightness, DAMAGE_BAR_FADE, DAMAGE_BAR_HOLD, type Hud } from '../src/game/hud'
import { createSeats, isParticipant, seatOf } from '../src/game/roster'
import { createDevHook, installDevHook, type DevHook } from '../src/core/dev-hook'
import { createScreens, type PauseHost, type Screen } from '../src/ui/screens'
import { Ship, type Controls, type ShipContext } from '../src/game/ship'
import { SHIPS, SHIP_ORDER, type ShipId } from '../src/ships/specs'
import {
  ARENA_HARD_LIMIT,
  ARENA_RADIUS,
  SEAR_OUTER,
  SUN_DIRECTION,
  SUN_POSITION,
  SUN_RADIUS,
  solarExposure,
  type Environment,
  type Hazard,
} from '../src/world/environment'
import { buildMinefield, MINE_DAMAGE, type Mine, type Minefield } from '../src/world/mines'
import {
  buildPickups,
  OVERDRIVE_DURATION,
  OVERDRIVE_RATE_MULT,
  PICKUP_KINDS,
  PICKUP_RADIUS,
  REPAIR_AMOUNT,
  SHIELD_DURATION,
  TIMED_WARN_AT,
} from '../src/world/pickups'

const STEP = 1 / 60

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

/** Audio is fire-and-forget, so a counting stub is enough. */
function silentAudio(): Audio & { laserCount: number } {
  const stub = {
    laserCount: 0,
    muted: true,
    resume() {},
    toggleMute() {
      return true
    },
    setMusic() {},
    laser() {
      stub.laserCount++
    },
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
  return stub as unknown as Audio & { laserCount: number }
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

/** Run enough frames to clear the warp-in window. */
function settle(ships: Ship[], ctx: ShipContext, seconds = 1): void {
  const frames = Math.ceil(seconds / STEP)
  for (let i = 0; i < frames; i++) {
    for (const ship of ships) ship.step(controls(), STEP, ctx)
  }
}

/* -------------------------------------------------------------------------- */

function testPlayerBoltsKillEnemies(): void {
  section('Player fire damages and destroys an enemy')

  const audio = silentAudio()
  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio, bolts, localFaction: FACTION_PLAYER }

  const player = new Ship(SHIPS.hornet, FACTION_PLAYER)
  player.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))

  const enemy = new Ship(SHIPS.wasp, FACTION_AI)
  enemy.spawn(new THREE.Vector3(0, 0, -400), new THREE.Vector3(0, 0, -2000))

  settle([player, enemy], ctx)
  check('warp-in window clears', player.targetable && enemy.targetable)

  // Pin both ships: the point of this test is the bolt pipeline, not flight.
  const holdPlayer = new THREE.Vector3(0, 0, 0)
  const holdEnemy = new THREE.Vector3(0, 0, -400)
  const startHull = enemy.hull

  let firstDamageFrame = -1
  let deathFrame = -1
  enemy.onDeath = () => {
    deathFrame = frame
  }

  let frame = 0
  for (; frame < 600 && deathFrame < 0; frame++) {
    player.position.copy(holdPlayer)
    player.velocity.set(0, 0, 0)
    enemy.position.copy(holdEnemy)
    enemy.velocity.set(0, 0, 0)

    player.step(controls({ fire: true }), STEP, ctx)
    enemy.step(controls(), STEP, ctx)
    bolts.update(STEP, [player, enemy], [])

    if (firstDamageFrame < 0 && enemy.hull < startHull) firstDamageFrame = frame
  }

  check('player actually fired', player.shotsFired > 0, `shotsFired=${player.shotsFired}`)
  check('laser audio triggered per volley', audio.laserCount === player.shotsFired)
  check('enemy took damage', firstDamageFrame >= 0, `hull=${enemy.hull}/${startHull}`)
  check('enemy was destroyed', deathFrame > 0, `frames=${frame}, hull=${enemy.hull}`)
  check('enemy marked dead', !enemy.alive)

  // Hornet: 12 damage x 2 barrels per 0.22s vs a 70-hull Wasp => 3 volleys.
  const volleys = Math.ceil(SHIPS.wasp.maxHull / (SHIPS.hornet.damage * 2))
  const expected = volleys * SHIPS.hornet.fireInterval
  check(
    `kill time is in the expected band (~${expected.toFixed(2)}s)`,
    deathFrame * STEP < expected + 0.5,
    `took ${(deathFrame * STEP).toFixed(2)}s`,
  )

  bolts.dispose()
  player.dispose()
  enemy.dispose()
}

/**
 * The shape of the fade.
 *
 * `barBrightness` is where the feature actually lives, and it is the only part
 * of the bar that is neither `Ship` nor DOM — plain arithmetic on a number.
 * These assertions exist because the ones in
 * `testDamageClockDrivesEnemyBars` do not cover it: every one of those reads
 * `enemy.sinceHit`, so an inverted curve — dark on the hit, brightening as it
 * goes stale, never hiding, the opposite of the request in every clause —
 * passed the entire suite. That mutant fails six of the checks below.
 */
function testHullBarFadeCurve(): void {
  section('The hull bar fade curve')

  const hold = DAMAGE_BAR_FADE * DAMAGE_BAR_HOLD

  check('a fresh hit draws at full brightness', barBrightness(0) === 1, `${barBrightness(0)}`)

  /* The hold, pinned from both ends.
   *
   * Load-bearing, and worth knowing why before tidying it: these two are the
   * only things in the repo that know `DAMAGE_BAR_HOLD` does anything at all.
   * Delete the hold and ship a plain linear fade and it is caught here or
   * nowhere — review found exactly that mutant, and at the time a single
   * endpoint probe was all that stood against it. So the plateau is sampled
   * across its whole length rather than poked at its end, and a second check
   * confirms it actually ends. An endpoint-only probe is one edit away from
   * looking redundant to someone who does not know what it is for. */
  const plateau: string[] = []
  let flat = true
  for (let i = 0; i <= 10; i++) {
    const b = barBrightness((hold * i) / 10)
    plateau.push(b.toFixed(2))
    if (b !== 1) flat = false
  }
  check(`full brightness holds flat for the first ${hold.toFixed(2)}s`, flat, plateau.join(' '))

  const justAfter = hold + (DAMAGE_BAR_FADE - hold) / 20
  check(
    'and the hold ends — the bar is already dimming just past it',
    barBrightness(justAfter) < 1,
    `${justAfter.toFixed(2)}s → ${barBrightness(justAfter).toFixed(3)}`,
  )

  /* Strictly falling from the end of the hold to the end of the window. A curve
     that plateaus anywhere in here, or climbs, is not a fade. */
  const samples: number[] = []
  let falling = true
  let prev = barBrightness(hold)
  for (let i = 1; i <= 20; i++) {
    const t = hold + ((DAMAGE_BAR_FADE - hold) * i) / 20
    const now = barBrightness(t)
    samples.push(now)
    if (now >= prev) falling = false
    prev = now
  }
  check(
    'brightness only ever falls across the rest of the window',
    falling,
    samples.map((s) => s.toFixed(2)).join(' '),
  )

  check(
    `the bar is out at ${DAMAGE_BAR_FADE}s`,
    barBrightness(DAMAGE_BAR_FADE) === 0,
    `${barBrightness(DAMAGE_BAR_FADE)}`,
  )
  check(
    'and stays out past the window',
    barBrightness(DAMAGE_BAR_FADE + 0.001) === 0 && barBrightness(60) === 0,
  )
  // `Ship.sinceHit` initialises and respawns to 99, so this is literally what a
  // hostile nobody has shot at yet draws.
  check('a hostile nobody has hit draws nothing', barBrightness(99) === 0)

  /* Both phases have to last long enough to be the thing they are named after,
   * and that is a claim about seconds, not about the fraction.
   *
   * The check these replace asserted `0 < HOLD < 1` under the name "the hold
   * leaves real fading time behind it" — which is a guarantee its condition
   * never made. At HOLD 0.99 the bar sits at full for 4.95s and then vanishes
   * in 0.05s: not a fade, and a fade is what was asked for. All green. Assert
   * the durations and the bound falls out for free, since a HOLD outside 0..1
   * or a negative FADE drives one of these below zero.
   *
   * The floors are "enough frames to read as a ramp rather than a blink" at
   * 60fps — 60 frames of fade, 30 of hold. They are deliberately far below the
   * shipped 3.25s and 1.75s: this is a guard against a nonsense tuning value,
   * not a second opinion on the tuning. */
  const MIN_FADE_SECONDS = 1
  const MIN_HOLD_SECONDS = 0.5
  const fadeSeconds = (1 - DAMAGE_BAR_HOLD) * DAMAGE_BAR_FADE
  const holdSeconds = DAMAGE_BAR_HOLD * DAMAGE_BAR_FADE
  check(
    `the fade lasts long enough to read as a fade (>= ${MIN_FADE_SECONDS}s)`,
    fadeSeconds >= MIN_FADE_SECONDS,
    `${fadeSeconds.toFixed(2)}s of fading in a ${DAMAGE_BAR_FADE}s window`,
  )
  check(
    `the hold lasts long enough to read as a flash (>= ${MIN_HOLD_SECONDS}s)`,
    holdSeconds >= MIN_HOLD_SECONDS,
    `${holdSeconds.toFixed(2)}s at full in a ${DAMAGE_BAR_FADE}s window`,
  )
}

/**
 * The clock the fade is drawn against.
 *
 * Strictly a set of claims about `Ship.sinceHit` — the field `refreshContacts`
 * hands the HUD — and named that way. What the bar *does* with the number is
 * `testHullBarFadeCurve` above; these checks would all still pass if the fade
 * were drawn upside down.
 */
function testDamageClockDrivesEnemyBars(): void {
  section('The damage clock the hull bars are drawn against')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  const player = new Ship(SHIPS.hornet, FACTION_PLAYER)
  player.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))

  // A Hornet on the receiving end: six volleys of hull, so it survives every
  // hit this check lands, and a dash quirk rather than the Drone's repair, so
  // nothing quietly refills the hull between assertions.
  const enemy = new Ship(SHIPS.hornet, FACTION_AI)
  enemy.spawn(new THREE.Vector3(0, 0, -400), new THREE.Vector3(0, 0, -2000))

  settle([player, enemy], ctx)

  const hold = new THREE.Vector3(0, 0, -400)

  /**
   * Pin both hulls and hold the trigger for up to `seconds`, stopping on the
   * frame the enemy loses hull. Returns whether a hit landed — so it is both
   * "shoot until something connects" and "shoot and confirm nothing did".
   */
  function fireUntilHit(seconds: number): boolean {
    const frames = Math.ceil(seconds / STEP)
    for (let i = 0; i < frames; i++) {
      player.position.set(0, 0, 0)
      player.velocity.set(0, 0, 0)
      enemy.position.copy(hold)
      enemy.velocity.set(0, 0, 0)

      const before = enemy.hull
      player.step(controls({ fire: true }), STEP, ctx)
      enemy.step(controls(), STEP, ctx)
      bolts.update(STEP, [player, enemy], [])
      if (enemy.hull < before) return true
    }
    return false
  }

  function coast(seconds: number): void {
    const frames = Math.ceil(seconds / STEP)
    for (let i = 0; i < frames; i++) enemy.step(controls(), STEP, ctx)
  }

  check(
    'an untouched hull starts its clock past the bar window',
    enemy.sinceHit > DAMAGE_BAR_FADE,
    `sinceHit=${enemy.sinceHit.toFixed(2)}s`,
  )

  check('the first burst connects', fireUntilHit(10), `hull=${enemy.hull}/${SHIPS.hornet.maxHull}`)
  check('a hit zeroes the clock', enemy.sinceHit === 0, `sinceHit=${enemy.sinceHit}`)

  coast(DAMAGE_BAR_FADE / 2)
  check(
    'the clock is still inside the window halfway through',
    enemy.sinceHit < DAMAGE_BAR_FADE,
    `sinceHit=${enemy.sinceHit.toFixed(2)}s of ${DAMAGE_BAR_FADE}s`,
  )

  coast(DAMAGE_BAR_FADE / 2 + 0.05)
  check(
    'the clock leaves the window on schedule',
    enemy.sinceHit >= DAMAGE_BAR_FADE,
    `sinceHit=${enemy.sinceHit.toFixed(2)}s of ${DAMAGE_BAR_FADE}s`,
  )

  /* A hit that never reached the hull must not light a bar. `takeDamage`
     already refuses to touch the clock behind a shield for the Drone's sake;
     this is the same refusal seen from the HUD's side. */
  const shieldedFrom = enemy.hull
  enemy.shieldTimer = 3
  const shieldedHit = fireUntilHit(1.5)
  enemy.shieldTimer = 0
  check('a shielded hostile takes no hull damage', !shieldedHit && enemy.hull === shieldedFrom)
  check(
    'a refused hit leaves the clock running',
    enemy.sinceHit >= DAMAGE_BAR_FADE,
    `sinceHit=${enemy.sinceHit.toFixed(2)}s`,
  )

  check('a second burst connects', fireUntilHit(10), `hull=${enemy.hull}/${SHIPS.hornet.maxHull}`)
  check('every fresh hit re-zeroes the clock', enemy.sinceHit === 0, `sinceHit=${enemy.sinceHit}`)

  /* The Drone rebuilds its own hull once its repair clock runs out, and that
     clock is this clock. If the window ever grew past the delay, a Drone's bar
     would sit on screen draining while the hull behind it was already filling
     back up — the one state where the bar would be actively lying. */
  const repair = SHIPS.drone.quirk
  check(
    'the window closes before nanite repair starts refilling behind it',
    repair.kind === 'regen' && repair.delay > DAMAGE_BAR_FADE,
    `repair at ${repair.kind === 'regen' ? `${repair.delay}s` : 'n/a'}, bar gone at ${DAMAGE_BAR_FADE}s`,
  )

  bolts.dispose()
  player.dispose()
  enemy.dispose()
}

function testFriendlyFireIsOff(): void {
  section('Bolts never damage their own team')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  const shooter = new Ship(SHIPS.drone, FACTION_AI)
  shooter.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))

  const ally = new Ship(SHIPS.wasp, FACTION_AI)
  ally.spawn(new THREE.Vector3(0, 0, -300), new THREE.Vector3(0, 0, -2000))

  const victim = new Ship(SHIPS.hornet, FACTION_PLAYER)
  victim.spawn(new THREE.Vector3(0, 0, -600), new THREE.Vector3(0, 0, -2000))

  settle([shooter, ally, victim], ctx)

  const allyHull = ally.hull
  const victimHull = victim.hull

  for (let i = 0; i < 300; i++) {
    shooter.position.set(0, 0, 0)
    shooter.velocity.set(0, 0, 0)
    ally.position.set(0, 0, -300)
    ally.velocity.set(0, 0, 0)
    victim.position.set(0, 0, -600)
    victim.velocity.set(0, 0, 0)

    shooter.step(controls({ fire: true }), STEP, ctx)
    bolts.update(STEP, [shooter, ally, victim], [])
    if (!ally.alive || !victim.alive) break
  }

  check('ally in the line of fire is unharmed', ally.hull === allyHull, `hull=${ally.hull}/${allyHull}`)
  check('shooter did not hit itself', shooter.hull === shooter.spec.maxHull)
  check('opposing ship behind the ally still took hits', victim.hull < victimHull, `hull=${victim.hull}`)

  bolts.dispose()
  shooter.dispose()
  ally.dispose()
  victim.dispose()
}


/**
 * Factions are open, not a two-sided split wearing a new name.
 *
 * The rename from `Team` would be ceremonial if the set still only worked at
 * two, so this stands up a *third* faction — which is what PvP is: one per
 * human — and checks the friendly-fire rule holds pairwise rather than
 * "us and them".
 *
 * Nothing in the shipped game creates a third faction yet. That is the point:
 * this asserts the capability the type now claims, at the moment it is claimed,
 * rather than waiting for the roster milestone to discover it was never true.
 */
/**
 * Minting a faction is guarded, because it is the one hole the brand leaves.
 *
 * `Faction` is branded so a bare number cannot become one by accident, which
 * makes `humanFaction` the single sanctioned cast — and therefore the single
 * place a bad value gets in. It took anything: `humanFaction(-1)` returned
 * `FACTION_AI`, and -1 is what `indexOf` returns on a miss.
 *
 * The failure it produces is the quiet kind. That human shares a faction with
 * every NPC, so friendly fire stops them shooting the AI filler and stops the
 * filler shooting back — invulnerable to and invisible to the opposition it
 * exists to provide, reading as an AI bug rather than a roster bug.
 */
function testMintingAFactionIsGuarded(): void {
  section('A faction can only be minted from a real roster index')

  function throws(label: string, index: number): void {
    let threw = false
    try {
      humanFaction(index)
    } catch {
      threw = true
    }
    check(`minting from ${label} is refused`, threw)
  }

  throws('an indexOf miss (-1)', -1)
  throws('a negative index', -7)
  throws('a fractional index', 1.5)
  throws('NaN', NaN)
  throws('Infinity', Infinity)

  /*
   * The positives, so the guard is not simply rejecting everything — which
   * would satisfy all five negatives above while breaking every caller.
   *
   * Every one goes through `mints`, and the try/catch is what makes them
   * *falsifiable* rather than merely present. A bare `humanFaction(0)` here
   * would throw under a broken guard and take the whole process down before
   * reaching its own assertion: the mutant is still caught, but by the crash,
   * and the report says "39 of 201 ran" instead of naming the check. Wrapped,
   * the same mutation reports `FAIL minting from 0 works` and the suite
   * finishes. Verified both ways — rejecting only index 3 gives
   * `exit=1 ok=200 FAIL=1`, naming the assertion.
   */
  function mints(index: number): { ok: boolean; value: number } {
    try {
      return { ok: true, value: humanFaction(index) as unknown as number }
    } catch {
      return { ok: false, value: Number.NaN }
    }
  }

  /*
   * The identity, across a range, and asserting the *value* rather than merely
   * that nothing threw.
   *
   * `humanFaction(i) === i` is what makes a roster index and a faction
   * interchangeable, and it is the whole reason the roster can hand out
   * factions by position. Checking only `ok` lets a mint return the *wrong*
   * faction silently: `Math.min(index, 2)` collides participants 3, 4 and 5
   * into one faction — friendly fire then stops them shooting each other, so
   * late joiners form a mutually invulnerable bloc — and `index === 5 ? -1 : i`
   * puts participant 5 on the AI side, which is the original bug one index
   * over. Both passed at 201 ok, exit 0, before this loop existed.
   *
   * The previous version asserted the identity at i=0 only while its name
   * quantified over every valid index. That is the first failure this codebase
   * ever recorded — a check promising more than it asserts — reappearing in the
   * assertion labelled as the important one.
   */
  /*
   * A contiguous range, not a hand-picked sample.
   *
   * The first version tested [0, 1, 2, 3, 7] — and a mutation that broke
   * exactly index 5 passed, because 5 was not in the list. The property is
   * universal over the roster, so sampling it leaves gaps by construction, and
   * the gap is wherever the next mistake happens to land. Nine indices cost
   * nothing; picking five costs the one that was skipped.
   */
  for (let i = 0; i <= 8; i++) {
    const m = mints(i)
    check(`minting index ${i} succeeds`, m.ok, `threw`)
    check(`minting index ${i} yields exactly ${i}`, m.ok && m.value === i, `got ${m.value}`)
    check(
      `index ${i} cannot reach the AI faction`,
      m.ok && m.value !== (FACTION_AI as unknown as number),
      `got ${m.value}`,
    )
  }

  // Distinctness, which the identity implies but which is the property the
  // roster actually depends on: no two participants share a faction.
  const minted = Array.from({ length: 9 }, (_, i) => mints(i).value)
  check('every index mints a distinct faction', new Set(minted).size === minted.length, minted.join(','))
}

function testFactionsAreOpenNotTwoSided(): void {
  section('Friendly fire is per-faction, and there can be more than two')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  // Two humans and an NPC: the phase-B arena in miniature.
  const SECOND_HUMAN = humanFaction(1)
  const alice = new Ship(SHIPS.drone, FACTION_PLAYER)
  const bob = new Ship(SHIPS.hornet, SECOND_HUMAN)
  const npc = new Ship(SHIPS.wasp, FACTION_AI)
  const line = [alice, bob, npc]
  for (const s of line) s.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  settle(line, ctx)

  const aliceHull = alice.hull

  /*
   * One volley per pair, stopping at the first confirmed hit.
   *
   * Not one line-up, because bolts are consumed on impact: the friendly-fire
   * test can put a victim behind a bystander only because that bystander is an
   * *ally* and bolts pass through it. With mutually hostile factions the
   * nearest ship always blocks, so a single volley cannot reach past it.
   *
   * And stopping at first damage rather than at death, so every ship survives
   * for the pairs tested after it. Three hundred rounds of a Drone kills a
   * Hornet, and a dead shooter fires nothing — which silently emptied the
   * volley that matters most here.
   */
  function volley(shooter: Ship, target: Ship, place: () => void): boolean {
    const before = target.hull
    for (let i = 0; i < 400; i++) {
      place()
      shooter.step(controls({ fire: true }), STEP, ctx)
      bolts.update(STEP, line, [])
      if (target.hull < before) return true
    }
    return false
  }

  const apart = (s: Ship, y: number) => {
    s.position.set(0, y, 0)
    s.velocity.set(0, 0, 0)
  }

  const humanHitHuman = volley(alice, bob, () => {
    apart(alice, 0)
    alice.position.set(0, 0, 0)
    bob.position.set(0, 0, -300)
    bob.velocity.set(0, 0, 0)
    apart(npc, 4000)
  })
  const humanHitNpc = volley(alice, npc, () => {
    alice.position.set(0, 0, 0)
    alice.velocity.set(0, 0, 0)
    npc.position.set(0, 0, -300)
    npc.velocity.set(0, 0, 0)
    apart(bob, 4000)
  })

  /*
   * The discriminating pair: Bob on the NPC, neither of them the player.
   *
   * Every other assertion here passes just as well under a two-sided
   * "us and them" rule, because Alice is the only human and both her targets
   * are simply not-the-player. Only a shot between two factions that are *both*
   * non-player separates "same faction" from "same side". Verified by mutation:
   * restoring a two-sided rule leaves every check but this one green.
   */
  const npcHitByOtherNonPlayer = volley(bob, npc, () => {
    bob.position.set(0, 0, 0)
    bob.velocity.set(0, 0, 0)
    npc.position.set(0, 0, -300)
    npc.velocity.set(0, 0, 0)
    apart(alice, 4000)
  })

  check('a human damages another human', humanHitHuman)
  check('the same human damages an NPC', humanHitNpc)
  check('two non-player factions can shoot each other', npcHitByOtherNonPlayer,
    'a two-sided rule would leave this one untouched')
  check('nobody shot themselves', alice.hull === aliceHull, `alice hull=${alice.hull}/${aliceHull}`)
  // Guards all four: a shooter that never fired satisfies "unharmed" trivially.
  check('every volley actually fired', alice.shotsFired > 0 && bob.shotsFired > 0,
    `alice=${alice.shotsFired} bob=${bob.shotsFired}`)

  bolts.dispose()
  for (const s of line) s.dispose()
}

function testBoundaryTurnsShipsAround(): void {
  section('Patrol boundary beats full thrust')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  /**
   * Worst case: the fastest, grippiest hull, nose pointed *straight* out at full
   * throttle. This is the case that used to park itself at the hard limit.
   * Radial-only motion means low total speed near the turnaround is expected
   * and fine — what matters is that it is held near the line and comes back in,
   * not that it is fast while doing so.
   */
  const radial = new Ship(SHIPS.wasp, FACTION_PLAYER)
  radial.spawn(new THREE.Vector3(0, 0, ARENA_RADIUS + 50), new THREE.Vector3(0, 0, ARENA_RADIUS + 5000))
  radial.warpTimer = 0

  let maxDistance = 0
  for (let i = 0; i < 60 * 12; i++) {
    radial.step(controls({ throttle: 1 }), STEP, ctx)
    maxDistance = Math.max(maxDistance, radial.position.length())
  }

  check('never escapes the hard limit', maxDistance <= ARENA_HARD_LIMIT + 1, `max=${maxDistance.toFixed(0)}`)
  // Held in a tight band at the line, not parked far out in the buffer. The
  // boundary deliberately does not drag a pilot back against their own full
  // throttle — it just refuses to let them make outward progress, and the HUD
  // banner says so. The old bug was hanging motionless 900 units out.
  check(
    'is held at the line rather than deep in the buffer',
    maxDistance <= ARENA_RADIUS + 200,
    `max=${maxDistance.toFixed(0)}, line=${ARENA_RADIUS}`,
  )

  // Stop pushing and the tether should walk it home on its own.
  for (let i = 0; i < 60 * 8; i++) radial.step(controls({ throttle: 0 }), STEP, ctx)
  check(
    'drifts back inside once the pilot stops pushing',
    radial.position.length() < ARENA_RADIUS,
    `dist=${radial.position.length().toFixed(0)}`,
  )

  /**
   * Realistic case: crossing the line at an angle. Here the veto only removes
   * the radial component, so the ship should keep skimming the boundary at real
   * speed rather than grinding to a halt.
   */
  const oblique = new Ship(SHIPS.wasp, FACTION_PLAYER)
  oblique.spawn(
    new THREE.Vector3(0, 0, ARENA_RADIUS + 20),
    new THREE.Vector3(3000, 0, ARENA_RADIUS + 1200),
  )
  oblique.warpTimer = 0

  let slowest = Infinity
  for (let i = 0; i < 60 * 10; i++) {
    oblique.step(controls({ throttle: 1 }), STEP, ctx)
    if (i > 60) slowest = Math.min(slowest, oblique.velocity.length())
  }

  check(
    'a glancing ship keeps flying instead of stalling',
    slowest > 120,
    `slowest=${slowest.toFixed(0)} u/s`,
  )
  check(
    'a glancing ship stays in the arena',
    oblique.position.length() <= ARENA_HARD_LIMIT + 1,
    `dist=${oblique.position.length().toFixed(0)}`,
  )

  bolts.dispose()
  radial.dispose()
  oblique.dispose()
}

function testQuirks(): void {
  section('Hull quirks behave as specified')

  const bolts = createBolts()
  const audio = silentAudio()
  const ctx: ShipContext = { hazards: [], audio, bolts, localFaction: FACTION_PLAYER }

  /* Wasp: sustained fire must lock the guns out. */
  const wasp = new Ship(SHIPS.wasp, FACTION_PLAYER)
  wasp.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  wasp.warpTimer = 0

  let lockedOut = false
  for (let i = 0; i < 60 * 3; i++) {
    wasp.step(controls({ fire: true }), STEP, ctx)
    if (wasp.heatLocked > 0) lockedOut = true
  }
  check('Wasp overheats under sustained fire', lockedOut, `heat=${wasp.heat.toFixed(1)}`)

  const shotsAtLockout = wasp.shotsFired
  for (let i = 0; i < 30; i++) wasp.step(controls({ fire: true }), STEP, ctx)
  check('overheated guns stop firing', wasp.shotsFired === shotsAtLockout)

  /* Drone: hull repairs itself after a quiet spell. */
  const drone = new Ship(SHIPS.drone, FACTION_AI)
  drone.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  drone.warpTimer = 0
  drone.takeDamage(80, FACTION_PLAYER)
  const wounded = drone.hull
  for (let i = 0; i < 60 * 2; i++) drone.step(controls(), STEP, ctx)
  check('Drone does not repair inside the delay window', drone.hull === wounded)
  for (let i = 0; i < 60 * 6; i++) drone.step(controls(), STEP, ctx)
  check('Drone repairs after the delay', drone.hull > wounded, `hull=${drone.hull.toFixed(1)}`)
  check('repair never exceeds max hull', drone.hull <= drone.spec.maxHull)

  /* Hornet: dash adds speed, grants brief immunity, then goes on cooldown. */
  const hornet = new Ship(SHIPS.hornet, FACTION_PLAYER)
  hornet.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  hornet.warpTimer = 0
  for (let i = 0; i < 30; i++) hornet.step(controls({ throttle: 1 }), STEP, ctx)
  const cruise = hornet.velocity.length()
  hornet.step(controls({ throttle: 1, dash: true }), STEP, ctx)
  check('dash adds a burst of speed', hornet.velocity.length() > cruise + 400, `${cruise.toFixed(0)} → ${hornet.velocity.length().toFixed(0)}`)
  check('dashing ship cannot be hit', !hornet.targetable)
  const cooldown = hornet.dashCooldown
  check('dash goes on cooldown', cooldown > 0)
  for (let i = 0; i < 60; i++) hornet.step(controls({ throttle: 1, dash: true }), STEP, ctx)
  check('dash cannot be spammed', hornet.dashCooldown > 0 && hornet.dashCooldown < cooldown)
  check('phase ends and the ship is targetable again', hornet.targetable)

  bolts.dispose()
  wasp.dispose()
  drone.dispose()
  hornet.dispose()
}

function testSolarSear(): void {
  section('The star burns hulls that fly into it')

  const bolts = createBolts()
  const audio = silentAudio()
  const ctx: ShipContext = { hazards: [], audio, bolts, localFaction: FACTION_PLAYER }

  /* ---- Geometry: the zone has to be reachable, and the star must not ----- */

  // If the burn only began outside the hard limit the feature would be dead
  // code, and if the star's body were reachable a pilot could park inside it.
  const sunward = SUN_DIRECTION.clone().multiplyScalar(ARENA_RADIUS)
  check(
    'the burn zone is reachable inside the patrol boundary',
    solarExposure(sunward) > 0,
    `exposure at the sunward patrol line = ${solarExposure(sunward).toFixed(2)}`,
  )
  check(
    'the arena centre is completely clear of it',
    solarExposure(new THREE.Vector3(0, 0, 0)) === 0,
  )
  const closestApproach = SUN_POSITION.length() - ARENA_HARD_LIMIT
  check(
    'the star itself can never be touched',
    closestApproach > SUN_RADIUS,
    `closest approach ${closestApproach.toFixed(0)} vs body radius ${SUN_RADIUS}`,
  )

  /* ---- A hull parked in the light cooks ---------------------------------- */

  const burning = new Ship(SHIPS.hornet, FACTION_PLAYER)
  const deep = SUN_DIRECTION.clone().multiplyScalar(ARENA_RADIUS)
  burning.spawn(deep, new THREE.Vector3(0, 0, 0))
  burning.warpTimer = 0

  const startHull = burning.hull
  let deathAt = -1
  burning.onDeath = () => {
    deathAt = frames
  }

  // Pinned, because the point is the burn rate and not the flight model.
  let frames = 0
  for (; frames < 60 * 30 && deathAt < 0; frames++) {
    burning.position.copy(deep)
    burning.velocity.set(0, 0, 0)
    burning.step(controls(), STEP, ctx)
  }

  check('exposure is reported to the HUD', burning.solarExposure > 0, `exposure=${burning.solarExposure.toFixed(2)}`)
  check('a hull left in the light takes damage', burning.hull < startHull || deathAt > 0)
  check('and eventually burns up', deathAt > 0, `survived ${(frames * STEP).toFixed(1)}s`)
  // Long enough to read the warning and turn, short enough to be a real threat.
  const timeToDeath = deathAt * STEP
  check(
    `death takes between 2s and 12s (took ${timeToDeath.toFixed(1)}s)`,
    timeToDeath > 2 && timeToDeath < 12,
  )

  /* ---- Damage is not credited as player marksmanship --------------------- */

  const hostile = new Ship(SHIPS.wasp, FACTION_AI)
  hostile.spawn(deep, new THREE.Vector3(0, 0, 0))
  hostile.warpTimer = 0

  let creditedToPlayer = 0
  hostile.onDamaged = (_self, _amount, from) => {
    if (from === FACTION_PLAYER) creditedToPlayer++
  }
  for (let i = 0; i < 60 * 4 && hostile.alive; i++) {
    hostile.position.copy(deep)
    hostile.velocity.set(0, 0, 0)
    hostile.step(controls(), STEP, ctx)
  }
  check('an enemy in the light burns too', hostile.hull < hostile.spec.maxHull || !hostile.alive)
  check(
    'sear damage is never credited to the player',
    creditedToPlayer === 0,
    `${creditedToPlayer} tick(s) would have inflated accuracy`,
  )

  /* ---- Safe ground stays safe -------------------------------------------- */

  const shaded = new Ship(SHIPS.hornet, FACTION_PLAYER)
  // The anti-sunward patrol line: as far out as a pilot can legally fly, but
  // pointed away from the star.
  const away = SUN_DIRECTION.clone().multiplyScalar(-ARENA_RADIUS)
  shaded.spawn(away, new THREE.Vector3(0, 0, 0))
  shaded.warpTimer = 0
  for (let i = 0; i < 60 * 10; i++) {
    shaded.position.copy(away)
    shaded.velocity.set(0, 0, 0)
    shaded.step(controls(), STEP, ctx)
  }
  check('the far side of the arena is untouched', shaded.hull === shaded.spec.maxHull, `hull=${shaded.hull}`)
  check('and reports zero exposure', shaded.solarExposure === 0)

  /* ---- Materialising ships are not cooked before they can steer ---------- */

  const arriving = new Ship(SHIPS.wasp, FACTION_AI)
  arriving.spawn(deep, new THREE.Vector3(0, 0, 0))
  for (let i = 0; i < 30; i++) {
    arriving.position.copy(deep)
    arriving.velocity.set(0, 0, 0)
    arriving.step(controls(), STEP, ctx)
  }
  check('a warping-in ship is not burned mid-materialise', arriving.hull === arriving.spec.maxHull, `hull=${arriving.hull}`)

  /* ---- The exposure ramp is monotonic ------------------------------------ */

  let monotonic = true
  let previous = 1
  for (let d = 0; d <= 20; d++) {
    // Walk outward from the star along its own axis, sampling exposure.
    const at = SUN_POSITION.clone().addScaledVector(
      SUN_DIRECTION,
      -(SEAR_OUTER * (d / 20)),
    )
    const e = solarExposure(at)
    if (e > previous + 1e-6) monotonic = false
    previous = e
  }
  check('exposure falls off monotonically with distance', monotonic)

  bolts.dispose()
  burning.dispose()
  hostile.dispose()
  shaded.dispose()
  arriving.dispose()
}

function testBoltPoolDoesNotLeak(): void {
  section('Bolt pool survives saturation')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  const ship = new Ship(SHIPS.wasp, FACTION_PLAYER)
  ship.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  ship.warpTimer = 0

  // Far more shots than the pool holds, with nothing to hit.
  for (let i = 0; i < 60 * 30; i++) {
    ship.step(controls({ fire: true }), STEP, ctx)
    bolts.update(STEP, [ship], [])
  }

  check('no crash under sustained fire', true)
  bolts.clear()
  check('pool clears', true)

  bolts.dispose()
  ship.dispose()
}

/* -------------------------------------------------------------------------- */

/** The HUD is pure presentation, so a no-op satisfies the whole contract. */
function stubHud(): Hud {
  const noop = () => {}
  return {
    root: null as unknown as HTMLElement,
    show: noop,
    hide: noop,
    setShip: noop,
    update: noop,
    updateContacts: noop,
    flashDamage: noop,
    callout: noop,
    feed: noop,
    setLockPrompt: noop,
    tick: noop,
    dispose: noop,
  }
}

/**
 * A HUD stub that keeps what it was handed.
 *
 * The real HUD is DOM and cannot be inspected here, but *what the game tells it*
 * can be — and that is where the interesting bug lives. A contact bracket is
 * positioned from whatever `updateContacts` receives, so recording those points
 * puts an off-scene-graph consumer inside reach of the same invariant check
 * every mesh already gets. Positions are cloned because the game pushes live
 * references into the buffer.
 */
function recordingHud(): Hud & { contactPoints: THREE.Vector3[] } {
  const hud = stubHud() as Hud & { contactPoints: THREE.Vector3[] }
  hud.contactPoints = []
  hud.updateContacts = (contacts) => {
    hud.contactPoints = contacts.map((c) => c.position.clone())
  }
  return hud
}

/**
 * A directly-writable input. Unlike the browser's keyboard this gives real
 * proportional deflection, which is what a mouse gives a human player — binary
 * key steering swings past a manoeuvring target and never settles.
 */
function stubInput(): Input & { write: InputState } {
  const state: InputState = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttleUp: false,
    throttleDown: false,
    fire: false,
    dash: false,
  }
  const noop = () => {}
  return {
    state,
    write: state,
    pointerLocked: true,
    invertPitch: false,
    update: noop,
    requestPointerLock: noop,
    releasePointerLock: noop,
    onPointerLockLost: noop,
    onKey: noop,
    reset: noop,
    dispose: noop,
  } as Input & { write: InputState }
}

/**
 * An empty arena: no stations, no mines and no pods, so this measures the
 * dogfight and nothing else. Both get their own dedicated checks below.
 */
function stubEnvironment(): Environment {
  const group = new THREE.Group()
  return {
    group,
    stations: [],
    hazards: [],
    minefield: buildMinefield({
      count: 0,
      arenaRadius: ARENA_RADIUS,
      hazards: [],
      spawn: new THREE.Vector3(),
    }),
    pickups: buildPickups({
      counts: { repair: 0, overdrive: 0, shield: 0 },
      arenaRadius: ARENA_RADIUS,
      hazards: [],
      mines: [],
      spawn: new THREE.Vector3(),
    }),
    planet: {
      group: new THREE.Group(),
      radius: 1,
      center: new THREE.Vector3(),
      spin: 0,
      update() {},
      dispose() {},
    },
    step() {},
    update() {},
    dispose() {},
  }
}

/**
 * Verifies the *win transition*, not the difficulty curve.
 *
 * The pilot here is a proportional controller, which is a poor stand-in for a
 * human: it treats a jinking target's lead point as raw signal and oscillates,
 * where a person reading the lead pip anticipates. Tuning it until it could beat
 * the real balance would be testing the autopilot rather than the game. So the
 * fight is stacked instead, and deliberately stacked *hard*:
 *
 * - the player cannot die, so the only way the run can end is a cleared roster;
 * - enemy hulls fall to one hit;
 * - the player's guns fire fast with near-instant bolts;
 * - and enemy hit spheres are inflated to 350 units, so aim is removed from the
 *   equation altogether.
 *
 * That last lever is what makes this an assertion rather than a coin flip.
 * Stacking damage and rate of fire alone was not enough — measured across seven
 * seeds it still failed two, because a proportional controller sometimes never
 * closes to firing range at all, and no amount of volume fixes never being in
 * range. Whether a pilot *can* hit is already covered by the bolt checks above;
 * this test is only about the orchestration on top: the spawn queue draining,
 * dead hostiles being retired, the win being detected, and the bonuses landing.
 *
 * The seed is still pinned so the reported numbers are reproducible, but nothing
 * depends on it. It used to: an earlier version leaned on a lucky seed and broke
 * the moment an unrelated change added two `THREE` objects to the scene, because
 * `MathUtils.generateUUID` draws from `Math.random`, so constructing any
 * geometry or material shifts the stream and the whole run diverges.
 *
 * That is also why the seed now goes in through `start` rather than by swapping
 * the global `Math.random` out from under the process, which is what this used
 * to do. The run's own draws come from its seed and share a stream with nothing
 * else, so building a mesh can no longer move the fight.
 */
const WIN_SEED = 0x5120fa11

function testARunCanBeWon(): void {
  section('A cleared roster reports a win')

  const originalHulls = {
    wasp: SHIPS.wasp.maxHull,
    drone: SHIPS.drone.maxHull,
    hornet: SHIPS.hornet.maxHull,
  }
  const originalGuns = {
    fireInterval: SHIPS.hornet.fireInterval,
    boltSpeed: SHIPS.hornet.boltSpeed,
    damage: SHIPS.hornet.damage,
  }
  const originalRadii = { wasp: SHIPS.wasp.radius, drone: SHIPS.drone.radius }
  SHIPS.wasp.maxHull = 12
  SHIPS.drone.maxHull = 12
  SHIPS.hornet.maxHull = 1_000_000
  SHIPS.hornet.fireInterval = 0.03
  SHIPS.hornet.boltSpeed = 6000
  SHIPS.hornet.damage = 200
  SHIPS.wasp.radius = 350
  SHIPS.drone.radius = 350

  const input = stubInput()
  const pilot = createPilot()
  let result: RunResult | null = null

  const game = createGame({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
    environment: stubEnvironment(),
    input,
    audio: silentAudio(),
    hud: stubHud(),
    bestScoreFor: () => 0,
    onEnd: (r) => {
      result = r
    },
  })

  game.start({ ships: ['hornet'], seed: WIN_SEED })

  const budget = Math.ceil(240 / STEP)
  let frames = 0
  for (; frames < budget && !result; frames++) {
    const run = game.snapshot()
    const target = run?.target ?? null

    if (target) {
      // Pursue the *lead* point of the locked target, proportionally. Aiming at
      // where the hull is rather than where it will be misses almost every shot
      // against something crossing at hundreds of units a second.
      input.write.pitch = clampTo(target.pitch * 3, -1, 1)
      input.write.yaw = clampTo(target.yaw * 3, -1, 1)
      // A generous cone on purpose. Gating on the angle a hull actually subtends
      // is a 0.026 rad needle at 1000 units, and a proportional controller
      // almost never sits inside it — one seed in four never fired enough to
      // finish. Volume of fire is what makes this seed-independent.
      input.write.fire =
        Math.abs(target.pitch) < 0.35 && Math.abs(target.yaw) < 0.35 && target.range < 1200
      input.write.throttleUp = target.range > 260
      input.write.throttleDown = target.range < 170
    } else {
      input.write.pitch = 0
      input.write.yaw = 0
      input.write.fire = false
      input.write.throttleUp = true
      input.write.throttleDown = false
    }

    game.step([pilot.advance(input.state, STEP)])
  }

  SHIPS.wasp.maxHull = originalHulls.wasp
  SHIPS.drone.maxHull = originalHulls.drone
  SHIPS.hornet.maxHull = originalHulls.hornet
  SHIPS.hornet.fireInterval = originalGuns.fireInterval
  SHIPS.hornet.boltSpeed = originalGuns.boltSpeed
  SHIPS.hornet.damage = originalGuns.damage
  SHIPS.wasp.radius = originalRadii.wasp
  SHIPS.drone.radius = originalRadii.drone

  const run = result as RunResult | null
  check('the run resolved', run !== null, `gave up after ${(frames * STEP).toFixed(0)}s`)
  check('an emptied roster reports a win', run?.won === true, run ? `won=${run.won}, kills=${run.kills}` : 'no result')
  check('every hostile in the roster was accounted for', run?.kills === 6, `kills=${run?.kills}`)
  check('the run scored points', (run?.score ?? 0) > 0, `score=${run?.score}`)
  check('accuracy was recorded', (run?.accuracy ?? 0) > 0, `accuracy=${run?.accuracy?.toFixed(3)}`)
  check('a win awards the hull and time bonuses', (run?.score ?? 0) > 6 * SHIPS.wasp.bounty, `score=${run?.score}`)
  check(
    'the player spec was restored',
    SHIPS.hornet.maxHull === originalHulls.hornet &&
      SHIPS.hornet.damage === originalGuns.damage &&
      SHIPS.hornet.fireInterval === originalGuns.fireInterval &&
      SHIPS.wasp.radius === originalRadii.wasp,
  )
  if (run) {
    console.log(
      `       cleared in ${run.time.toFixed(1)}s · score ${run.score} · accuracy ${(run.accuracy * 100).toFixed(0)}%`,
    )
  }

  game.dispose()
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * A minefield that is one mine the size of the arena: anything past its warp-in
 * immunity is touching it, wherever it flies.
 *
 * A real field cannot be used here — placement deliberately keeps 620 units
 * clear of the player spawn — and steering a scripted pilot onto a mine would
 * make the test depend on the autopilot. This kills the player at a known
 * moment (the frame warp-in immunity expires) and nothing else.
 */
function armedArena(): Minefield {
  const mine: Mine = { position: new THREE.Vector3(), live: true }
  return {
    group: new THREE.Group(),
    mines: [mine],
    avoidance: [],
    findContact: () => (mine.live ? mine : null),
    detonate: (m) => {
      m.live = false
    },
    reset: () => {
      mine.live = true
    },
    update() {},
    dispose() {},
  }
}

/**
 * The death animation, which is the whole reason `finish` is no longer called on
 * the frame the player dies.
 *
 * What is being asserted is the *handoff*, not the particles: the run resolves
 * immediately and privately, the wreck then holds the screen for the full
 * sequence, and only then does the debrief get the result. The failure this
 * guards against is the original behaviour — a fireball spawned and wiped by
 * `clearArena` in the same frame, so the player saw one frame of it at most.
 */
function testDeathPlaysBeforeTheDebrief(): void {
  section('A fatal hit plays out before the debrief')

  const originalHull = SHIPS.wasp.maxHull
  // A mine is 45 damage flat, so a 40-hull Wasp does not survive touching one.
  SHIPS.wasp.maxHull = 40

  const input = stubInput()
  const pilot = createPilot()
  let result: RunResult | null = null

  const game = createGame({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
    environment: { ...stubEnvironment(), minefield: armedArena() },
    input,
    audio: silentAudio(),
    hud: stubHud(),
    bestScoreFor: () => 0,
    onEnd: (r) => {
      result = r
    },
  })

  game.start({ ships: ['wasp'] })

  let deathFrame = -1
  let resultFrame = -1
  let dyingFrames = 0
  let pausedMidDeath = false

  const budget = Math.ceil(20 / STEP)
  let frames = 0
  for (; frames < budget && resultFrame < 0; frames++) {
    game.step([pilot.advance(input.state, STEP)])

    if (deathFrame < 0 && (game.snapshot()?.hull ?? 1) <= 0) deathFrame = frames
    if (game.dying) {
      dyingFrames++
      // Escape mid-explosion must not strand the player in a paused fireball
      // with a debrief queued behind it.
      game.pause()
      if (game.paused) pausedMidDeath = true
    }
    if (result && resultFrame < 0) resultFrame = frames
  }

  SHIPS.wasp.maxHull = originalHull

  const run = result as RunResult | null
  const hold = (resultFrame - deathFrame) * STEP

  check('the player died', deathFrame > 0, `hull never reached zero in ${(frames * STEP).toFixed(1)}s`)
  check('the run resolved', run !== null, `no result after ${(frames * STEP).toFixed(1)}s`)
  check('a fatal hit is recorded as a loss', run?.won === false, `won=${run?.won}`)
  check(
    'the debrief does not land on the frame of death',
    resultFrame > deathFrame,
    `death=${deathFrame}, result=${resultFrame}`,
  )
  check(
    'the wreck holds the screen for the whole sequence',
    hold >= DEATH_SEQUENCE - STEP && hold <= DEATH_SEQUENCE + 2 * STEP,
    `held ${hold.toFixed(2)}s, expected ${DEATH_SEQUENCE}s`,
  )
  check(
    'the sequence is long enough to read and short enough to sit through',
    DEATH_SEQUENCE >= 1.5 && DEATH_SEQUENCE <= 4,
    `${DEATH_SEQUENCE}s`,
  )
  check(
    'the game reports itself dying for the duration',
    dyingFrames === resultFrame - deathFrame,
    `${dyingFrames} frames dying, ${resultFrame - deathFrame} frames between death and debrief`,
  )
  check('the death animation cannot be paused', !pausedMidDeath)
  // The clock stops when the player does. Counting the animation as flight time
  // would inflate every recorded loss by the length of its own explosion.
  check(
    'the recorded time is time flown, not time spent exploding',
    (run?.time ?? 0) <= (deathFrame + 2) * STEP,
    `recorded ${run?.time.toFixed(2)}s, died at ${(deathFrame * STEP).toFixed(2)}s`,
  )
  check('the player spec was restored', SHIPS.wasp.maxHull === originalHull)

  if (run) {
    console.log(
      `       died at ${(deathFrame * STEP).toFixed(2)}s · wreck held ${hold.toFixed(2)}s · debrief at ${(resultFrame * STEP).toFixed(2)}s`,
    )
  }

  game.dispose()
}

function testMines(): void {
  section('Mines detonate on contact and stay detonated')

  const stations: Hazard[] = [
    { center: new THREE.Vector3(0, 0, -2000), radius: 80, avoidRange: 520, name: 'TEST STATION' },
  ]
  const spawn = new THREE.Vector3(0, 120, 1400)

  const field = buildMinefield({ count: 26, arenaRadius: ARENA_RADIUS, hazards: stations, spawn })

  check('the field placed mines', field.mines.length > 0, `placed=${field.mines.length}`)
  check('all mines start armed', field.mines.every((m) => m.live))
  check('every live mine is offered to the AI', field.avoidance.length === field.mines.length)

  // Placement contract: nothing inside the player spawn, a station, or another mine.
  const tooCloseToSpawn = field.mines.filter((m) => m.position.distanceTo(spawn) < 620).length
  const insideStation = field.mines.filter((m) =>
    stations.some((s) => m.position.distanceTo(s.center) < s.radius + 240),
  ).length
  let clustered = 0
  for (let i = 0; i < field.mines.length; i++) {
    for (let j = i + 1; j < field.mines.length; j++) {
      if (field.mines[i].position.distanceTo(field.mines[j].position) < 260) clustered++
    }
  }
  const outsideArena = field.mines.filter((m) => m.position.length() > ARENA_RADIUS).length

  check('none sit on the player spawn', tooCloseToSpawn === 0, `${tooCloseToSpawn} too close`)
  check('none sit inside a station', insideStation === 0, `${insideStation} overlapping`)
  check('none are clustered together', clustered === 0, `${clustered} pairs under 260u`)
  check('all are inside the arena', outsideArena === 0, `${outsideArena} outside`)

  /* ---- Contact ---------------------------------------------------------- */

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  const target = field.mines[0]
  const ship = new Ship(SHIPS.hornet, FACTION_PLAYER)
  ship.spawn(target.position.clone(), new THREE.Vector3(0, 0, 0))
  ship.warpTimer = 0

  check('a ship on top of a mine registers contact', field.findContact(ship.position, ship.radius) === target)

  const before = ship.hull
  field.detonate(target)
  ship.takeDamage(MINE_DAMAGE, FACTION_AI)

  check('detonation damages the ship', ship.hull === before - MINE_DAMAGE, `hull=${ship.hull}`)
  check('a detonated mine is dead', !target.live)
  check(
    'a detonated mine no longer registers contact',
    field.findContact(ship.position, ship.radius) === null,
  )
  check('the AI avoid list shrank', field.avoidance.length === field.mines.length - 1)

  // The same mine must not keep hurting a ship parked inside its shell.
  const parked = ship.hull
  for (let i = 0; i < 60; i++) {
    if (field.findContact(ship.position, ship.radius)) ship.takeDamage(MINE_DAMAGE, FACTION_AI)
    ship.step(controls(), STEP, ctx)
  }
  check('a dead mine cannot re-trigger', ship.hull === parked, `hull=${ship.hull} vs ${parked}`)

  /* ---- Reset ------------------------------------------------------------ */

  field.reset()
  check('reset re-arms the whole field', field.mines.every((m) => m.live))
  check('reset restores the avoid list', field.avoidance.length === field.mines.length)

  // A mine is a serious punishment but must not one-shot any airframe.
  const survives = (['wasp', 'hornet', 'drone'] as const).every(
    (id) => SHIPS[id].maxHull > MINE_DAMAGE,
  )
  check('no airframe is one-shot by a mine', survives, `mine=${MINE_DAMAGE}, wasp=${SHIPS.wasp.maxHull}`)

  bolts.dispose()
  ship.dispose()
  field.dispose()
}

function testPickups(): void {
  section('Power-up pods place, collect and re-arm')

  const stations: Hazard[] = [
    { center: new THREE.Vector3(0, 0, -2000), radius: 80, avoidRange: 520, name: 'TEST STATION' },
  ]
  const spawn = new THREE.Vector3(0, 120, 1400)
  const mines = buildMinefield({ count: 26, arenaRadius: ARENA_RADIUS, hazards: stations, spawn })
  const minePositions = mines.mines.map((m) => m.position)

  const counts = { repair: 5, overdrive: 4, shield: 4 }
  const total = counts.repair + counts.overdrive + counts.shield

  const field = buildPickups({
    counts,
    arenaRadius: ARENA_RADIUS,
    hazards: stations,
    mines: minePositions,
    spawn,
  })

  /* ---- Placement --------------------------------------------------------- */

  check('every requested pad was placed', field.pods.length === total, `placed=${field.pods.length}`)
  check('all pads start armed', field.pods.every((p) => p.live))
  for (const kind of PICKUP_KINDS) {
    const got = field.pods.filter((p) => p.kind === kind).length
    check(`the field laid out ${counts[kind]} ${kind} pads`, got === counts[kind], `got ${got}`)
  }

  const nearSpawn = field.pods.filter((p) => p.position.distanceTo(spawn) < 700).length
  const inStation = field.pods.filter((p) =>
    stations.some((s) => p.position.distanceTo(s.center) < s.radius + 260),
  ).length
  // A pod sitting inside a mine's blast would be a 45-damage tax on a 35-hull
  // heal, which is the exact trade this placement exists to prevent.
  const onAMine = field.pods.filter((p) =>
    minePositions.some((m) => p.position.distanceTo(m) < 240),
  ).length
  const outside = field.pods.filter((p) => p.position.length() > ARENA_RADIUS).length
  let crowded = 0
  for (let i = 0; i < field.pods.length; i++) {
    for (let j = i + 1; j < field.pods.length; j++) {
      if (field.pods[i].position.distanceTo(field.pods[j].position) < 700) crowded++
    }
  }

  check('none sit on the player spawn', nearSpawn === 0, `${nearSpawn} too close`)
  check('none sit inside a station', inStation === 0, `${inStation} overlapping`)
  check('none sit on top of a mine', onAMine === 0, `${onAMine} inside a blast`)
  check('none are crowded together', crowded === 0, `${crowded} pairs under 700u`)
  check('all are inside the arena', outside === 0, `${outside} outside`)

  /* ---- Repair ------------------------------------------------------------ */

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  const repairPad = field.pods.find((p) => p.kind === 'repair')!
  const ship = new Ship(SHIPS.hornet, FACTION_PLAYER)
  ship.spawn(repairPad.position.clone(), new THREE.Vector3(0, 0, 0))
  ship.warpTimer = 0

  check(
    'a hull on top of a pad registers contact',
    field.findContact(ship.position, ship.radius) === repairPad,
  )
  // The reach has to survive the worst frame the loop will accept (1/20s), or a
  // fast airframe would step straight over a pod on a stutter.
  check(
    'the contact sphere is wider than the fastest hull moves in one clamped frame',
    PICKUP_RADIUS + SHIPS.wasp.radius > SHIPS.wasp.maxSpeed / 20,
    `reach ${PICKUP_RADIUS + SHIPS.wasp.radius} vs ${(SHIPS.wasp.maxSpeed / 20).toFixed(1)}u per frame`,
  )

  // A full hull must not consume the pad.
  check('a pod over a full hull heals nothing', ship.repair(REPAIR_AMOUNT) === 0)

  ship.takeDamage(60, FACTION_AI)
  const wounded = ship.hull
  const healed = ship.repair(REPAIR_AMOUNT)
  check('a wounded hull is repaired', healed === REPAIR_AMOUNT, `healed=${healed}`)
  check('repair lands on the hull', ship.hull === wounded + REPAIR_AMOUNT, `hull=${ship.hull}`)

  // Overheal is clipped, not banked.
  ship.repair(1000)
  check('repair never exceeds max hull', ship.hull === ship.spec.maxHull, `hull=${ship.hull}`)

  /**
   * Repairing must not reset the damage clock. `sinceHit` is the Drone's nanite
   * timer, so a pod that touched it would mean collecting a heal *postpones*
   * your other heal.
   */
  const drone = new Ship(SHIPS.drone, FACTION_PLAYER)
  drone.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  drone.warpTimer = 0
  drone.takeDamage(120, FACTION_AI)
  for (let i = 0; i < 60 * 3; i++) drone.step(controls(), STEP, ctx)
  const clockBefore = drone.sinceHit
  drone.repair(REPAIR_AMOUNT)
  check(
    'repairing does not restart the nanite delay',
    drone.sinceHit === clockBefore,
    `${clockBefore.toFixed(2)}s → ${drone.sinceHit.toFixed(2)}s`,
  )

  /* ---- Collection and respawn -------------------------------------------- */

  field.collect(repairPad)
  check('a collected pad goes dark', !repairPad.live)
  check(
    'a collected pad stops registering contact',
    field.findContact(repairPad.position, 40) === null,
  )
  check('a collected pad has a respawn clock', repairPad.respawnIn > 0)

  // Halfway through the clock it must still be gone; past it, back. A real
  // camera rather than a stub, so the billboard maths runs here too — it is the
  // only thing in this module that touches an external object per frame.
  const eye = new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000)
  eye.position.set(0, 0, 800)
  eye.updateMatrixWorld()

  // `step` runs the respawn clock and `update` runs the billboarding — both are
  // driven here so this still covers the render path it always did, while
  // asserting against the half that actually decides whether a pad is there.
  function tick(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      field.step(STEP)
      field.update(STEP, eye)
    }
  }

  const half = repairPad.respawnIn / 2
  tick(half)
  check('it stays gone while the clock runs', !repairPad.live, `${repairPad.respawnIn.toFixed(1)}s left`)
  tick(half + 1)
  check('it re-arms once the clock expires', repairPad.live)
  check('a re-armed pad registers contact again', field.findContact(repairPad.position, 40) === repairPad)

  field.collect(repairPad)
  field.reset()
  check('reset re-arms the whole field', field.pods.every((p) => p.live && p.respawnIn === 0))

  /* ---- Overdrive --------------------------------------------------------- */

  const gunner = new Ship(SHIPS.hornet, FACTION_PLAYER)
  gunner.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  gunner.warpTimer = 0

  check('a stock ship is not overdriven', !gunner.overdriven)

  // Count shots and total damage over a fixed window, stock and boosted, with
  // the ship pinned — this is the same trick the balance harness uses.
  function fireFor(ship: Ship, seconds: number): { shots: number; damage: number } {
    const dummy = new Ship(SHIPS.drone, FACTION_AI)
    dummy.spawn(new THREE.Vector3(0, 0, -400), new THREE.Vector3(0, 0, -4000))
    dummy.warpTimer = 0
    let damage = 0
    dummy.onDamaged = (_s, amount) => {
      damage += amount
    }
    const before = ship.shotsFired
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      ship.position.set(0, 0, 0)
      ship.velocity.set(0, 0, 0)
      dummy.hull = dummy.spec.maxHull
      dummy.position.set(0, 0, -400)
      dummy.velocity.set(0, 0, 0)
      ship.step(controls({ fire: true }), STEP, ctx)
      dummy.step(controls(), STEP, ctx)
      bolts.update(STEP, [ship, dummy], [])
    }
    dummy.dispose()
    return { shots: ship.shotsFired - before, damage }
  }

  const stock = fireFor(gunner, 4)
  gunner.engageOverdrive(OVERDRIVE_DURATION)
  check('overdrive engages', gunner.overdriven && gunner.overdriveTimer === OVERDRIVE_DURATION)
  const boosted = fireFor(gunner, 4)

  // Twice the shots, and — the whole point of the design — the *same* damage on
  // each, so total output lands on 2x rather than 4x. Banded rather than exact:
  // the fire timer carries its overshoot between frames, so a fixed window lands
  // within a shot of the ideal rather than on it.
  const rateGain = boosted.shots / stock.shots
  const damageGain = boosted.damage / stock.damage
  check(
    `overdrive roughly ${OVERDRIVE_RATE_MULT}x the rate of fire`,
    rateGain > OVERDRIVE_RATE_MULT * 0.9 && rateGain < OVERDRIVE_RATE_MULT * 1.1,
    `${stock.shots} → ${boosted.shots} shots (${rateGain.toFixed(2)}x)`,
  )
  check(
    `overdrive totals ${OVERDRIVE_RATE_MULT}x damage, not ${OVERDRIVE_RATE_MULT ** 2}x`,
    damageGain > OVERDRIVE_RATE_MULT * 0.85 && damageGain < OVERDRIVE_RATE_MULT * 1.15,
    `${stock.damage} → ${boosted.damage} damage (${damageGain.toFixed(2)}x)`,
  )

  /**
   * The invariant that makes the above safe. A boosted bolt has to carry the
   * damage its spec sheet says it does, or alpha strike moves and one-volley
   * kill thresholds move with it — an earlier version that doubled bolt damage
   * let a boosted Drone delete a Wasp between frames.
   */
  const boostedBolt = new Ship(SHIPS.drone, FACTION_PLAYER)
  boostedBolt.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  boostedBolt.warpTimer = 0
  boostedBolt.engageOverdrive(OVERDRIVE_DURATION)
  const mark = new Ship(SHIPS.wasp, FACTION_AI)
  mark.spawn(new THREE.Vector3(0, 0, -400), new THREE.Vector3(0, 0, -4000))
  mark.warpTimer = 0
  let biggestHit = 0
  mark.onDamaged = (_s, amount) => {
    biggestHit = Math.max(biggestHit, amount)
  }
  for (let i = 0; i < 120; i++) {
    boostedBolt.position.set(0, 0, 0)
    boostedBolt.velocity.set(0, 0, 0)
    mark.hull = mark.spec.maxHull
    mark.position.set(0, 0, -400)
    mark.velocity.set(0, 0, 0)
    boostedBolt.step(controls({ fire: true }), STEP, ctx)
    bolts.update(STEP, [boostedBolt, mark], [])
  }
  check(
    'a boosted bolt still does exactly its spec damage',
    biggestHit === SHIPS.drone.damage,
    `${biggestHit} vs spec ${SHIPS.drone.damage}`,
  )

  /* Stack, not refresh. */
  gunner.overdriveTimer = 0
  gunner.engageOverdrive(OVERDRIVE_DURATION)
  gunner.engageOverdrive(OVERDRIVE_DURATION)
  check(
    'a second pod stacks onto the clock',
    gunner.overdriveTimer === OVERDRIVE_DURATION * 2,
    `${gunner.overdriveTimer.toFixed(1)}s`,
  )

  /* And it has to actually end. */
  for (let i = 0; i < Math.round((OVERDRIVE_DURATION * 2 + 1) / STEP); i++) {
    gunner.step(controls(), STEP, ctx)
  }
  check('overdrive expires', !gunner.overdriven, `${gunner.overdriveTimer.toFixed(2)}s left`)

  /* A fresh spawn must not inherit the previous run's buff. */
  gunner.engageOverdrive(OVERDRIVE_DURATION)
  gunner.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  check('respawning clears overdrive', !gunner.overdriven)

  /* ---- Shield ------------------------------------------------------------ */

  const guarded = new Ship(SHIPS.hornet, FACTION_PLAYER)
  guarded.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  guarded.warpTimer = 0

  check('a stock ship is not shielded', !guarded.shielded)

  let credited = 0
  let absorbed = 0
  guarded.onDamaged = () => {
    credited++
  }
  guarded.onShielded = (_s, amount) => {
    absorbed += amount
  }

  guarded.engageShield(SHIELD_DURATION)
  const full = guarded.hull
  guarded.takeDamage(40, FACTION_AI)
  check('a shielded hull takes no damage', guarded.hull === full, `hull=${guarded.hull}`)
  check('the absorbed hit is reported', absorbed === 40, `absorbed=${absorbed}`)
  /**
   * A refused hit must not be credited to the shooter. `onDamaged` is what the
   * game loop counts as "a hit landed", so letting it fire here would inflate
   * the accuracy stat with bolts that accomplished nothing — the same trap sear
   * damage already has a comment about in `Ship.applySolarSear`.
   */
  check('a refused hit is not credited as a hit landed', credited === 0, `${credited} credited`)

  /* Every damage source, not just bolts. */
  guarded.takeDamage(MINE_DAMAGE, FACTION_AI)
  check('a shield eats a mine too', guarded.hull === full, `hull=${guarded.hull}`)

  /**
   * The shield must not reset the damage clock. `sinceHit` is the Drone's
   * nanite timer, so a shielded Drone should keep repairing right through
   * incoming fire — nothing reached its hull.
   */
  const guardedDrone = new Ship(SHIPS.drone, FACTION_PLAYER)
  guardedDrone.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  guardedDrone.warpTimer = 0
  guardedDrone.takeDamage(120, FACTION_AI)
  for (let i = 0; i < 60 * 8; i++) guardedDrone.step(controls(), STEP, ctx)
  const repairing = guardedDrone.hull
  guardedDrone.engageShield(SHIELD_DURATION)
  for (let i = 0; i < 60; i++) {
    guardedDrone.takeDamage(10, FACTION_AI)
    guardedDrone.step(controls(), STEP, ctx)
  }
  check(
    'a shielded Drone keeps repairing under fire',
    guardedDrone.hull > repairing,
    `${repairing.toFixed(1)} → ${guardedDrone.hull.toFixed(1)}`,
  )

  /* Stacking, expiry and respawn, same contract as Overdrive. */
  guarded.shieldTimer = 0
  guarded.engageShield(SHIELD_DURATION)
  guarded.engageShield(SHIELD_DURATION)
  check(
    'shield pods stack onto the clock',
    guarded.shieldTimer === SHIELD_DURATION * 2,
    `${guarded.shieldTimer.toFixed(1)}s`,
  )
  for (let i = 0; i < Math.round((SHIELD_DURATION * 2 + 1) / STEP); i++) {
    guarded.step(controls(), STEP, ctx)
  }
  check('shield expires', !guarded.shielded, `${guarded.shieldTimer.toFixed(2)}s left`)

  const after = guarded.hull
  guarded.takeDamage(20, FACTION_AI)
  check('damage lands again once the shield drops', guarded.hull === after - 20, `hull=${guarded.hull}`)

  guarded.engageShield(SHIELD_DURATION)
  guarded.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  check('respawning clears the shield', !guarded.shielded)

  /* ---- The shared countdown threshold ------------------------------------ */

  check(
    'the countdown threshold leaves real un-warned time on both buffs',
    TIMED_WARN_AT > 0 &&
      TIMED_WARN_AT < OVERDRIVE_DURATION &&
      TIMED_WARN_AT < SHIELD_DURATION,
    `warn at ${TIMED_WARN_AT}s of ${OVERDRIVE_DURATION}s / ${SHIELD_DURATION}s`,
  )

  bolts.dispose()
  ship.dispose()
  drone.dispose()
  gunner.dispose()
  boostedBolt.dispose()
  mark.dispose()
  guarded.dispose()
  guardedDrone.dispose()
  field.dispose()
  mines.dispose()
}

/**
 * The determinism contract: a run is a function of its seed and its inputs, and
 * of nothing else.
 *
 * This is the check the netcode work rests on. Server authority, host-peer play
 * and replay-verified scores all reduce to the same claim — that the same seed
 * fed the same inputs produces the same fight — and that claim is cheap to
 * believe and easy to break. Any new `Math.random()` on a path that decides an
 * outcome breaks it, and this is what catches that.
 *
 * The two runs are played by the same closed-loop autopilot rather than a fixed
 * input tape, deliberately: an autopilot steers from what it sees, so the
 * smallest divergence in a hostile's position changes the next input and the two
 * runs peel apart fast. A fixed tape would let a small drift stay small and pass.
 *
 * Note what is *not* controlled here — each run builds its own scene, meshes and
 * materials, and every one of those draws from the global `Math.random` through
 * `THREE.MathUtils.generateUUID`. That used to be enough to move a run. It is
 * exactly what the run seed being its own stream now makes irrelevant, so
 * leaving it uncontrolled is part of the test.
 */
interface Played {
  /** Fingerprints sampled through the run, joined. */
  trace: string
  /** The run as it stood at the last tick, for asserting it was a real fight. */
  final: RunSnapshot | null
}

function testASeededRunReproduces(): void {
  section('A seeded run reproduces from its seed')

  /** The parts of a run a divergence would surface in. */
  function fingerprint(run: RunSnapshot | null): string {
    if (!run) return 'none'
    const t = run.target
    return [
      run.score,
      run.kills,
      run.shotsFired,
      run.hull,
      run.speed,
      run.enemiesAirborne,
      run.enemiesQueued,
      run.solarExposure,
      // Bearing to the locked hostile — the most sensitive number available
      // here, since it moves with every AI wander decision.
      t ? `${t.yaw},${t.pitch},${t.range},${t.hull}` : 'nolock',
    ].join(' ')
  }

  function playOut(ship: ShipId, seed: number, ticks: number): Played {
    const input = stubInput()
    const pilot = createPilot()
    const game = createGame({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
      environment: stubEnvironment(),
      input,
      audio: silentAudio(),
      hud: stubHud(),
      bestScoreFor: () => 0,
      onEnd: () => {},
    })

    game.start({ ships: [ship], seed })

    const marks: string[] = []
    for (let i = 0; i < ticks; i++) {
      const target = game.snapshot()?.target ?? null
      if (target) {
        input.write.pitch = clampTo(target.pitch * 3, -1, 1)
        input.write.yaw = clampTo(target.yaw * 3, -1, 1)
        input.write.fire = Math.abs(target.pitch) < 0.35 && Math.abs(target.yaw) < 0.35
        input.write.throttleUp = target.range > 260
        input.write.throttleDown = target.range < 170
      } else {
        input.write.pitch = 0
        input.write.yaw = 0
        input.write.fire = false
        input.write.throttleUp = true
        input.write.throttleDown = false
      }
      game.step([pilot.advance(input.state, STEP)])
      // Sampled along the way, not just at the end: two runs that diverge and
      // then happen to land on the same score would slip past a single check.
      if (i % 90 === 0) marks.push(fingerprint(game.snapshot()))
    }
    const final = game.snapshot()
    marks.push(fingerprint(final))
    return { trace: marks.join(' | '), final }
  }

  const TICKS = Math.ceil(14 / STEP)

  /**
   * Every airframe gets a turn, because the squadron is always the *other* two
   * hulls and the quirks are per-hull. Playing only the Hornet means the enemies
   * are a Wasp and a Drone, neither of which dashes, so the dash roll in
   * `EnemyPilot` is never exercised and could quietly go back to `Math.random()`
   * without failing anything. Rotating the player through all three guarantees
   * each hull appears on the hostile side at least once.
   */
  for (const ship of SHIP_ORDER) {
    const seed = 0x51ede7
    const first = playOut(ship, seed, TICKS)
    const again = playOut(ship, seed, TICKS)
    const other = playOut(ship, seed + 1, TICKS)

    check(
      `a ${ship} run replays identically from the same seed`,
      first.trace === again.trace,
      firstDifference(first.trace, again.trace),
    )
    check(`a ${ship} run differs on a different seed`, first.trace !== other.trace)

    /* Two runs that never engaged would compare equal for entirely
       uninteresting reasons, so the comparison is only worth something if the
       run it compared was a real fight. Asserted against the final snapshot
       rather than against the trace string — the first version of this tested
       the trace and was vacuously true, which is exactly the failure it was
       supposed to prevent. */
    const f = first.final
    check(
      `the ${ship} run actually fought`,
      f !== null && f.shotsFired > 0 && f.enemiesAirborne > 0,
      f ? `shots=${f.shotsFired}, airborne=${f.enemiesAirborne}` : 'no snapshot',
    )
  }
}

/** Where two fingerprints part company, for a failure message worth reading. */
function firstDifference(a: string, b: string): string {
  const left = a.split(' | ')
  const right = b.split(' | ')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return `diverged at mark ${i}: "${left[i]}" vs "${right[i]}"`
  }
  return 'identical'
}

/**
 * A run is a function of its seed and its control stream, and of nothing else.
 *
 * Phase A established that a run replays from its seed given the same *device*
 * state. This is the stronger claim the netcode actually rests on: that the
 * simulation can be driven by controls alone, with no input device anywhere in
 * the loop. A host replaying a client's inputs, a server validating a submitted
 * run, and a client predicting ahead of a snapshot are all this same operation.
 *
 * The recording run flies an autopilot; the replay run has no autopilot, no
 * `Input`, and no `Pilot` — just a list of structs handed to `step`. If anything
 * in the simulation still reached for a device, the two would part company.
 */
/**
 * The simulation defends itself against the controls it is handed.
 *
 * `Controls` is becoming a wire format, so the airframe has to be the thing that
 * bounds deflection rather than trusting every producer to have done it. Both
 * producers that exist today already clamp — the AI in `ai.ts`, the device in
 * `input.ts`, where roll is built from two keys and can only be -1, 0 or 1 — so
 * these assertions describe a bound that changes no run that exists. That is the
 * point: it is a relocation of an existing guarantee to somewhere a stranger's
 * browser cannot get underneath it.
 */
function testTheAirframeCannotBeAskedToExceedItself(): void {
  section('Deflection is bounded by the airframe, not by the caller')

  function flownFor(ticks: number, c: Partial<Controls>): THREE.Quaternion {
    const bolts = createBolts()
    const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }
    const ship = new Ship(SHIPS.wasp, FACTION_PLAYER)
    ship.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
    ship.warpTimer = 0
    for (let i = 0; i < ticks; i++) ship.step(controls(c), STEP, ctx)
    const out = ship.quaternion.clone()
    bolts.dispose()
    ship.dispose()
    return out
  }

  const TICKS = 30
  const legal = flownFor(TICKS, { pitch: 1 })

  for (const [name, absurd] of [
    ['pitch', { pitch: 1000 }],
    ['yaw', { yaw: 1000 }],
    ['roll', { roll: 1000 }],
  ] as const) {
    const bounded = flownFor(TICKS, absurd)
    const reference = flownFor(TICKS, { [name]: 1 } as Partial<Controls>)
    check(
      `a wildly out-of-range ${name} turns no faster than full deflection`,
      bounded.angleTo(reference) < 1e-9,
      `${bounded.angleTo(reference)} rad apart`,
    )
  }

  // Guards the three above: if full deflection did nothing, they would all pass
  // by comparing one stationary hull against another.
  check(
    'full deflection actually turns the hull',
    legal.angleTo(new THREE.Quaternion()) > 0.5,
    `turned ${legal.angleTo(new THREE.Quaternion())} rad`,
  )

  // Negative side too — clamping only the upper bound is a classic half-fix.
  const under = flownFor(TICKS, { pitch: -1000 })
  const underRef = flownFor(TICKS, { pitch: -1 })
  check('the lower bound is clamped as well', under.angleTo(underRef) < 1e-9)

  /*
   * A value that is not a number is worse than one that is out of range, and
   * the ordinary clamp does not stop it: `Math.max`/`Math.min` propagate `NaN`.
   * It reaches the quaternion, the quaternion reaches the position, and nothing
   * later puts it back — so this flies poisoned ticks and then *honest* ones,
   * and asserts the hull recovered. Asserting only during the bad ticks would
   * miss the part that matters, which is that there is no way home.
   *
   * `undefined` is in the list because a missing field is the accidental route
   * to the same place: no malice needed, just a truncated packet.
   */
  function survives(label: string, c: Partial<Controls>): void {
    const bolts = createBolts()
    const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }
    const ship = new Ship(SHIPS.wasp, FACTION_PLAYER)
    ship.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
    ship.warpTimer = 0

    for (let i = 0; i < 5; i++) ship.step(controls(c), STEP, ctx)
    // Honest input again. A hull that cannot recover is out of the match.
    for (let i = 0; i < 5; i++) ship.step(controls({ throttle: 0.6 }), STEP, ctx)

    const finite =
      Number.isFinite(ship.position.x) &&
      Number.isFinite(ship.position.y) &&
      Number.isFinite(ship.position.z) &&
      Number.isFinite(ship.quaternion.w) &&
      Number.isFinite(ship.speed)
    check(
      `a hull survives ${label} and flies again`,
      finite,
      `pos=(${ship.position.x},${ship.position.y},${ship.position.z}) quat.w=${ship.quaternion.w} speed=${ship.speed}`,
    )
    bolts.dispose()
    ship.dispose()
  }

  survives('a NaN pitch', { pitch: NaN })
  survives('a NaN yaw', { yaw: NaN })
  survives('a NaN roll', { roll: NaN })
  survives('a NaN throttle', { throttle: NaN })
  survives('a missing pitch', { pitch: undefined as unknown as number })
  survives('a missing throttle', { throttle: undefined as unknown as number })

  /*
   * Infinity is a different problem from NaN and must still *clamp*, not be
   * zeroed. This assertion exists to catch one specific tidy-up: rewriting the
   * guard in `Ship`'s `clamp` as `Number.isFinite(v) ? … : 0`, which is the
   * obvious spelling and is wrong. It rejects infinities too, so it would take
   * an input the plain clamp already bounded correctly and silently neutralise
   * it — a regression hiding inside the hardening fix for a different one.
   *
   * That exact rewrite was proposed and this check is what caught it. If it is
   * ever the only failure in the suite, the guard has been "simplified".
   */
  const infinite = flownFor(TICKS, { pitch: Infinity })
  check('an infinite deflection clamps to full rather than to neutral', infinite.angleTo(legal) < 1e-9)
}

/**
 * `step` must not retain the struct it is handed.
 *
 * `Pilot` returns the same object every call rather than allocating sixty times
 * a second, so anything the game keeps a reference to is a live view of the
 * device, not a record of the tick. `game.ts` kept exactly that reference, and
 * the HUD read whatever the stick was doing later instead of what was flown.
 *
 * Harmless while `advance` and `step` are paired, and wrong the moment they are
 * not — which is every use phase B has for this: a host buffering `inputs[tick]`
 * would collect N aliases of one object and replay the last tick N times.
 */
function testStepDoesNotRetainCallerControls(): void {
  section('The simulation copies the controls it is handed')

  let reported = -1
  const hud = stubHud()
  hud.update = (state) => {
    reported = state.throttle
  }

  const game = createGame({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
    environment: stubEnvironment(),
    input: stubInput(),
    audio: silentAudio(),
    hud,
    bestScoreFor: () => 0,
    onEnd: () => {},
  })

  game.start({ ships: ['hornet'], seed: 0xa11a5 })

  // One mutable struct, reused — exactly what `Pilot` hands over.
  const shared = controls({ throttle: 0.9 })
  game.step([shared])

  // The producer moves on, as a pilot does every single tick.
  shared.throttle = 0.1
  shared.pitch = -1

  game.render(1, STEP)
  check(
    'the HUD reports the throttle that was flown, not the one since written',
    reported === 0.9,
    `reported ${reported}`,
  )

  /*
   * And the same rule for a seat nobody is drawing, which is where it gets
   * dangerous rather than merely wrong.
   *
   * The check above can only see the local seat, because the HUD is the only thing
   * that reads the recorded copy. A host holding a seat per participant and
   * retaining the struct each one handed it would collect N aliases and replay the
   * last tick for everybody — and with one seat and one HUD, exactly none of that
   * is observable. So both seats are handed *the same object*, which is the worst
   * case a wire produces: one decode buffer reused for every packet.
   */
  const shared2 = createGame({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
    environment: stubEnvironment(),
    input: stubInput(),
    audio: silentAudio(),
    hud: stubHud(),
    bestScoreFor: () => 0,
    onEnd: () => {},
  })
  shared2.start({ ships: ['hornet', 'wasp'], seed: 0xa11a5 })

  const one = controls({ throttle: 0.35 })
  const two = controls({ throttle: 0.85 })
  shared2.step([one, two])

  const flownBefore = [shared2.snapshot(0)?.throttle, shared2.snapshot(1)?.throttle]

  // Every producer moves on at once, and the array itself is recycled.
  one.throttle = 0.02
  two.throttle = 0.02
  const recycled = [one, two]
  recycled.length = 0

  check(
    'each seat kept its own flown throttle, not its producer',
    flownBefore[0] === 0.35 && flownBefore[1] === 0.85,
    `seat 0 ${flownBefore[0]}, seat 1 ${flownBefore[1]}`,
  )
  check(
    'and still does after every producer has been overwritten',
    shared2.snapshot(0)?.throttle === 0.35 && shared2.snapshot(1)?.throttle === 0.85,
    `seat 0 ${shared2.snapshot(0)?.throttle}, seat 1 ${shared2.snapshot(1)?.throttle}`,
  )
  // Guards both: two seats that shared one record would agree with each other,
  // and would satisfy either check above if the value they agreed on happened to
  // be the one being tested for.
  check(
    'the two seats do not share one record',
    shared2.snapshot(0)?.throttle !== shared2.snapshot(1)?.throttle,
    `both read ${shared2.snapshot(0)?.throttle}`,
  )

  shared2.dispose()
}

/* -------------------------------------------------------------------------- */
/* The roster                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Drives a seat from its own snapshot: the same proportional autopilot the
 * single-seat checks use, one per seat.
 *
 * Per seat rather than shared, because a `Pilot` integrates throttle across
 * ticks — sharing one would make both seats fly the same commanded throttle and
 * quietly hide a game that wired every seat to the same intent.
 */
interface SeatPilot {
  device: Input & { write: InputState }
  pilot: Pilot
}

function seatPilots(count: number): SeatPilot[] {
  return Array.from({ length: count }, () => ({ device: stubInput(), pilot: createPilot() }))
}

/** One tick: aim every seat at its own locked target, then step them together. */
/** Point a device at a bearing, or fly straight and fast when there is none. */
function steer(device: Input & { write: InputState }, t: RunSnapshot['target']): void {
  if (t) {
    device.write.pitch = clampTo(t.pitch * 3, -1, 1)
    device.write.yaw = clampTo(t.yaw * 3, -1, 1)
    device.write.fire = Math.abs(t.pitch) < 0.35 && Math.abs(t.yaw) < 0.35
    device.write.throttleUp = t.range > 260
    device.write.throttleDown = t.range < 170
  } else {
    device.write.pitch = 0
    device.write.yaw = 0
    device.write.fire = false
    device.write.throttleUp = true
    device.write.throttleDown = false
  }
}

function flyAll(game: Game, crew: SeatPilot[], intents: Controls[]): void {
  for (let i = 0; i < crew.length; i++) {
    steer(crew[i].device, game.snapshot(i)?.target ?? null)
    intents[i] = crew[i].pilot.advance(crew[i].device.state, STEP)
  }
  game.step(intents)
}

function newMatch(deps: Partial<GameDeps> = {}): Game {
  return createGame({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
    environment: stubEnvironment(),
    input: stubInput(),
    audio: silentAudio(),
    hud: stubHud(),
    bestScoreFor: () => 0,
    onEnd: () => {},
    ...deps,
  })
}

/**
 * Everything a seat's simulation owns, as one comparable string.
 *
 * `position` is in here for a reason worth keeping: without it, two runs can agree
 * on every outcome — hull, score, kills, speed — while flying entirely different
 * fights, because a hull that has not been hit reads the same wherever it is. A
 * mutation that pointed the whole squadron at the drawn seat instead of the
 * nearest one survived this fingerprint until position was part of it.
 */
function seatPrint(game: Game, at: number): string {
  const r = game.snapshot(at)
  if (!r) return 'none'
  return [
    r.seat,
    r.score,
    r.kills,
    r.shotsFired,
    r.hull,
    r.speed,
    r.deaths,
    r.phase,
    r.enemiesAirborne,
    r.position.x,
    r.position.y,
    r.position.z,
  ].join('/')
}

function matchPrint(game: Game): string {
  const lines: string[] = []
  for (let i = 0; i < game.seatCount; i++) lines.push(seatPrint(game, i))
  return lines.join(' | ')
}

/**
 * Fly a match and return the last print taken while it still had seats.
 *
 * The guard is `finish`, which calls `clearArena` — so the tick that resolves a
 * match is also the tick `snapshot` starts returning null and `seatCount` drops to
 * zero. Reading after the loop therefore compares either a crash or an *empty
 * string*, and two empty strings are equal, which is the whole trap: a check that
 * two matches agree passes perfectly on two matches that both vanished.
 *
 * This has now bitten three of the checks in this file, twice as a `TypeError`
 * that took the suite down at ok=247 of 280 and once as a mutant that stopped
 * being caught by an assertion and started being caught by a crash. So: sample
 * every tick, keep the last live one, and report how many ticks it survived so a
 * caller can put a floor under the comparison.
 */
interface Flown {
  /** The last print taken while the match still had seats. */
  print: string
  /** How many ticks ran before it resolved, or the full budget. */
  ticks: number
  /** Whether both seats shot at something and somebody's hull came down. */
  fought: boolean
  /** True if the match resolved before the budget ran out. */
  resolved: boolean
}

function flyMatch(game: Game, crew: SeatPilot[], ticks: number, hulls: number[]): Flown {
  const intents: Controls[] = []
  let print = ''
  let fought = false
  let ran = 0
  let resolved = false
  for (let i = 0; i < ticks; i++) {
    const views = crew.map((_, at) => game.snapshot(at))
    if (views.some((v) => v === null)) {
      resolved = true
      break
    }
    print = matchPrint(game)
    fought =
      fought ||
      (views.every((v) => v!.shotsFired > 0) && views.some((v, at) => v!.hull < hulls[at]))
    flyAll(game, crew, intents)
    ran = i + 1
  }
  return { print, ticks: ran, fought, resolved }
}

/**
 * Two humans in one arena, deterministic from one seed.
 *
 * This is the milestone's stated headless requirement, and the assertion that
 * earns its keep is the *crossed* one rather than any of the "both ships flew"
 * checks. A simulation that flew every seat on `intents[0]`, or on the local
 * seat's intent, or on `intents[i + 1]`, passes "both hulls moved" and "both hulls
 * fired" without complaint — every seat is flying *something*. Only swapping the
 * two intent streams and demanding the two outcomes swap with them says that a
 * seat is flying its own.
 */
function testTwoSeatsFlyOneArena(): void {
  section('Two seats fly one arena from one seed')

  const SEED = 0x2f00d

  /* ---- The roster exists, and only as far as it was asked to --------------- */

  const game = newMatch()
  game.start({ ships: ['hornet', 'wasp'], seed: SEED, respawn: true })

  check('the match reports its seat count', game.seatCount === 2, `${game.seatCount}`)
  check('seat 0 has a view', game.snapshot(0)?.seat === 0)
  check('seat 1 has a view', game.snapshot(1)?.seat === 1)
  check('a seat nobody sat in has none', game.snapshot(2) === null)
  check(
    'every view agrees how many seats there are',
    game.snapshot(0)?.seats === 2 && game.snapshot(1)?.seats === 2,
  )
  check(
    'the two seats fly the hulls they were dealt',
    game.snapshot(0)?.hull === SHIPS.hornet.maxHull &&
      game.snapshot(1)?.hull === SHIPS.wasp.maxHull,
    `${game.snapshot(0)?.hull} / ${game.snapshot(1)?.hull}`,
  )

  /* Launched apart, which the single-seat game never had to say. `PLAYER_SPAWN` is
     one point, and handing it to every seat puts two hulls inside each other at
     t=0 — mutually point-blank, indistinguishable on screen, and a collision the
     flight model does not model. Asserted at more than the sum of the two radii so
     it is about being *placed apart* rather than about not quite overlapping. */
  const zeroAt = game.snapshot(0)!.position
  const oneAt = game.snapshot(1)!.position
  const apartBy = Math.hypot(zeroAt.x - oneAt.x, zeroAt.y - oneAt.y, zeroAt.z - oneAt.z)
  check(
    'the two seats launch apart rather than inside each other',
    apartBy > SHIPS.hornet.radius + SHIPS.wasp.radius + 100,
    `${apartBy.toFixed(0)} units apart`,
  )

  const crew = seatPilots(2)
  const HULLS = [SHIPS.hornet.maxHull, SHIPS.wasp.maxHull]
  flyMatch(game, crew, Math.ceil(12 / STEP), HULLS)

  const first = game.snapshot(0)
  const second = game.snapshot(1)
  check('the match was still running to be measured', first !== null && second !== null,
    'it resolved before anything could be read')
  check('both seats fired', (first?.shotsFired ?? 0) > 0 && (second?.shotsFired ?? 0) > 0,
    `${first?.shotsFired} / ${second?.shotsFired}`)
  check('both seats are flying', (first?.speed ?? 0) > 0 && (second?.speed ?? 0) > 0,
    `${first?.speed.toFixed(0)} / ${second?.speed.toFixed(0)}`)
  check(
    'the two seats are not one seat drawn twice',
    seatPrint(game, 0) !== 'none' && seatPrint(game, 0) !== seatPrint(game, 1),
    seatPrint(game, 0),
  )
  game.dispose()

  /* ---- Determinism -------------------------------------------------------- */

  function fly(seed: number, throttles: [boolean, boolean]): string {
    const g = newMatch()
    g.start({ ships: ['hornet', 'wasp'], seed, respawn: true })
    const hands = throttles.map((up) => controls({ throttle: up ? 1 : 0 }))
    let print = ''
    for (let i = 0; i < Math.ceil(6 / STEP); i++) {
      if (!g.snapshot(0)) break
      print = matchPrint(g)
      g.step(hands)
    }
    g.dispose()
    return print
  }

  const a = fly(SEED, [true, false])
  const b = fly(SEED, [true, false])
  /* The length floor is the point rather than the padding: a resolved match has no
     seats, so `matchPrint` returns the empty string and two vanished matches
     compare equal. "Equal" must not be able to mean "both gone". */
  check('the same seed and the same intents give the same match', a.length > 0 && a === b,
    `${a}  vs  ${b}`)

  /* ---- The crossed check -------------------------------------------------- */

  /*
   * Seat 0 at full throttle and seat 1 at rest, then the other way round. Speeds
   * are the observable because throttle reaches `speed` and nothing else in the
   * tick does.
   *
   * A game that wired every seat to one intent gives the two seats equal speeds,
   * which fails the first check. A game that wired them to the *wrong* seat gives
   * unequal speeds — passing that — and then fails to swap, which is what the
   * second check is for. Both mutations were run; see the message on this commit.
   */
  const forward = newMatch()
  forward.start({ ships: ['hornet', 'hornet'], seed: SEED, respawn: true })
  const fast = controls({ throttle: 1 })
  const stopped = controls({ throttle: 0 })
  let fastFirst = [-1, -1]
  for (let i = 0; i < 240; i++) {
    const z = forward.snapshot(0)
    const o = forward.snapshot(1)
    if (!z || !o) break
    fastFirst = [z.speed, o.speed]
    forward.step([fast, stopped])
  }
  forward.dispose()

  const swapped = newMatch()
  swapped.start({ ships: ['hornet', 'hornet'], seed: SEED, respawn: true })
  let fastSecond = [-1, -1]
  for (let i = 0; i < 240; i++) {
    const z = swapped.snapshot(0)
    const o = swapped.snapshot(1)
    if (!z || !o) break
    fastSecond = [z.speed, o.speed]
    swapped.step([stopped, fast])
  }
  swapped.dispose()

  check(
    'a seat flies the intent supplied for it, not its neighbour’s',
    fastFirst[0] > fastFirst[1] + 100,
    `seat 0 ${fastFirst[0].toFixed(0)} u/s, seat 1 ${fastFirst[1].toFixed(0)} u/s`,
  )
  check(
    'swapping the two intent streams swaps the two outcomes',
    fastSecond[1] > fastSecond[0] + 100,
    `seat 0 ${fastSecond[0].toFixed(0)} u/s, seat 1 ${fastSecond[1].toFixed(0)} u/s`,
  )
  check(
    'and swapping them actually changed something',
    Math.abs(fastFirst[0] - fastSecond[0]) > 100,
    `seat 0 was ${fastFirst[0].toFixed(0)} u/s either way — the swap did nothing`,
  )
}

/**
 * `step` takes one intent per seat, and says so when it does not.
 *
 * The failure being refused is a `TypeError` several frames deep in the flight
 * model — `controls.fire` of `undefined` — which names neither the caller nor the
 * mismatch. A long array is the opposite mistake and just as worth hearing: a
 * caller that thinks the match has more seats than it does has lost track of the
 * roster, and silently ignoring the tail would let it keep believing that.
 */
function testStepNeedsOneIntentPerSeat(): void {
  section('The simulation takes one intent per seat')

  const game = newMatch()
  game.start({ ships: ['hornet', 'wasp'], seed: 0x5ea75 })

  function refuses(label: string, intents: Controls[]): void {
    let threw = false
    try {
      game.step(intents)
    } catch (e) {
      threw = e instanceof RangeError
    }
    check(`${label} is refused`, threw)
  }

  refuses('no intent at all', [])
  refuses('one intent for two seats', [controls()])
  refuses('three intents for two seats', [controls(), controls(), controls()])

  // The positive, wrapped, so a `step` that refused *everything* could not pass
  // the three negatives above unnoticed. That mutation reports here rather than
  // aborting the suite on the next line.
  let flew = false
  try {
    game.step([controls({ throttle: 0.5 }), controls({ throttle: 0.5 })])
    flew = true
  } catch {
    flew = false
  }
  check('one intent per seat is accepted', flew)
  check(
    'and the accepted tick actually simulated',
    (game.snapshot(0)?.throttle ?? -1) === 0.5,
    `flew throttle ${game.snapshot(0)?.throttle}`,
  )

  game.dispose()
}

/**
 * Which seat is being *drawn* cannot change what happens.
 *
 * The whole roster split rests on this one sentence, and it is the kind of claim
 * that is easy to assert vacuously — two runs of a simulation that ignored its
 * intents would also match. So the same seed and the same intents are flown twice
 * with a different seat presented, and a third run with different intents is
 * required to *differ*. Without that third run this check would pass against a
 * `step` that did nothing at all.
 *
 * It has already caught two real leaks, both found by writing it: the win bonus
 * was added to the drawn seat's score, and elimination ended the run when the
 * drawn seat died rather than when the arena emptied. Neither is visible with one
 * seat, and both would have shipped.
 */
function testPresentationCannotChangeTheMatch(): void {
  section('Which seat is drawn cannot change the match')

  const SEED = 0x10ca1

  /*
   * Flown by the autopilot rather than on fixed intents, which is the difference
   * between this check working and this check reading well.
   *
   * With both seats holding a constant throttle nobody hits anything in ten
   * seconds, so hull, score and kills are all still at their starting values and
   * the comparison is between two runs that barely happened. A mutation pointing
   * the whole squadron at the drawn seat instead of the nearest one passed exactly
   * that version. The autopilot closes the loop — each seat steers from its own
   * bearings — so a divergence anywhere feeds back into the controls and grows
   * rather than staying where it started.
   */
  const HULLS = [SHIPS.hornet.maxHull, SHIPS.wasp.maxHull]
  const TICKS = Math.ceil(25 / STEP)

  function fly(localSeat: number): Flown {
    const g = newMatch()
    g.start({ ships: ['hornet', 'wasp'], seed: SEED, local: localSeat, respawn: true })
    const flown = flyMatch(g, seatPilots(2), TICKS, HULLS)
    g.dispose()
    return flown
  }

  const drawnFirst = fly(0)
  const drawnSecond = fly(1)

  /* Three floors under the comparison, none of them a sanity check.

     Two inert runs match each other perfectly, so without `fought` this passes on
     a match in which nothing happened — which is how the first version let a real
     leak through. Two *resolved* runs both read as the empty string, so without
     the length floor "equal" can mean "both gone". And a match that ended early
     under one policy and not the other is a difference worth naming rather than
     absorbing. */
  check(
    'the match being compared was a real fight',
    drawnFirst.fought && drawnSecond.fought,
    `seat 0 view fought=${drawnFirst.fought}, seat 1 view fought=${drawnSecond.fought}`,
  )
  check(
    'and ran to the end rather than resolving out from under the comparison',
    !drawnFirst.resolved && !drawnSecond.resolved && drawnFirst.ticks === TICKS,
    `ran ${drawnFirst.ticks} and ${drawnSecond.ticks} of ${TICKS} ticks`,
  )
  check(
    'the same match watched from either seat is the same match',
    drawnFirst.print.length > 0 && drawnFirst.print === drawnSecond.print,
    `${drawnFirst.print}\n         vs ${drawnSecond.print}`,
  )

  const idled = newMatch()
  idled.start({ ships: ['hornet', 'wasp'], seed: SEED, respawn: true })
  const still = controls({ throttle: 0 })
  let inert = ''
  for (let i = 0; i < TICKS; i++) {
    if (!idled.snapshot(0)) break
    inert = matchPrint(idled)
    idled.step([still, still])
  }
  idled.dispose()
  check(
    'and a different set of intents is a different match',
    inert.length > 0 && inert !== drawnFirst.print,
    'idle intents produced the same match as a fight — nothing is being simulated',
  )

  // An out-of-range `local` is presentation, so it is clamped rather than thrown:
  // a wrong-but-legal seat draws something, where an unbuilt one would leave every
  // HUD read undefined for the whole match. Contrast `humanFaction`, which throws,
  // because there is no stand-in for a participant.
  const clamped = newMatch()
  clamped.start({ ships: ['hornet', 'wasp'], seed: SEED, local: 9 })
  check('an out-of-range drawn seat is clamped, not fatal', clamped.snapshot() !== null)
  clamped.dispose()
}

/**
 * A stranger's packet is admitted, not trusted.
 *
 * Every field of `Controls` is checked for each of the three ways a claim can be
 * wrong — out of range, too fast, not a number — and the checks are against exact
 * values rather than "is in range", because the ramp has to agree with the
 * keyboard *byte for byte* or the local pilot and the wire drift apart on what one
 * tick of throttle means. The last block is that agreement, flown rather than
 * asserted.
 */
function testIntentIsAdmittedNotTrusted(): void {
  section('Intent is admitted, not trusted')

  const held = controls({ throttle: 0.6, pitch: 0.4, yaw: -0.2, roll: 1 })
  const out = controls()
  const admit = (raw: unknown): Controls => admitIntent(raw, held, STEP, out)

  /* Out of range is a cheat, and clamping it produces a legal ship. */
  check('a deflection of 7 is admitted as 1', admit({ pitch: 7 }).pitch === 1)
  check('a deflection of -Infinity is admitted as -1', admit({ yaw: -Infinity }).yaw === -1)
  check('a deflection in range is admitted exactly', admit({ roll: 0.25 }).roll === 0.25)

  /* Not a number is not a cheat, it is destruction, and it reads as neutral. */
  check('NaN pitch is admitted as 0', admit({ pitch: NaN }).pitch === 0)
  check('a string yaw is admitted as 0', admit({ yaw: 'left' }).yaw === 0)
  check('a missing roll is admitted as 0', admit({}).roll === 0)
  check('and none of those is NaN downstream', !Number.isNaN(admit({ pitch: NaN }).pitch))

  /* Too fast is the throttle cheat, and one tick can only move one tick's worth. */
  const up = 0.6 + THROTTLE_UP_RATE * STEP
  const down = 0.6 - THROTTLE_DOWN_RATE * STEP
  check('a throttle snapped to 1 only ramps one tick up', admit({ throttle: 1 }).throttle === up,
    `got ${admit({ throttle: 1 }).throttle}, wanted ${up}`)
  check('a throttle snapped to 0 only ramps one tick down', admit({ throttle: 0 }).throttle === down,
    `got ${admit({ throttle: 0 }).throttle}, wanted ${down}`)
  check('a throttle of 5 ramps toward 1, not toward 5', admit({ throttle: 5 }).throttle === up)
  check('a throttle of -3 ramps toward 0, not toward -3', admit({ throttle: -3 }).throttle === down)
  check('a throttle within reach is admitted exactly', admit({ throttle: 0.605 }).throttle === 0.605)
  check('a NaN throttle holds rather than stalls', admit({ throttle: NaN }).throttle === 0.6)
  check('a missing throttle holds rather than stalls', admit({}).throttle === 0.6)
  check('rampThrottle bounds a wanted value before ramping', rampThrottle(1, 9, STEP) === 1)

  /* Triggers are the literal `true` or nothing. */
  check('fire: true fires', admit({ fire: true }).fire === true)
  check("fire: 'yes' does not", admit({ fire: 'yes' }).fire === false)
  check('fire: 1 does not', admit({ fire: 1 }).fire === false)
  check('dash: true dashes', admit({ dash: true }).dash === true)
  check("dash: 'false' does not", admit({ dash: 'false' }).dash === false)

  /* Two fields never survive. */
  check('an aim override is dropped', admit({ aim: new THREE.Vector3(0, 0, -1) }).aim === null)
  check('a spread is zeroed', admit({ spread: 0.7 }).spread === 0)

  /* A late tick holds the last intent, except for the triggers. The held intent
     has both triggers *down*, or "dropped" and "held" would read the same. */
  held.fire = true
  held.dash = true
  for (const [label, late] of [['undefined', undefined], ['null', null], ['a number', 42]] as const) {
    const a = admit(late)
    check(
      `${label} in place of a packet holds the last deflection and throttle`,
      a.pitch === 0.4 && a.yaw === -0.2 && a.roll === 1 && a.throttle === 0.6,
      `got ${a.pitch}/${a.yaw}/${a.roll}/${a.throttle}`,
    )
    check(`and ${label} does not keep firing or dashing`, a.fire === false && a.dash === false)
  }

  held.fire = false
  held.dash = false

  /* Nothing in the packet is retained. */
  const packet = { pitch: 0.5, throttle: 0.6, fire: true }
  const admitted = admit(packet)
  packet.pitch = -1
  packet.fire = false
  check('the admitted intent is not the packet', (admitted as unknown) !== packet)
  check('and changing the packet afterwards changes nothing', admitted.pitch === 0.5 && admitted.fire)

  /* `bound` is the one rule and `Ship` uses it too: it must keep Infinity. */
  check('bound keeps a request for infinity as the limit', bound(Infinity, -1, 1) === 1)
  check('bound reads a non-number as 0', bound('1', -1, 1) === 0 && bound(undefined, 0, 1) === 0)

  /* The keyboard and the wire agree byte for byte, flown for 80 ticks. */
  const device = stubInput()
  const pilot = createPilot()
  const wire = controls({ throttle: pilot.advance(device.state, 0).throttle })
  const scratch = controls()
  let agreed = 0
  let disagreed = ''
  let peak = 0
  for (let i = 0; i < 80; i++) {
    const wanted = i < 40 ? 1 : 0
    device.write.throttleUp = wanted === 1
    device.write.throttleDown = wanted === 0
    const key = pilot.advance(device.state, STEP).throttle
    const packet = admitIntent({ throttle: wanted }, wire, STEP, scratch).throttle
    wire.throttle = packet
    peak = Math.max(peak, packet)
    if (key === packet) agreed++
    else if (!disagreed) disagreed = `tick ${i}: keyboard ${key}, wire ${packet}`
  }
  check('a keyboard ramp and an admitted ramp agree on every tick', agreed === 80, disagreed)
  // Forty ticks up from 0.6 reaches 1; forty ticks down from 1 lands short of
  // where it started. Both have to have happened for the agreement to mean
  // anything — two ramps that never moved would agree perfectly too.
  check('and the ramp actually moved, up to 1 and back below launch', peak === 1 && wire.throttle < 0.6,
    `peaked at ${peak}, ended at ${wire.throttle}`)

  /* A ramp arrives exactly, and never overshoots. */
  const climb = controls({ throttle: 0 })
  let reachedAt = -1
  let overshot = false
  for (let i = 0; i < 120; i++) {
    climb.throttle = admitIntent({ throttle: 1 }, climb, STEP, scratch).throttle
    if (climb.throttle > 1) overshot = true
    if (climb.throttle === 1 && reachedAt < 0) reachedAt = i + 1
  }
  const expectedTicks = Math.ceil(1 / (THROTTLE_UP_RATE * STEP))
  check('a snapped throttle arrives at exactly 1 after a full ramp', reachedAt === expectedTicks,
    `reached at tick ${reachedAt}, wanted ${expectedTicks}`)
  check('and never overshoots it', !overshot)
}

/**
 * A seat shoots along its nose, whatever its intent says about `aim`.
 *
 * Flown rather than asserted on a field: the same seeded match is run twice, once
 * clean and once with seat 0's every intent carrying a fire-direction override and
 * a wide spread, and the two fights must be *identical* — including the RNG, which
 * a positive spread would draw from. The third run turns seat 0's guns off and must
 * differ, or the decoration was never reaching the game and the equality above is
 * between two runs of the same thing.
 */
function testASeatShootsAlongItsNose(): void {
  section('A seat shoots along its nose, whatever its intent says')

  const SEED = 0xa1a1
  const HULLS = [SHIPS.hornet.maxHull, SHIPS.wasp.maxHull]
  const TICKS = Math.ceil(25 / STEP)
  const backward = new THREE.Vector3(0, 0, -1)

  function fly(decorate: (intent: Controls) => void): Flown {
    const game = newMatch()
    game.start({ ships: ['hornet', 'wasp'], seed: SEED, respawn: true })
    const crew = seatPilots(2)
    const intents: Controls[] = []
    const decorated = controls()
    let print = ''
    let fought = false
    let ran = 0
    let resolved = false
    for (let i = 0; i < TICKS; i++) {
      const views = crew.map((_, at) => game.snapshot(at))
      if (views.some((v) => v === null)) {
        resolved = true
        break
      }
      print = matchPrint(game)
      fought =
        fought ||
        (views.every((v) => v!.shotsFired > 0) && views.some((v, at) => v!.hull < HULLS[at]))
      for (let at = 0; at < crew.length; at++) {
        const { device } = crew[at]
        const t = views[at]!.target
        if (t) {
          device.write.pitch = clampTo(t.pitch * 3, -1, 1)
          device.write.yaw = clampTo(t.yaw * 3, -1, 1)
          device.write.fire = Math.abs(t.pitch) < 0.35 && Math.abs(t.yaw) < 0.35
          device.write.throttleUp = t.range > 260
          device.write.throttleDown = t.range < 170
        } else {
          device.write.pitch = 0
          device.write.yaw = 0
          device.write.fire = false
          device.write.throttleUp = true
          device.write.throttleDown = false
        }
        intents[at] = crew[at].pilot.advance(device.state, STEP)
      }
      Object.assign(decorated, intents[0])
      decorate(decorated)
      intents[0] = decorated
      game.step(intents)
      ran = i + 1
    }
    game.dispose()
    return { print, ticks: ran, fought, resolved }
  }

  const clean = fly(() => {})
  const overridden = fly((c) => {
    c.aim = backward
    c.spread = 0.5
  })
  const disarmed = fly((c) => {
    c.fire = false
  })

  check('the match being compared was a real fight', clean.fought && overridden.fought,
    `clean fought=${clean.fought}, overridden fought=${overridden.fought}`)
  check('and ran to the end', !clean.resolved && !overridden.resolved && clean.ticks === TICKS,
    `ran ${clean.ticks} and ${overridden.ticks} of ${TICKS}`)
  check(
    'an aim override and a spread on a seat change nothing about the fight',
    clean.print.length > 0 && clean.print === overridden.print,
    `${clean.print}\n         vs ${overridden.print}`,
  )
  check(
    'but the decoration does reach the game: turning the guns off is a different fight',
    disarmed.print.length > 0 && disarmed.print !== clean.print,
    'a disarmed seat produced the same match as an armed one — the decoration is not being flown',
  )
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function shipStateFixture(seed: number): ShipState {
  const f = (n: number) => Math.fround(seed * 1.37 + n * 0.731 - 3.5)
  return {
    position: { x: f(1), y: f(2), z: f(3) },
    quaternion: { x: f(4), y: f(5), z: f(6), w: f(7) },
    velocity: { x: f(8), y: f(9), z: f(10) },
    speed: f(11),
    hull: f(12),
    throttle: f(13),
    alive: seed % 2 === 0,
    warpTimer: f(14),
    flash: f(15),
    sinceHit: f(16),
    heat: f(17),
    heatLocked: f(18),
    dashTimer: f(19),
    dashCooldown: f(20),
    overdriveTimer: f(21),
    shieldTimer: f(22),
    solarExposure: f(23),
    shotsFired: seed * 97,
  }
}

/**
 * The snapshot codec is total: every field goes out and comes back.
 *
 * A hand-built snapshot with every enumeration exercised — all three phases, all
 * three lock kinds, a bolt in the last slot, a negative score — is encoded and
 * decoded and must come back *deeply equal*, and the decoded copy must re-encode
 * to the same bytes. Values are already float32 so the equality is exact rather
 * than "close", which is what lets a dropped or reordered field be a hard failure.
 */
function testTheWorldSurvivesTheWire(): void {
  section('The world survives the wire')

  const world: WorldSnapshot = {
    tick: 0xfffffffe,
    seed: 0xdeadbeef,
    elapsed: Math.fround(123.456),
    active: true,
    paused: true,
    queued: 5,
    seats: [
      {
        ship: shipStateFixture(2),
        score: -1500,
        kills: 3,
        multiplier: Math.fround(2.5),
        hits: 77,
        deaths: 2,
        phase: 'wrecked',
        wreckTimer: Math.fround(0.42),
        throttle: Math.fround(0.77),
        ackTick: 123456,
        lock: { kind: 'squadron', id: 9 },
      },
      {
        ship: shipStateFixture(3),
        score: 0,
        kills: 0,
        multiplier: 1,
        hits: 0,
        deaths: 0,
        phase: 'eliminated',
        wreckTimer: 0,
        throttle: 0,
        ackTick: -1,
        lock: { kind: 'seat', index: 0 },
      },
      {
        ship: shipStateFixture(4),
        score: 2147483647,
        kills: 65535,
        multiplier: 1,
        hits: 4294967295,
        deaths: 65535,
        phase: 'flying',
        wreckTimer: 0,
        throttle: 1,
        ackTick: 0,
        lock: { kind: 'none' },
      },
    ],
    squadron: [
      { id: 9, spec: 'drone', ship: shipStateFixture(5) },
      { id: 0, spec: 'wasp', ship: shipStateFixture(6) },
    ],
    bolts: [
      {
        slot: 419,
        pos: { x: 1, y: -2, z: 3 },
        prev: { x: 0.5, y: -1.5, z: 2.5 },
        vel: { x: 100, y: 0, z: -900 },
        faction: FACTION_AI,
        color: { x: 1, y: Math.fround(0.3), z: 0 },
      },
      {
        slot: 0,
        pos: { x: 0, y: 0, z: 0 },
        prev: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        faction: humanFaction(2),
        color: { x: 0, y: 0, z: 0 },
      },
    ],
    pods: [
      { live: true, respawnIn: 0 },
      { live: false, respawnIn: Math.fround(12.5) },
    ],
    mines: [true, false, true],
  }

  const bytes = encodeSnapshot(world)
  let back: WorldSnapshot | null = null
  let decodeError = ''
  try {
    back = decodeSnapshot(bytes)
  } catch (e) {
    decodeError = String(e)
  }
  // A codec that cannot read its own output is the loudest possible failure,
  // and it has to be a *named* one: an uncaught throw here would end the suite
  // with every later check unrun, which the mutation gate counts as a gap.
  check('a snapshot decodes at all', back !== null, decodeError)
  // No early return: every check below still runs and fails by name when the
  // decode did not happen, so a broken codec cannot shorten the suite.
  const decoded = back !== null
  const b = back ?? { seats: [], bolts: [] }
  check('a snapshot decodes to an equal snapshot', decoded && JSON.stringify(back) === JSON.stringify(world))
  check('and re-encodes to the same bytes', decoded && sameBytes(encodeSnapshot(back!), bytes))
  check('the frame is not trivially small', bytes.length > 300, `${bytes.length} bytes`)

  // Every enumeration is on the wire, or the equality above proved less than it reads.
  check(
    'every phase and every lock kind was on the wire',
    decoded &&
      b.seats.map((x) => x.phase).join() === 'wrecked,eliminated,flying' &&
      b.seats.map((x) => x.lock.kind).join() === 'squadron,seat,none',
  )
  check(
    'the last bolt slot and a negative score came back',
    decoded && b.bolts[0]?.slot === 419 && b.seats[0]?.score === -1500,
  )
}

/**
 * A mirror that applies the host's snapshots *is* the host's match.
 *
 * Two games start the same `MatchSetup`. The host flies a real fight on the
 * autopilot; the mirror never calls `step`. Every tick the host's world is
 * captured, encoded, decoded and applied, and the mirror is then captured and
 * encoded again — and the two byte strings must be identical. That pins every
 * field in both directions at once: a field `apply` forgot to write comes back
 * as whatever the mirror had, and a field `capture` forgot to read is missing
 * from both and would be caught by the per-seat comparison that follows.
 *
 * The fight has to be real for any of that to mean anything, so the run must
 * have fought, the squadron must have warped in, bolts must have been in flight,
 * and the bytes must change over time. A forced death then walks the mirror
 * through a seat's whole wreck-and-respawn, because that is the one transition
 * `apply` has to *produce* rather than copy.
 */
function testAMirrorIsTheHostsMatch(): void {
  section("A mirror that applies the host's snapshots is the host's match")

  const SEED = 0x3a1e
  const setup = { ships: ['hornet', 'wasp'] as ShipId[], seed: SEED, respawn: true }
  const host = newMatch()
  const mirror = newMatch()
  host.start(setup)
  mirror.start(setup)

  const crew = seatPilots(2)
  const intents: Controls[] = []
  const TICKS = Math.ceil(25 / STEP)
  let mismatched = 0
  let firstMismatch = ''
  let boltsSeen = 0
  let squadronSeen = 0
  let fought = false
  let earlyBytes: Uint8Array | null = null
  let lateBytes: Uint8Array | null = null
  let seatDisagreed = ''
  let seatCompared = 0

  let resolvedEarly = -1
  let threw = ''
  for (let i = 0; i < TICKS; i++) {
    flyAll(host, crew, intents)
    if (!host.snapshot(0)) {
      resolvedEarly = i
      break
    }
    const hostBytes = encodeSnapshot(host.capture())
    try {
      mirror.apply(decodeSnapshot(hostBytes))
    } catch (e) {
      threw = `tick ${i}: ${String(e)}`
      break
    }
    mirror.render(1, STEP)
    const mirrorBytes = encodeSnapshot(mirror.capture())
    if (!sameBytes(hostBytes, mirrorBytes)) {
      mismatched++
      if (!firstMismatch) firstMismatch = `first at tick ${i}: ${hostBytes.length} vs ${mirrorBytes.length} bytes`
    }
    const world = decodeSnapshot(hostBytes)
    if (world.bolts.length > 0) boltsSeen++
    if (world.squadron.length > 0) squadronSeen++
    if (i === 60) earlyBytes = hostBytes
    if (i === TICKS - 1) lateBytes = hostBytes

    for (let at = 0; at < 2; at++) {
      const h = host.snapshot(at)
      const m = mirror.snapshot(at)
      if (!h || !m) continue
      seatCompared++
      if (h.hull < SHIPS[setup.ships[at]].maxHull) fought = true
      const agree =
        Math.abs(m.hull - h.hull) < 1e-3 &&
        Math.abs(m.speed - h.speed) < 0.05 &&
        m.throttle === Math.fround(h.throttle) &&
        m.overdrive === Math.fround(h.overdrive) &&
        m.shield === Math.fround(h.shield) &&
        m.solarExposure === Math.fround(h.solarExposure) &&
        m.score === h.score &&
        m.kills === h.kills &&
        m.deaths === h.deaths &&
        m.phase === h.phase &&
        m.shotsFired === h.shotsFired &&
        m.enemiesAirborne === h.enemiesAirborne &&
        m.enemiesQueued === h.enemiesQueued &&
        m.elapsed === Math.fround(h.elapsed) &&
        Math.abs(m.position.x - h.position.x) < 0.05 &&
        Math.abs(m.position.y - h.position.y) < 0.05 &&
        Math.abs(m.position.z - h.position.z) < 0.05 &&
        (h.target === null) === (m.target === null)
      if (!agree && !seatDisagreed) {
        seatDisagreed = `tick ${i} seat ${at}: host ${JSON.stringify(h)} mirror ${JSON.stringify(m)}`
      }
    }
  }

  check('the host match ran the whole budget', resolvedEarly < 0, `resolved at tick ${resolvedEarly}`)
  check('and no snapshot threw on the way to the mirror', threw === '', threw)
  check('the host fought a real fight', fought, 'no hull came down in 25 seconds')
  check('the squadron warped in on the wire', squadronSeen > 0)
  check('bolts were in flight on the wire', boltsSeen > 0)
  check(
    'the world changed over the run',
    earlyBytes !== null && lateBytes !== null && !sameBytes(earlyBytes, lateBytes),
    'the same bytes at tick 60 and at the end — nothing is being captured',
  )
  check(`the mirror re-encodes to the host's bytes on every tick (${TICKS})`, mismatched === 0, firstMismatch)
  check(`and every seat view agrees (${seatCompared} compared)`, seatDisagreed === '', seatDisagreed)
  check(
    'the mirror reports the squadron it was sent, not its own empty queue',
    (mirror.snapshot(0)?.enemiesQueued ?? -1) === (host.snapshot(0)?.enemiesQueued ?? -2),
  )

  host.dispose()
  mirror.dispose()

  /* A death, walked through the mirror. */
  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40
  const hostField = disarmedArena()
  const mirrorField = disarmedArena()
  const deathSetup = { ships: ['wasp', 'wasp'] as ShipId[], seed: 0x5a1d, local: 1, respawn: true }
  const h2 = newMatch({ environment: { ...stubEnvironment(), minefield: hostField } })
  const m2 = newMatch({ environment: { ...stubEnvironment(), minefield: mirrorField } })
  h2.start(deathSetup)
  m2.start(deathSetup)
  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.7 })]
  const phases: string[] = []
  let mirrorPhases = ''
  let deathMismatch = 0
  let mineWentDark = false
  for (let i = 0; i < 1800; i++) {
    if (i === 90) hostField.arm()
    h2.step(hands)
    if (!h2.snapshot(0)) break
    const bytes = encodeSnapshot(h2.capture())
    try {
      m2.apply(decodeSnapshot(bytes))
    } catch (e) {
      deathMismatch += 1000
      break
    }
    m2.render(1, STEP)
    if (!sameBytes(bytes, encodeSnapshot(m2.capture()))) deathMismatch++
    const phase = m2.snapshot(0)?.phase ?? 'gone'
    if (phases[phases.length - 1] !== phase) phases.push(phase)
    if (m2.capture().mines.some((live) => !live)) mineWentDark = true
    if (phase === 'flying' && phases.length >= 3) break
  }
  mirrorPhases = phases.join(' -> ')
  check('the mirror walked the seat through its death and back', mirrorPhases === 'flying -> wrecked -> flying', mirrorPhases)
  check('the death counted on the mirror', (m2.snapshot(0)?.deaths ?? 0) === 1)
  check('the mine that did it went dark on the mirror', mineWentDark)
  check("and the mirror's bytes matched the host's throughout", deathMismatch === 0, `${deathMismatch} mismatched ticks`)
  check('the mirror is drawing the returned seat', m2.dying === false && m2.snapshot(0)?.phase === 'flying')
  h2.dispose()
  m2.dispose()
  SHIPS.wasp.maxHull = originalHull
}

/**
 * Squadron hulls come and go by id, and a bad snapshot changes nothing.
 *
 * Hand-built rather than flown, because the retire path — a hull the host
 * stopped sending — is a transition a 25-second autopilot fight may not reach.
 */
function testHullsComeAndGoByIdAndBadFramesDoNothing(): void {
  section('Squadron hulls come and go by id; a bad frame changes nothing')

  const mirror = newMatch()
  mirror.start({ ships: ['hornet'], seed: 0x1d })
  const base = mirror.capture()
  const hull = (id: number, spec: ShipId) => ({ id, spec, ship: shipStateFixture(id + 10) })

  mirror.apply({ ...base, squadron: [hull(7, 'wasp'), hull(3, 'drone')], queued: 4 })
  check('two hulls sent, two airborne', mirror.snapshot()?.enemiesAirborne === 2)
  check('and the queue reported is the host\'s', mirror.snapshot()?.enemiesQueued === 4)
  const withTwo = mirror.capture()
  check('the mirror reports them by id', withTwo.squadron.map((x) => x.id).join() === '7,3')

  mirror.apply({ ...base, squadron: [hull(3, 'drone')], queued: 4 })
  check('a hull the host stopped sending is retired', mirror.snapshot()?.enemiesAirborne === 1)
  check('and the one that stayed kept its id', mirror.capture().squadron[0]?.id === 3)

  mirror.apply({ ...base, squadron: [hull(3, 'drone'), hull(8, 'wasp')], queued: 3 })
  check('a new id is a new hull', mirror.capture().squadron.map((x) => x.id).join() === '3,8')

  /* Locks resolve to the hull with that id. */
  const locked: WorldSnapshot = {
    ...base,
    squadron: [hull(3, 'drone'), hull(8, 'wasp')],
    seats: [{ ...base.seats[0], lock: { kind: 'squadron', id: 8 } }],
  }
  mirror.apply(locked)
  check('a lock on a squadron id resolves on the mirror', mirror.snapshot()?.target !== null)

  check('and captures back as the same id', JSON.stringify(mirror.capture().seats[0].lock) === '{"kind":"squadron","id":8}',
    `got ${JSON.stringify(mirror.capture().seats[0].lock)}`)

  /* Apply then capture is the identity, field by field. This is the asymmetric
     check: the flown comparison encodes the host and the mirror through the same
     `capture`, so a field `capture` never read would match on both sides. Here
     the input is hand-built, so a field `apply` never wrote *or* `capture` never
     read comes back different. */
  const hand: WorldSnapshot = {
    ...base,
    tick: 777,
    elapsed: Math.fround(9.25),
    paused: true,
    queued: 2,
    seats: [{ ...base.seats[0], ship: { ...shipStateFixture(20), alive: true }, score: 4321, kills: 6, multiplier: 3, hits: 40, deaths: 2, phase: 'flying', wreckTimer: 0, lock: { kind: 'none' } }],
    squadron: [hull(3, 'drone'), hull(8, 'wasp')],
    bolts: [
      { slot: 5, pos: { x: 1, y: 2, z: 3 }, prev: { x: 0, y: 1, z: 2 }, vel: { x: 9, y: 8, z: 7 }, faction: FACTION_AI, color: { x: 1, y: 0.5, z: 0 } },
      { slot: 419, pos: { x: -1, y: -2, z: -3 }, prev: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 1 }, faction: humanFaction(0), color: { x: 0, y: 1, z: 0 } },
    ],
  }
  mirror.apply(hand)
  const captured = mirror.capture()
  check('apply then capture is the identity', JSON.stringify(captured) === JSON.stringify(hand),
    `\n         ${JSON.stringify(captured)}\n      vs ${JSON.stringify(hand)}`)

  /* Bad frames. */
  const before = encodeSnapshot(mirror.capture())
  function refused(label: string, bytes: Uint8Array): void {
    let threw = false
    try {
      mirror.apply(decodeSnapshot(bytes))
    } catch (e) {
      threw = e instanceof RangeError
    }
    check(`${label} is refused with a RangeError`, threw)
  }
  refused('a truncated snapshot', before.slice(0, before.length - 7))
  refused('a snapshot with a tail', new Uint8Array([...before, 0]))
  const wrongVersion = before.slice()
  wrongVersion[0] = SNAPSHOT_VERSION + 1
  refused('a snapshot from another version', wrongVersion)
  refused('an empty frame', new Uint8Array(0))
  check('and none of them changed the mirror', sameBytes(encodeSnapshot(mirror.capture()), before))

  let rosterThrew = false
  try {
    mirror.apply({ ...base, seats: [] })
  } catch (e) {
    rosterThrew = e instanceof RangeError
  }
  check('a snapshot for a different roster is refused', rosterThrew)
  check('and changed nothing', sameBytes(encodeSnapshot(mirror.capture()), before))

  mirror.dispose()
}

/**
 * An intent frame ends in admission.
 *
 * The codec reads floats and a float can be anything, so the decoder's last
 * step is `admitIntent` and nothing that comes out has bypassed it. A `NaN`
 * written straight into the throttle bytes holds; a bad frame throws and leaves
 * `out` untouched.
 */
function testAnIntentFrameEndsInAdmission(): void {
  section('An intent frame ends in admission')

  const held = controls({ throttle: 0.5 })
  const out = controls({ pitch: 0.123 })
  const sent = controls({ pitch: 0.25, yaw: -1, roll: 1, throttle: 0.51, fire: true, dash: true })
  const bytes = encodeIntent(2, 4242, sent)
  check('an intent frame is fixed-size', bytes.length === INTENT_FRAME_BYTES, `${bytes.length}`)

  const frame = decodeIntent(bytes, held, STEP, out)
  check('seat and tick come back', frame.seat === 2 && frame.tick === 4242)
  check(
    'the controls come back through admission',
    out.pitch === 0.25 && out.yaw === -1 && out.roll === 1 && out.throttle === Math.fround(0.51) && out.fire && out.dash,
    JSON.stringify(out),
  )
  check('the decoded intent is the out struct, not a fresh one', frame.controls === out)

  // NaN in the throttle bytes: offset 1 + 1 + 4 + 3 floats.
  const poisoned = bytes.slice()
  new DataView(poisoned.buffer).setFloat32(6 + 12, NaN, true)
  decodeIntent(poisoned, held, STEP, out)
  check('a NaN throttle on the wire holds the last throttle', out.throttle === 0.5, `${out.throttle}`)

  const snapped = encodeIntent(0, 1, controls({ throttle: 1 }))
  decodeIntent(snapped, held, STEP, out)
  check('a snapped throttle on the wire is ramped', out.throttle === 0.5 + THROTTLE_UP_RATE * STEP, `${out.throttle}`)

  const before = JSON.stringify(out)
  function refused(label: string, frame: Uint8Array): void {
    let threw = false
    try {
      decodeIntent(frame, held, STEP, out)
    } catch (e) {
      threw = e instanceof RangeError
    }
    check(`${label} is refused with a RangeError`, threw)
  }
  refused('a short intent frame', bytes.slice(0, bytes.length - 1))
  refused('a long intent frame', new Uint8Array([...bytes, 0]))
  const wrong = bytes.slice()
  wrong[0] = INTENT_VERSION + 1
  refused('an intent frame from another version', wrong)
  check('and none of them wrote to out', JSON.stringify(out) === before)
}

/**
 * A match over a wire.
 *
 * Host and client are two `Game`s joined by a loopback. Over a perfect wire the
 * client's world must be the host's world, byte for byte, on every tick — and
 * the client's stick must actually be flying seat 1 on the host, which is
 * proved by a second host whose seat 1 hears nothing and fights differently.
 */
function testAMatchCrossesTheWire(): void {
  section('A match crosses the wire')

  const SEED = 0x7a1e
  const TICKS = Math.ceil(25 / STEP)

  function fly(connected: boolean) {
    const hostGame = newMatch()
    const clientGame = newMatch()
    const host = createHost({ game: hostGame, setup: { ships: ['hornet', 'wasp'], seed: SEED, respawn: true } })
    host.start()
    const wire = createLoopback()
    let welcomed = -1
    // A mirror, not a predictor: this test is about the world crossing the wire.
    const client = createClient({ game: clientGame, channel: wire.b, predict: false, onWelcome: (s) => (welcomed = s) })
    const seat = connected ? host.accept(wire.a) : -2
    wire.pump()

    const hostDevice = stubInput()
    const hostPilot = createPilot()
    const clientDevice = stubInput()
    const clientPilot = createPilot()
    let mismatched = 0
    let first = ''
    let fought = false
    for (let i = 0; i < TICKS; i++) {
      steer(hostDevice, hostGame.snapshot(0)?.target ?? null)
      steer(clientDevice, clientGame.snapshot(1)?.target ?? null)
      client.tick(clientPilot.advance(clientDevice.state, STEP))
      host.tick(hostPilot.advance(hostDevice.state, STEP))
      wire.pump()
      if (connected && i > 0) {
        const h = encodeSnapshot(hostGame.capture())
        const c = encodeSnapshot(clientGame.capture())
        if (!sameBytes(h, c)) {
          mismatched++
          if (!first) first = `first at tick ${i}`
        }
      }
      const s1 = hostGame.snapshot(1)
      if (s1 && s1.hull < SHIPS.wasp.maxHull) fought = true
    }
    const print = matchPrint(hostGame)
    const result = { seat, welcomed, mismatched, first, fought, print, host, client, hostTick: client.hostTick }
    hostGame.dispose()
    clientGame.dispose()
    return result
  }

  const live = fly(true)
  check('the peer was handed seat 1', live.seat === 1 && live.welcomed === 1, `seat ${live.seat}, welcomed ${live.welcomed}`)
  check('the host fought a real fight', live.fought)
  check(`the client's world is the host's on every tick`, live.mismatched === 0, live.first)
  check('the client applied a snapshot for every host tick', live.hostTick === TICKS, `host tick ${live.hostTick} of ${TICKS}`)
  check('every intent was admitted and only the first tick was held', live.host.stats.admitted === TICKS && live.host.stats.held <= 1,
    `admitted ${live.host.stats.admitted}, held ${live.host.stats.held}`)
  check('nothing was refused, stale or malformed on a perfect wire',
    live.host.stats.wrongSeat === 0 && live.host.stats.stale === 0 && live.host.stats.malformed === 0 && live.client.stats.stale === 0 && live.client.stats.malformed === 0,
    JSON.stringify(live.host.stats))

  const deaf = fly(false)
  check('a seat nobody is flying flies differently', deaf.print !== live.print, 'the client\'s stick changed nothing on the host')
}

/**
 * The wire is bad, and the match survives it.
 *
 * Thirty percent loss, a tick of latency, up to three ticks of jitter (which
 * reorders), and a tenth of frames duplicated. Nothing may throw; stale and
 * duplicated frames must be dropped *and counted*, so the numbers below are the
 * evidence the wire was actually bad; and whatever tick the client last
 * applied, its world must be the host's world *at that tick*.
 */
function testABadWireIsSurvived(): void {
  section('A bad wire is survived')

  const TICKS = Math.ceil(20 / STEP)
  const hostGame = newMatch()
  const clientGame = newMatch()
  const host = createHost({ game: hostGame, setup: { ships: ['hornet', 'wasp'], seed: 0xbad, respawn: true } })
  host.start()
  const wire = createLoopback({ loss: 0.3, latency: 1, jitter: 3, duplicate: 0.1, seed: 99 })
  const client = createClient({ game: clientGame, channel: wire.b, predict: false })
  host.accept(wire.a)
  // The hello or the welcome may be lost; the client keeps asking. Ticked with
  // the host idle so nothing about the match depends on how long that took.
  let waited = 0
  while (client.seat < 0 && waited < 600) {
    client.tick(controls())
    wire.pump()
    waited++
  }
  check('the welcome got through the bad wire because the client kept asking', client.seat === 1, `gave up after ${waited} ticks`)

  const hostDevice = stubInput()
  const hostPilot = createPilot()
  const clientDevice = stubInput()
  const clientPilot = createPilot()
  const history = new Map<number, Uint8Array>()
  let threw = ''
  let checkedAgainstHistory = 0
  let historyMismatch = 0
  for (let i = 0; i < TICKS; i++) {
    try {
      steer(hostDevice, hostGame.snapshot(0)?.target ?? null)
      steer(clientDevice, clientGame.snapshot(1)?.target ?? null)
      client.tick(clientPilot.advance(clientDevice.state, STEP))
      host.tick(hostPilot.advance(hostDevice.state, STEP))
      history.set(hostGame.capture().tick, encodeSnapshot(hostGame.capture()))
      wire.pump()
      const at = client.hostTick
      const expected = history.get(at)
      if (at >= 0 && expected) {
        checkedAgainstHistory++
        if (!sameBytes(expected, encodeSnapshot(clientGame.capture()))) historyMismatch++
      }
    } catch (e) {
      threw = `tick ${i}: ${String(e)}`
      break
    }
  }
  const h = host.stats
  const c = client.stats
  check('nothing threw', threw === '', threw)
  check('frames were actually lost', wire.lost > TICKS * 0.2, `${wire.lost} lost`)
  check('reordered snapshots were dropped as stale', c.stale > 0, `${c.stale}`)
  check('reordered or duplicated intents were dropped as stale', h.stale > 0, `${h.stale}`)
  check('lost intents were held, not zeroed', h.held > 0 && h.held < TICKS, `${h.held}`)
  check('most intents still got through', h.admitted > TICKS * 0.5, `${h.admitted} of ${TICKS}`)
  check('nothing was malformed or mis-seated', h.malformed === 0 && h.wrongSeat === 0 && c.malformed === 0, JSON.stringify({ h, c }))
  check(`the client's world is the host's world at whatever tick it last applied (${checkedAgainstHistory} ticks)`,
    checkedAgainstHistory > TICKS * 0.5 && historyMismatch === 0, `${historyMismatch} mismatched`)
  check('the client kept up', client.hostTick > TICKS - 40, `client at ${client.hostTick}, host at ${TICKS}`)
  hostGame.dispose()
  clientGame.dispose()
}

/**
 * Authorisation is by channel, not by claim; ticks only go forward; a full
 * match refuses; garbage never reaches the simulation.
 */
function testThePeerFliesItsOwnSeatOnly(): void {
  section('A peer flies its own seat only, once per tick, and garbage stops at the door')

  const hostGame = newMatch()
  const clientGame = newMatch()
  const host = createHost({ game: hostGame, setup: { ships: ['hornet', 'wasp'], seed: 0x5ea7 } })
  host.start()
  const wire = createLoopback()
  const client = createClient({ game: clientGame, channel: wire.b })
  host.accept(wire.a)
  wire.pump()

  const idle = controls({ throttle: 0.6 })
  const before = hostGame.snapshot(0)!.position

  // Forged: the client claims seat 0 with a hard turn.
  const forged = new Uint8Array([FRAME.INTENT, ...encodeIntent(0, 5000, controls({ pitch: 1, throttle: 1 }))])
  wire.b.send(forged)
  wire.pump()
  host.tick(idle)
  check('an intent for another seat is refused', host.stats.wrongSeat === 1 && host.stats.admitted === 0)
  // Seat 0 flew on `idle`, the host's own intent, and nothing else.
  const after = hostGame.snapshot(0)!.position
  check('and seat 0 flew straight on the host\'s own intent', Math.abs(after.y - before.y) < 1 && after.z !== before.z,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)

  // Replay: the same tick twice.
  const once = new Uint8Array([FRAME.INTENT, ...encodeIntent(1, 10, controls({ throttle: 1 }))])
  wire.b.send(once)
  wire.b.send(once)
  wire.pump()
  check('a replayed intent is dropped', host.stats.admitted === 1 && host.stats.stale === 1, JSON.stringify(host.stats))
  const older = new Uint8Array([FRAME.INTENT, ...encodeIntent(1, 9, controls({ throttle: 1 }))])
  wire.b.send(older)
  wire.pump()
  check('an intent for an earlier tick is dropped', host.stats.stale === 2)

  // Hold: seat 1's last admitted intent carries while nothing arrives. The
  // intent above ramped the throttle one tick toward 1; thirty idle ticks
  // later it must still be there, not back at launch throttle.
  host.tick(idle)
  const rampedTo = hostGame.snapshot(1)!.throttle
  for (let i = 0; i < 30; i++) host.tick(idle)
  check('a seat nothing arrives for holds its last intent', rampedTo > 0.6 && hostGame.snapshot(1)!.throttle === rampedTo,
    `ramped to ${rampedTo}, thirty idle ticks later ${hostGame.snapshot(1)!.throttle}`)
  check('and every one of those ticks was counted as held', host.stats.held >= 30, `${host.stats.held}`)

  // Garbage.
  wire.b.send(new Uint8Array([]))
  wire.b.send(new Uint8Array([FRAME.INTENT, 9, 9, 9]))
  wire.b.send(new Uint8Array([77, 1, 2]))
  wire.pump()
  check('garbage is counted and goes nowhere', host.stats.malformed === 3, `${host.stats.malformed}`)
  let stepped = true
  try {
    host.tick(idle)
  } catch {
    stepped = false
  }
  check('and the host keeps ticking', stepped)

  wire.pump()
  const appliedBefore = client.stats.applied
  wire.a.send(new Uint8Array([FRAME.SNAPSHOT, 1, 2, 3]))
  wire.a.send(new Uint8Array([200]))
  wire.pump()
  check('the client counts garbage too and applies nothing from it',
    client.stats.malformed === 2 && client.stats.applied === appliedBefore && appliedBefore > 0,
    JSON.stringify(client.stats))

  // Two seats, a second peer: refused, told, and closed.
  const second = createLoopback()
  let refused = false
  createClient({ game: newMatch(), channel: second.b, onRefused: () => (refused = true) })
  const seat = host.accept(second.a)
  second.pump()
  check('a peer with no seat to take is refused', seat === -1 && host.stats.refused === 1 && refused && !second.a.open,
    `seat ${seat}, refused ${refused}, open ${second.a.open}`)

  // A peer leaving frees its seat for the next.
  wire.a.close()
  const third = createLoopback()
  check('a seat freed by a leaving peer is handed to the next', host.accept(third.a) === 1)

  hostGame.dispose()
  clientGame.dispose()

  /* A lost welcome. The wire eats the first one; the client keeps asking. */
  const lossy = createLoopback({ loss: 1 })
  const lateGame = newMatch()
  const lateHost = createHost({ game: lateGame, setup: { ships: ['hornet', 'wasp'], seed: 0x1a7e } })
  lateHost.start()
  const lateClient = createClient({ game: newMatch(), channel: lossy.b })
  lateHost.accept(lossy.a)
  lossy.pump()
  lossy.setLoss(0)
  lossy.pump()
  check('the welcome was really lost', lateClient.seat === -1 && lossy.lost === 2, `seat ${lateClient.seat}, lost ${lossy.lost}`)
  let asked = 0
  while (lateClient.seat < 0 && asked < 200) {
    lateClient.tick(controls())
    lossy.pump()
    asked++
  }
  check('a client that keeps asking is welcomed again', lateClient.seat === 1 && asked > 1, `seat ${lateClient.seat} after ${asked} ticks`)
  lateGame.dispose()

  /* Welcome framing. */
  const w = decodeWelcome(encodeWelcome(1, { ships: ['drone', 'wasp'], seed: 0xabc, respawn: true }))
  check('a welcome round-trips', w.seat === 1 && w.setup.ships.join() === 'drone,wasp' && w.setup.seed === 0xabc && w.setup.respawn === true && w.setup.local === 1)
  let badSeat = false
  try {
    decodeWelcome(encodeWelcome(2, { ships: ['drone', 'wasp'], seed: 1 }))
  } catch (e) {
    badSeat = e instanceof RangeError
  }
  check('a welcome to a seat that does not exist is refused', badSeat)

  /* The URL decides the mode, and solo is the default the shipped game takes. */
  check('no query is solo', modeFromLocation('').kind === 'solo')
  check('?host hosts with a wasp in seat 1', JSON.stringify(modeFromLocation('?host')) === '{"kind":"host","guest":"wasp"}')
  check('?host=drone picks the guest hull', JSON.stringify(modeFromLocation('?host=drone')) === '{"kind":"host","guest":"drone"}')
  check('?join=abc123 joins, upper-cased', JSON.stringify(modeFromLocation('?join=abc123')) === '{"kind":"join","code":"ABC123"}')
}

/**
 * The stick is attached to the ship.
 *
 * A joined client flies its own hull the moment it moves the stick, and the
 * host's truth, when it arrives a few ticks later, lands exactly where the
 * prediction said — flight is deterministic, so on a perfect wire there is no
 * correction to make. Both halves are measured: every acknowledged intent's
 * host position against what the client predicted for that intent, and the
 * client's hull after each reconcile against its own latest prediction. The
 * contrast is a client with prediction off, whose hull trails the host by the
 * wire's latency — the round trip of lag this milestone exists to remove.
 */
function testTheStickIsAttachedToTheShip(): void {
  section('The stick is attached to the ship')

  const LATENCY = 3
  const TICKS = Math.ceil(15 / STEP)

  // Immortal for the duration: a death is a jump no prediction can foresee, and
  // it is not what is being measured here.
  const hulls = { hornet: SHIPS.hornet.maxHull, wasp: SHIPS.wasp.maxHull }
  SHIPS.hornet.maxHull = 1e6
  SHIPS.wasp.maxHull = 1e6

  function fly(predict: boolean) {
    const hostGame = newMatch()
    const clientGame = newMatch()
    const host = createHost({ game: hostGame, setup: { ships: ['hornet', 'wasp'], seed: 0x9e11, respawn: true } })
    host.start()
    const wire = createLoopback({ latency: LATENCY })
    const client = createClient({ game: clientGame, channel: wire.b, predict })
    host.accept(wire.a)
    for (let i = 0; i <= LATENCY; i++) wire.pump()

    const hostDevice = stubInput()
    const hostPilot = createPilot()
    const clientDevice = stubInput()
    const clientPilot = createPilot()
    const predicted = new Map<number, { x: number; y: number; z: number }>()
    let acked = 0
    let ackMismatch = 0
    let worstAck = 0
    let reconciled = 0
    let worstReconcile = 0
    let lagSum = 0
    let lagSamples = 0
    let lastAck = -1
    let moved = 0
    /** The host's truth for seat 1, by the intent tick it was flown on. */
    const truth = new Map<number, { x: number; y: number; z: number }>()

    for (let i = 0; i < TICKS; i++) {
      steer(hostDevice, hostGame.snapshot(0)?.target ?? null)
      steer(clientDevice, clientGame.snapshot(1)?.target ?? null)
      const sent = client.stats.sent
      const before = clientGame.snapshot(1)!.position
      client.tick(clientPilot.advance(clientDevice.state, STEP))
      const after = clientGame.snapshot(1)!.position
      if (Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > 0.01) moved++
      predicted.set(sent, after)
      host.tick(hostPilot.advance(hostDevice.state, STEP))
      const flown = hostGame.capture().seats[1]
      if (flown.ackTick >= 0) truth.set(flown.ackTick, flown.ship.position)
      wire.pump()

      const view = clientGame.capture().seats[1]
      const ack = view.ackTick
      if (ack > lastAck && view.phase === 'flying') {
        lastAck = ack
        const p = predicted.get(ack)
        const t = truth.get(ack)
        if (p && t && acked++ >= LATENCY + 2) {
          // The first few intents were flown after a warm-up of held ticks the
          // client could not have known about; from the first reconcile on,
          // every prediction is built on the host's truth and must land on it.
          const d = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z)
          worstAck = Math.max(worstAck, d)
          if (d > 0.1) ackMismatch++
        }
        // Where the hull is now, against the latest prediction made for it.
        const now = clientGame.snapshot(1)!.position
        const latest = predicted.get(sent)!
        const lag = Math.hypot(now.x - latest.x, now.y - latest.y, now.z - latest.z)
        reconciled++
        worstReconcile = Math.max(worstReconcile, lag)
        lagSum += lag
        lagSamples++
      }
    }
    const result = { acked, ackMismatch, worstAck, reconciled, worstReconcile, meanLag: lagSamples ? lagSum / lagSamples : -1, moved, unacked: client.unacknowledged }
    hostGame.dispose()
    clientGame.dispose()
    return result
  }

  const on = fly(true)
  const off = fly(false)
  SHIPS.hornet.maxHull = hulls.hornet
  SHIPS.wasp.maxHull = hulls.wasp
  // Not every tick: two autopilots chasing each other throttle down inside 170
  // units and can sit nose to nose. Most of the run, though.
  check('the predicted hull moved on the stick', on.moved > TICKS * 0.8, `${on.moved} of ${TICKS}`)
  check('the host acknowledged intents throughout', on.acked > TICKS * 0.8, `${on.acked}`)
  check(`the host's truth landed where the client predicted, every time (${on.acked})`, on.ackMismatch === 0,
    `${on.ackMismatch} off by more than 0.1; worst ${on.worstAck.toFixed(3)}`)
  check('and after every reconcile the hull sits on its own latest prediction', on.worstReconcile < 0.1,
    `worst ${on.worstReconcile.toFixed(3)}`)
  check('the replay window is the wire latency, not the whole history', on.unacked >= 1 && on.unacked <= LATENCY + 2, `${on.unacked}`)

  check('without prediction the hull does not move on the stick', off.moved < TICKS, `${off.moved} of ${TICKS}`)
  check('and trails the host by the wire latency', off.meanLag > 5 && off.meanLag > on.meanLag * 20,
    `mean lag ${off.meanLag.toFixed(2)} units unpredicted, ${on.meanLag.toFixed(3)} predicted`)

  /* predict and reconcile refuse what they cannot fly, quietly. */
  const solo = newMatch()
  // A wasp: no heat quirk, so a long burst cannot lock the guns and turn the
  // "no bolt" result below into a vacuous one.
  solo.start({ ships: ['wasp'], seed: 1 })
  const p0 = solo.snapshot(0)!.position
  let threw = false
  try {
    solo.predict(1, controls({ throttle: 1 }))
    solo.predict(-1, controls())
    solo.reconcile(4, [controls()])
    solo.predict(0, controls({ pitch: 1, throttle: 1 }))
  } catch {
    threw = true
  }
  const p1 = solo.snapshot(0)!.position
  check('a seat that does not exist is not predicted, and nothing throws', !threw)
  check('a seat that does is', p1.z !== p0.z || p1.y !== p0.y)

  // Guns into nothing: a predicted shot must leave the bolt pool empty, or the
  // host's next restore would flicker it out and the truth re-fire it later.
  // Past the warp-in first: a hull cannot fire for its first 0.85 s, and a
  // burst shorter than that would prove nothing either way.
  for (let i = 0; i < 120; i++) solo.predict(0, controls({ fire: true, throttle: 1 }))
  const predictedBolts = solo.capture().bolts.length
  const shotsPredicted = solo.snapshot(0)!.shotsFired
  for (let i = 0; i < 30; i++) solo.step([controls({ fire: true, throttle: 1 })])
  const steppedBolts = solo.capture().bolts.length
  check('the predicted trigger was actually pulled', shotsPredicted > 0, `${shotsPredicted} shots`)
  check('a predicted shot fires no bolt', predictedBolts === 0, `${predictedBolts} bolts in the pool`)
  check('while a stepped one does', steppedBolts > 0, `${steppedBolts}`)
  solo.dispose()
}

/**
 * Resolving a faction to a seat, which is the half of the guard that lives at the
 * caller.
 *
 * `humanFaction` refuses anything that is not a real roster index, and that is the
 * right call — there is no stand-in for a participant. But a guard that throws
 * makes its caller's error handling load-bearing, and the roster is the caller.
 * Damage arrives carrying a faction that may belong to nobody: the AI's, or the
 * arena blaming a mine on a side it invented.
 *
 * So resolution goes faction → seat, by lookup, returning nothing on a miss — and
 * never `humanFaction(seats.indexOf(...))`, which is the line that mints
 * `FACTION_AI` from an `indexOf` miss and puts a human on the NPC side. That
 * failure is the quiet kind: the human cannot shoot the filler and the filler
 * cannot shoot back, and it reads as an AI bug.
 */
function testAFactionResolvesToASeatOrToNobody(): void {
  section('A faction resolves to a seat, or to nobody')

  const seats = createSeats([SHIPS.hornet, SHIPS.wasp, SHIPS.drone], 0x5ea7)

  check('a seat per hull, in order', seats.length === 3)
  /* The identity the whole roster rests on, asserted over every seat rather than
     at one — the mistake this file has already recorded twice. A roster index and
     a faction are interchangeable *because* of this, which is what lets a seat be
     found by its faction at all. */
  let identity = true
  const minted: number[] = []
  for (let i = 0; i < seats.length; i++) {
    minted.push(seats[i].faction as unknown as number)
    if (seats[i].index !== i) identity = false
    if ((seats[i].faction as unknown as number) !== i) identity = false
  }
  check('seat i holds faction i', identity, minted.join(','))
  check('no two seats share a faction', new Set(minted).size === minted.length, minted.join(','))

  /* The lookup, both ways. */
  let resolvesToItself = true
  for (const seat of seats) {
    if (seatOf(seats, seat.faction) !== seat) resolvesToItself = false
  }
  check('every seat is found by its own faction', resolvesToItself)

  check('the AI faction belongs to nobody', seatOf(seats, FACTION_AI) === undefined)
  check(
    'a faction past the end of the roster belongs to nobody',
    seatOf(seats, humanFaction(7)) === undefined,
  )
  check('and the miss is reported as a miss, not as seat 0', seatOf(seats, FACTION_AI) !== seats[0])
  check('a faction inside the roster is not a miss', isParticipant(seats, humanFaction(2)))
  check('one outside it is', !isParticipant(seats, humanFaction(3)))

  /* A match with no seats has nothing to simulate, nothing to draw and no result
     to report, so it is refused where it is built rather than producing a game
     that is `active` and blank. Wrapped, so a `createSeats` that threw for *every*
     roster would report here instead of taking the process down. */
  let refusedEmpty = false
  try {
    createSeats([], 0)
  } catch (e) {
    refusedEmpty = e instanceof RangeError
  }
  check('a match with no seats is refused', refusedEmpty)

  let builtOne = false
  try {
    builtOne = createSeats([SHIPS.hornet], 0).length === 1
  } catch {
    builtOne = false
  }
  check('a match with one seat is not', builtOne)

  for (const seat of seats) seat.ship.dispose()
}

/**
 * A scoreline belongs to the seat that earned it.
 *
 * One global `score`, `kills`, `multiplier` and `playerHits` used to hold the run,
 * and with one human that was not a simplification — it was the truth. The failure
 * this replaces is not subtle: every seat reading one counter means every
 * participant shares a score, and the first PvP match would have shown four
 * identical numbers.
 *
 * Asserted by *crossing* rather than by running one match, because a game that
 * banked everything into seat 0 passes "the fighter scored" whenever the fighter
 * happens to be seat 0. Only making seat 1 do the fighting separates "the seat
 * that shot" from "the first seat".
 */
function testScoringIsPerSeat(): void {
  section('A scoreline belongs to the seat that earned it')

  const SEED = 0x5c0e

  /*
   * The fight is stacked, for the reason `testARunCanBeWon` explains at length: a
   * proportional autopilot against full enemy hulls scores hits and takes no
   * hostiles down — the recorded baseline shows exactly that, kills 0 across
   * twenty seconds on all three airframes. Hits alone would only exercise
   * `creditHit`; `creditKill` and the bounty are a separate path, and the one that
   * carries the multiplier, so the hulls come down until kills actually happen.
   *
   * Nothing about attribution depends on the stacking. It only makes the thing
   * being attributed occur.
   */
  const originalHulls = { wasp: SHIPS.wasp.maxHull, drone: SHIPS.drone.maxHull }
  const originalRadii = { wasp: SHIPS.wasp.radius, drone: SHIPS.drone.radius }
  SHIPS.wasp.maxHull = 12
  SHIPS.drone.maxHull = 12
  SHIPS.wasp.radius = 350
  SHIPS.drone.radius = 350

  /** `fighter` flies the autopilot; the other seat holds still and never fires. */
  function fight(fighter: number): { scores: number[]; kills: number[]; shots: number[] } {
    const game = newMatch()
    game.start({ ships: ['hornet', 'hornet'], seed: SEED, local: fighter, respawn: true })

    const device = stubInput()
    const pilot = createPilot()
    const idle = controls({ throttle: 0 })
    const hands: Controls[] = [idle, idle]

    /*
     * Sampled every tick and read from the last live sample, because the stacked
     * fight can *finish*: a cleared squadron is still the win condition, and
     * `finish` empties the roster, so reading the scoreline after the loop found
     * `snapshot(0)` null and took the whole suite down — ok=247 of 280 and a
     * `TypeError` where the summary should have been. The numbers being asserted
     * are the ones the seats ended the fight holding.
     */
    let scores: number[] = [0, 0]
    let kills: number[] = [0, 0]
    let shots: number[] = [0, 0]

    for (let i = 0; i < Math.ceil(25 / STEP); i++) {
      const zero = game.snapshot(0)
      const one = game.snapshot(1)
      if (!zero || !one) break
      scores = [zero.score, one.score]
      kills = [zero.kills, one.kills]
      shots = [zero.shotsFired, one.shotsFired]

      const t = game.snapshot(fighter)?.target ?? null
      if (t) {
        device.write.pitch = clampTo(t.pitch * 3, -1, 1)
        device.write.yaw = clampTo(t.yaw * 3, -1, 1)
        device.write.fire = Math.abs(t.pitch) < 0.35 && Math.abs(t.yaw) < 0.35
        device.write.throttleUp = t.range > 260
        device.write.throttleDown = t.range < 170
      } else {
        device.write.pitch = 0
        device.write.yaw = 0
        device.write.fire = false
        device.write.throttleUp = true
        device.write.throttleDown = false
      }
      hands[fighter] = pilot.advance(device.state, STEP)
      hands[1 - fighter] = idle
      game.step(hands)
    }

    game.dispose()
    return { scores, kills, shots }
  }

  const bySeatZero = fight(0)
  const bySeatOne = fight(1)

  SHIPS.wasp.maxHull = originalHulls.wasp
  SHIPS.drone.maxHull = originalHulls.drone
  SHIPS.wasp.radius = originalRadii.wasp
  SHIPS.drone.radius = originalRadii.drone

  check(
    'seat 0 doing the shooting scores for seat 0',
    bySeatZero.scores[0] > 0 && bySeatZero.shots[0] > 0,
    `score ${bySeatZero.scores[0]}, shots ${bySeatZero.shots[0]}`,
  )
  check(
    'and leaves seat 1 with nothing',
    bySeatZero.scores[1] === 0 && bySeatZero.kills[1] === 0 && bySeatZero.shots[1] === 0,
    `score ${bySeatZero.scores[1]}, kills ${bySeatZero.kills[1]}, shots ${bySeatZero.shots[1]}`,
  )
  check(
    'seat 1 doing the shooting scores for seat 1',
    bySeatOne.scores[1] > 0 && bySeatOne.shots[1] > 0,
    `score ${bySeatOne.scores[1]}, shots ${bySeatOne.shots[1]}`,
  )
  /* The discriminating one. A game that credited every hit to seat 0 — the old
     global wearing a seat's name — passes all three checks above and fails this. */
  check(
    'and leaves seat 0 with nothing',
    bySeatOne.scores[0] === 0 && bySeatOne.shots[0] === 0,
    `score ${bySeatOne.scores[0]}, kills ${bySeatOne.kills[0]}, shots ${bySeatOne.shots[0]}`,
  )
  check(
    'a kill is credited to whoever made it',
    bySeatZero.kills[0] > 0 && bySeatOne.kills[1] > 0,
    `seat 0 got ${bySeatZero.kills[0]}, seat 1 got ${bySeatOne.kills[1]}`,
  )
  check(
    'the enemy specs were restored',
    SHIPS.wasp.maxHull === originalHulls.wasp && SHIPS.wasp.radius === originalRadii.wasp,
  )
}

/**
 * A seat comes back while the rest of the arena carries on without pausing for it.
 *
 * The single-seat respawn check cannot see this: with one participant there is
 * nothing left flying to be interrupted, so "the match kept running" and "the seat
 * came back" are the same observation. Here the survivor is watched across the whole
 * of the other seat's cutscene, which is where the old global `dying` mode would
 * have frozen it.
 */
function testASeatRespawnsWhileTheOthersKeepFlying(): void {
  section('A seat respawns while the rest of the arena keeps flying')

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  const field = disarmedArena()
  let ended: RunResult | null = null
  const game = newMatch({
    environment: { ...stubEnvironment(), minefield: field },
    onEnd: (r) => {
      ended = r
    },
  })
  game.start({ ships: ['wasp', 'wasp'], seed: 0x5a1d, local: 1, respawn: true })

  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.7 })]
  const sequence = Math.round(DEATH_SEQUENCE / STEP)
  for (let i = 0; i < 90; i++) game.step(hands)
  field.arm()

  let survivorMoved = 0
  let survivorStalled = 0
  let deadSeatWrecked = 0
  let cameBack = false
  let survivorPosition = game.snapshot(1)!.position
  for (let i = 0; i < sequence + 120; i++) {
    const dead = game.snapshot(0)
    const alive = game.snapshot(1)
    if (!dead || !alive) break
    if (dead.phase === 'wrecked') {
      deadSeatWrecked++
      // The survivor has to still be advancing during the other seat's cutscene.
      const moved = Math.hypot(
        alive.position.x - survivorPosition.x,
        alive.position.y - survivorPosition.y,
        alive.position.z - survivorPosition.z,
      )
      if (moved > 0) survivorMoved++
      else survivorStalled++
    }
    if (deadSeatWrecked > 0 && dead.phase === 'flying') cameBack = true
    survivorPosition = alive.position
    game.step(hands)
  }

  check('the other seat was wrecked for its whole cutscene', deadSeatWrecked >= sequence,
    `${deadSeatWrecked} of ${sequence} ticks`)
  check('the survivor kept flying throughout it', survivorStalled === 0 && survivorMoved >= sequence,
    `${survivorMoved} ticks moving, ${survivorStalled} stalled`)
  check('the dead seat came back', cameBack, 'it never returned to flying')
  check('and the match never resolved', (ended as RunResult | null) === null,
    `reported won=${(ended as RunResult | null)?.won}`)
  check('the survivor is still in the match', game.snapshot(1)?.phase === 'flying')

  game.dispose()
  SHIPS.wasp.maxHull = originalHull
}

/**
 * Where a seat comes back is a function of the seed.
 *
 * The respawn point is the one gameplay draw this milestone added, and it draws from
 * its own substream so that a match in which somebody dies still spawns the same
 * squadron as one in which nobody does. Both halves are asserted: the same seed puts
 * a seat back in the same place, and a different seed does not — without the second,
 * a respawn hardcoded to one point would pass the first perfectly.
 */
function testARespawnPointReplaysFromItsSeed(): void {
  section('A respawn point replays from its seed')

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  function respawnPlace(seed: number): string {
    const field = disarmedArena()
    const game = newMatch({ environment: { ...stubEnvironment(), minefield: field } })
    game.start({ ships: ['wasp'], seed, respawn: true })
    const hands = [controls({ throttle: 0.3 })]
    for (let i = 0; i < 90; i++) game.step(hands)
    field.arm()
    let place = 'never respawned'
    let wasWrecked = false
    for (let i = 0; i < Math.round(DEATH_SEQUENCE / STEP) + 120; i++) {
      const seat = game.snapshot(0)
      if (!seat) break
      if (wasWrecked && seat.phase === 'flying') {
        const p = seat.position
        place = `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`
        break
      }
      if (seat.phase === 'wrecked') wasWrecked = true
      game.step(hands)
    }
    game.dispose()
    return place
  }

  const a = respawnPlace(0xbeef)
  const b = respawnPlace(0xbeef)
  const c = respawnPlace(0xfade)

  check('the seat did respawn somewhere', a !== 'never respawned', a)
  check('the same seed puts it back in the same place', a === b, `${a}  vs  ${b}`)
  check('a different seed does not', c !== 'never respawned' && a !== c, `${a}  vs  ${c}`)

  SHIPS.wasp.maxHull = originalHull
}

/**
 * Two scoring participants keep separate streaks and separate accuracy.
 *
 * `score` alone cannot show this — one shared counter split two ways looks the same
 * as two counters until you look at what feeds them. So the multiplier and the hit
 * count are asserted directly, and the multiplier is checked against *this seat's*
 * kills rather than merely being non-zero: a shared streak would give both seats the
 * same number while each had a different kill count.
 */
function testTwoScorersKeepSeparateStreaks(): void {
  section('Two scoring seats keep separate streaks and accuracy')

  const originalHulls = { wasp: SHIPS.wasp.maxHull, drone: SHIPS.drone.maxHull }
  const originalRadii = { wasp: SHIPS.wasp.radius, drone: SHIPS.drone.radius }
  SHIPS.wasp.maxHull = 12
  SHIPS.drone.maxHull = 12
  SHIPS.wasp.radius = 350
  SHIPS.drone.radius = 350

  const game = newMatch()
  game.start({ ships: ['hornet', 'hornet'], seed: 0x7ea, respawn: true })
  const crew = seatPilots(2)
  const intents: Controls[] = []

  let last: RunSnapshot[] = []
  for (let i = 0; i < Math.ceil(25 / STEP); i++) {
    const views = [game.snapshot(0), game.snapshot(1)]
    if (views.some((v) => v === null)) break
    last = views as RunSnapshot[]
    flyAll(game, crew, intents)
  }
  game.dispose()

  SHIPS.wasp.maxHull = originalHulls.wasp
  SHIPS.drone.maxHull = originalHulls.drone
  SHIPS.wasp.radius = originalRadii.wasp
  SHIPS.drone.radius = originalRadii.drone

  const [zero, one] = last
  check('both seats were still in the match to be read', last.length === 2, `${last.length} views`)
  check('both seats fired', (zero?.shotsFired ?? 0) > 0 && (one?.shotsFired ?? 0) > 0,
    `${zero?.shotsFired} / ${one?.shotsFired}`)
  check('both seats landed hits', (zero?.hits ?? 0) > 0 && (one?.hits ?? 0) > 0,
    `${zero?.hits} / ${one?.hits}`)
  check('both seats took kills', (zero?.kills ?? 0) > 0 && (one?.kills ?? 0) > 0,
    `${zero?.kills} / ${one?.kills}`)

  /* The streak is derived from *this* seat's kills. A shared multiplier gives both
     seats the same value, which fails here whenever their kill counts differ. */
  const expected = (kills: number) => Math.min(3, 1 + kills * 0.25)
  check(
    'each streak is built from its own seat’s kills',
    zero !== undefined &&
      one !== undefined &&
      zero.multiplier === expected(zero.kills) &&
      one.multiplier === expected(one.kills),
    `seat 0 ${zero?.multiplier} for ${zero?.kills} kills, seat 1 ${one?.multiplier} for ${one?.kills} kills`,
  )
  /* And the two scorelines are genuinely two. Guards the checks above against a
     game that credited everything to both seats. */
  check(
    'the two scorelines are not one scoreline read twice',
    zero !== undefined && one !== undefined &&
      (zero.hits !== one.hits || zero.score !== one.score || zero.shotsFired !== one.shotsFired),
    `seat 0 ${zero?.hits}/${zero?.score}/${zero?.shotsFired}, seat 1 ${one?.hits}/${one?.score}/${one?.shotsFired}`,
  )
  check(
    'accuracy is each seat’s own hits over its own shots',
    zero !== undefined && one !== undefined &&
      zero.hits <= zero.shotsFired && one.hits <= one.shotsFired,
    `seat 0 ${zero?.hits}/${zero?.shotsFired}, seat 1 ${one?.hits}/${one?.shotsFired}`,
  )
}

/**
 * What a participant shooting another participant is worth: nothing, yet.
 *
 * This pins a *gap*, deliberately, so that closing it is a decision rather than an
 * accident. Hits and bounties are credited against the AI squadron only — the
 * enemy ships are where `onDamaged` and `onDeath` do the crediting — so a bolt
 * that lands on another seat does damage and pays no points.
 *
 * That is milestone 8's to settle and not this one's, because the answer is a
 * number rather than a mechanism: `PLANS/NEON_ORBIT_PHASE_B.md` still has "AI kills
 * count for less than human kills" as an open question, and a human hull has no
 * bounty on its spec sheet to borrow. Inventing one here would be a balance
 * decision wearing a refactor's clothes.
 *
 * When milestone 8 does settle it, this check fails. That is the intent: it is a
 * note that has to be read, not a wall.
 */
function testShootingAParticipantScoresNothingYet(): void {
  section('Shooting another participant scores nothing yet — milestone 8')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts, localFaction: FACTION_PLAYER }

  const seats = createSeats([SHIPS.hornet, SHIPS.wasp], 0x5c0e2)
  const [alice, bob] = seats
  alice.ship.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  bob.ship.spawn(new THREE.Vector3(0, 0, -300), new THREE.Vector3(0, 0, -2000))
  settle([alice.ship, bob.ship], ctx)

  const line = [alice.ship, bob.ship]
  const before = bob.ship.hull
  for (let i = 0; i < 400 && bob.ship.hull === before; i++) {
    alice.ship.position.set(0, 0, 0)
    alice.ship.velocity.set(0, 0, 0)
    bob.ship.position.set(0, 0, -300)
    bob.ship.velocity.set(0, 0, 0)
    alice.ship.step(controls({ fire: true }), STEP, ctx)
    bolts.update(STEP, line, [])
  }

  check('a seat can shoot another seat', bob.ship.hull < before, `hull ${bob.ship.hull}/${before}`)
  check('the shooter fired', alice.ship.shotsFired > 0)
  check(
    'and the hit paid nothing — milestone 8 decides what a participant is worth',
    alice.score === 0 && alice.hits === 0,
    `score ${alice.score}, hits ${alice.hits}`,
  )

  bolts.dispose()
  for (const seat of seats) seat.ship.dispose()
}

/**
 * A HUD stub that records what the squadron looks like, not just where it is.
 *
 * `HudContact.accent` is the airframe's own colour, so the multiset of accents on
 * screen names *which hulls* are in the arena. That makes enemy identity directly
 * observable, which the outcome fingerprint only ever caught by luck: the squadron
 * being a function of the drawn seat diverged on six of seven seeds and was
 * invisible on the seventh, which is the one the check happened to use.
 */
function accentRecordingHud(): Hud & { accents: number[] } {
  const hud = stubHud() as Hud & { accents: number[] }
  hud.accents = []
  hud.updateContacts = (contacts) => {
    hud.accents = contacts.map((c) => c.accent).sort((a, b) => a - b)
  }
  return hud
}

/**
 * The squadron's accents, with the one participant contact removed.
 *
 * A contact is "anything airborne that is not me", so the *other seat* is on the
 * list too — and which seat that is depends on which one is drawn, by design. The
 * first version of the comparison below did not account for that and reported a
 * mismatch of exactly one entry on all eight seeds: the drawn seat's neighbour. That
 * was the check being wrong rather than the game, and the three squadron accents
 * underneath it were already identical, which is the fix working.
 *
 * Dropping one known accent rather than filtering all of them, because a seat may
 * legitimately fly the same hull an enemy flies and the count is what matters.
 */
function squadronAccents(accents: number[], participantAccent: number): number[] {
  const out = accents.slice()
  const at = out.indexOf(participantAccent)
  if (at >= 0) out.splice(at, 1)
  return out
}

/**
 * The squadron cannot be a function of who is watching.
 *
 * This is the leak BOLTy found in the claim this milestone is built on, and it is
 * worth being precise about how it survived: the check that was supposed to catch
 * it existed, compared the right things, and ran on **one seed** — which turned out
 * to be the single masking case out of seven. A hand-picked sample of a universal
 * property leaves gaps by construction, and the gap sits wherever the next mistake
 * lands. That sentence is already written down twice in this file, from PR #17.
 *
 * So: a contiguous range of seeds, and two independent observables. The accents say
 * *which hulls* the arena filled with, directly. The fingerprint says the fight
 * those hulls produced. Either alone has a hole — a squadron of the right hulls can
 * still fly a different fight, and a fingerprint can agree while the hulls differ,
 * which is exactly what happened at seed 0x10ca1.
 */
function testTheSquadronIsNotAFunctionOfTheWatcher(): void {
  section('The squadron is the same whoever is watching')

  // Two different hulls on purpose: with both seats on the same airframe,
  // `otherShips(drawn)` and `otherShips(seat 0)` are the same expression and the
  // bug this check exists for cannot appear at all.
  const ROSTER: ShipId[] = ['hornet', 'wasp']
  const NEIGHBOUR = [SHIPS.wasp.accent, SHIPS.hornet.accent]

  function arena(localSeat: number, seed: number): { accents: number[]; print: string } {
    const hud = accentRecordingHud()
    const g = newMatch({ hud })
    g.start({ ships: ROSTER.slice(), seed, local: localSeat, respawn: true })
    const hands = [controls({ throttle: 1, fire: true }), controls({ throttle: 0.4, fire: true })]
    let print = ''
    let accents: number[] = []
    for (let i = 0; i < Math.ceil(12 / STEP); i++) {
      if (!g.snapshot(0)) break
      print = matchPrint(g)
      g.step(hands)
      g.render(1, STEP)
      const squadron = squadronAccents(hud.accents, NEIGHBOUR[localSeat])
      if (squadron.length > accents.length) accents = squadron
    }
    g.dispose()
    return { accents, print }
  }

  const mismatchedHulls: string[] = []
  const mismatchedFights: string[] = []
  let sawHostiles = 0
  const SEEDS = 8
  for (let seed = 0; seed < SEEDS; seed++) {
    const a = arena(0, seed)
    const b = arena(1, seed)
    if (a.accents.length > 0) sawHostiles++
    if (a.accents.join(',') !== b.accents.join(',')) {
      mismatchedHulls.push(`0x${seed.toString(16)}: [${a.accents}] vs [${b.accents}]`)
    }
    if (a.print !== b.print || a.print.length === 0) {
      mismatchedFights.push(`0x${seed.toString(16)}`)
    }
  }

  /* The floor. Accents come from contacts, so a match in which no hostile ever
     appeared records none and every comparison above passes on two empty lists. */
  check(
    'hostiles actually reached the arena to be compared',
    sawHostiles === SEEDS,
    `hulls seen on ${sawHostiles} of ${SEEDS} seeds`,
  )
  check(
    `the arena fills with the same hulls from either seat, across ${SEEDS} seeds`,
    mismatchedHulls.length === 0,
    mismatchedHulls.join(' | '),
  )
  check(
    `and the fight those hulls produce is the same, across ${SEEDS} seeds`,
    mismatchedFights.length === 0,
    `diverged on ${mismatchedFights.join(', ')}`,
  )
}

/**
 * An eliminated seat is out, and stays out.
 *
 * The tick's rule is "a flying hull that is not alive starts its cutscene". When
 * elimination was represented by *clearing* the wreck, an eliminated seat matched
 * that rule again on the very next tick: `deaths` climbed 1, 2, 3 every 2.4 seconds
 * while the participant sat there dead, re-sealing the local result each time.
 * Reproduced at `deaths=3` before the fix.
 *
 * The reason it went unnoticed is worth more than the bug: the check that walked
 * exactly this state asserted the *survivor* was still flying and that no result
 * had been reported. It never looked at the corpse.
 */
function testAnEliminatedSeatStaysEliminated(): void {
  section('An eliminated seat is out, and stays out')

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  const field = disarmedArena()
  const game = newMatch({ environment: { ...stubEnvironment(), minefield: field } })
  game.start({ ships: ['wasp', 'wasp'], seed: 0x0e11a, local: 0 })

  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
  const sequence = Math.round(DEATH_SEQUENCE / STEP)
  for (let i = 0; i < 90; i++) game.step(hands)
  field.arm()

  /*
   * Watched past the elimination rather than for three cutscenes.
   *
   * The bug reached `deaths=3` given eight seconds, but *detecting* it needs one
   * tick: with `null` standing for both ends of a seat's life, the tick after
   * elimination immediately matched "dead hull, no wreck" and started again. Eight
   * seconds is also long enough for the 40-hull survivor to be shot down, which
   * resolves the match and makes the corpse unobservable — the first version of this
   * check failed on exactly that rather than on the property.
   *
   * `watchedAfter` is the floor. Without it, "never restarted" passes on a window
   * that ended the tick elimination happened.
   */
  let wreckedTicks = 0
  let maxDeaths = 0
  let sawEliminated = false
  let restarted = false
  let watchedAfter = 0
  for (let i = 0; i < sequence + 90; i++) {
    const seat = game.snapshot(0)
    if (!seat) break
    if (seat.phase === 'wrecked') {
      wreckedTicks++
      if (sawEliminated) restarted = true
    }
    if (seat.phase === 'eliminated') sawEliminated = true
    if (sawEliminated) watchedAfter++
    maxDeaths = Math.max(maxDeaths, seat.deaths)
    game.step(hands)
  }

  check('the seat was killed and its cutscene ran', wreckedTicks > 0, `${wreckedTicks} ticks wrecked`)
  check('the cutscene ended in elimination', sawEliminated, 'it never reached the eliminated phase')
  check(
    'the corpse was watched long enough for a restart to show',
    watchedAfter >= 30,
    `only ${watchedAfter} ticks after elimination`,
  )
  check(
    'and the cutscene never restarted',
    !restarted,
    'an eliminated seat re-entered its own death sequence',
  )
  check('one death is counted once', maxDeaths === 1, `deaths reached ${maxDeaths}`)

  game.dispose()
  SHIPS.wasp.maxHull = originalHull
}

/**
 * Every cutscene the match starts, the match finishes.
 *
 * With staggered deaths the first wreck to resolve used to call `finish` — and
 * `clearArena` with it — as soon as nobody was left *flying*, which a second seat
 * still mid-explosion satisfies. Reproduced: the later wreck held 85 of its 144
 * ticks and then vanished. The same shape applies to a win: clearing the last
 * hostile while somebody is exploding truncates the explosion.
 */
function testStaggeredWrecksEachGetTheirWholeCutscene(): void {
  section('Every cutscene the match starts, the match finishes')

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  const field = disarmedArena()
  let ended: RunResult | null = null
  const game = newMatch({
    environment: { ...stubEnvironment(), minefield: field },
    onEnd: (r) => {
      ended = r
    },
  })
  game.start({ ships: ['wasp', 'wasp'], seed: 0x0e11a, local: 0 })

  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
  const sequence = Math.round(DEATH_SEQUENCE / STEP)

  for (let i = 0; i < 90; i++) game.step(hands)
  field.arm() // seat 0
  let firstWrecked = 0
  for (let i = 0; i < 60; i++) {
    if (game.snapshot(0)?.phase === 'wrecked') firstWrecked++
    game.step(hands)
  }
  field.arm() // seat 1, a second later

  let secondWrecked = 0
  for (let i = 0; i < sequence * 2 + 120; i++) {
    const one = game.snapshot(1)
    if (!one) break
    if (one.phase === 'wrecked') secondWrecked++
    game.step(hands)
  }

  check('the first seat died first', firstWrecked > 0, `${firstWrecked} ticks`)
  check(
    'the later wreck got its whole cutscene rather than being cleared',
    secondWrecked >= sequence,
    `held ${secondWrecked} of ${sequence} ticks`,
  )
  check('and the match did resolve afterwards', (ended as RunResult | null) !== null, 'never resolved')

  game.dispose()
  SHIPS.wasp.maxHull = originalHull
}

/**
 * A minefield the test aims, tick by tick.
 *
 * `findContact(position, radius)` is everything the arena tells a minefield about who
 * is asking, and the radius alone is enough once the squadron is given a sentinel
 * value. Singling out *one seat* needs the other half: the field is spent on contact
 * and `resolveMines` walks the seats in roster order, so a single arming aimed at the
 * seats' radius takes seat 0 and leaves seat 1 alone.
 *
 * Position was the obvious discriminator and does not work: both seats launch facing
 * the arena centre, so fourteen seconds later they are 141 units apart and a mine
 * aimed at one is aimed at both. Measured, after it killed the survivor.
 *
 * This exists to build one state no other check reaches — squadron empty, one seat
 * mid-explosion, another still flying — which is where a win reported over a wreck
 * both steals a loss's banner and truncates the explosion. It is elaborate because
 * the state is: it cannot happen with one seat, and it cannot be reached by flying
 * two seats and hoping.
 */
interface AimedMinefield extends Minefield {
  /** Which hulls this mine is willing to touch, by the two facts it is given. */
  aim(at: (radius: number) => boolean): void
  /** Make it live again. It is spent on contact, like the real one. */
  arm(): void
}

function aimedMinefield(): AimedMinefield {
  const mine: Mine = { position: new THREE.Vector3(), live: false }
  let hits: (radius: number) => boolean = () => false
  return {
    group: new THREE.Group(),
    mines: [mine],
    avoidance: [],
    findContact: (_position, radius) => (mine.live && hits(radius) ? mine : null),
    // Spent on contact, exactly like the real field — which is what makes it able
    // to single out *one* hull: `resolveMines` walks the seats in roster order, so
    // a one-shot mine aimed at the seats' radius takes seat 0 and nobody else.
    detonate: (m) => {
      m.live = false
    },
    reset: () => {
      mine.live = false
      hits = () => false
    },
    aim: (at) => {
      hits = at
    },
    arm: () => {
      mine.live = true
    },
    update() {},
    dispose() {},
  } as AimedMinefield
}

/**
 * A win waits for every explosion it interrupted.
 *
 * `finish` clears the arena, so reporting a cleared squadron while somebody is still
 * coming apart ends their cutscene mid-blast — and in a match where one seat has just
 * died and another is alive, it hands the survivor a victory banner over a wreck that
 * had 60 ticks left to run.
 *
 * The state is constructed rather than waited for. The squadron cannot hurt the seats
 * (zero damage), one seat is singled out by position and killed by a mine, and the
 * remaining hostiles are then killed in a single tick by the same mine aimed at their
 * sentinel radius. Both seats fly the same hull deliberately: the squadron is "the two
 * airframes seat 0 is not flying", so any other roster puts an enemy and a participant
 * on one spec sheet and the levers stop being separable.
 */
function testAWinWaitsForEveryExplosion(): void {
  section('A win waits for the explosions it would interrupt')

  const original = {
    hornetHull: SHIPS.hornet.maxHull,
    waspHull: SHIPS.wasp.maxHull,
    droneHull: SHIPS.drone.maxHull,
    waspDamage: SHIPS.wasp.damage,
    droneDamage: SHIPS.drone.damage,
    waspRadius: SHIPS.wasp.radius,
    droneRadius: SHIPS.drone.radius,
  }
  // Seats die to one mine (45 flat) and to nothing else; hostiles die to one mine and
  // cannot shoot back, so the only deaths in this match are the ones the test causes.
  SHIPS.hornet.maxHull = 40
  SHIPS.wasp.maxHull = 30
  SHIPS.drone.maxHull = 30
  SHIPS.wasp.damage = 0
  SHIPS.drone.damage = 0
  SHIPS.wasp.radius = 350
  SHIPS.drone.radius = 350

  const SENTINEL = 350
  const field = aimedMinefield()
  let ended: RunResult | null = null
  const game = newMatch({
    environment: { ...stubEnvironment(), minefield: field },
    onEnd: (r) => {
      ended = r
    },
  })
  // Drawing the survivor. The mirror — drawing the seat that dies — is
  // `testAnEliminatedSeatDoesNotInheritTheWin`, and it is a different claim: this one is
  // about the cutscene not being cut short, that one about whose result gets reported.
  game.start({ ships: ['hornet', 'hornet'], seed: 0x5eed, local: 1 })

  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
  const sequence = Math.round(DEATH_SEQUENCE / STEP)

  /*
   * Phase 1: drain the arrival queue.
   *
   * The mine has to be killing hostiles for this to happen at all — only three are
   * airborne at once, so with nothing dying the queue sits at three forever, which is
   * what the first version of this waited 30 seconds for. So the squadron is aimed at
   * from the start and disarmed the moment the queue empties, which leaves whatever is
   * mid-warp alive as the hostile to clear later.
   */
  field.aim((r) => r === SENTINEL)
  let ticks = 0
  for (; ticks < Math.ceil(40 / STEP); ticks++) {
    const view = game.snapshot(0)
    if (!view) break
    field.arm()
    game.step(hands)
    if ((game.snapshot(0)?.enemiesQueued ?? 1) === 0) break
  }
  field.aim(() => false)
  const queued = game.snapshot(0)?.enemiesQueued
  const airborne = game.snapshot(0)?.enemiesAirborne
  check('the arrival queue emptied with a hostile still airborne', queued === 0 && (airborne ?? 0) > 0,
    `queued=${queued} airborne=${airborne}`)

  /* Phase 2: one arming aimed at the seats, which the roster order spends on seat 0. */
  field.aim((r) => r !== SENTINEL)
  field.arm()
  for (let i = 0; i < 60; i++) {
    const view = game.snapshot(0)
    if (!view || view.phase === 'wrecked') break
    game.step(hands)
  }
  check('seat 0 was singled out and killed', game.snapshot(0)?.phase === 'wrecked',
    `phase ${game.snapshot(0)?.phase}`)
  check('seat 1 was not touched', game.snapshot(1)?.hull === SHIPS.hornet.maxHull,
    `hull ${game.snapshot(1)?.hull}/${SHIPS.hornet.maxHull}`)

  /* Phase 3: clear the squadron while that cutscene is running. */
  field.aim((r) => r === SENTINEL)

  let wreckedTicks = 0
  let squadronEmptyDuringCutscene = false
  let resultDuringCutscene = false
  for (let i = 0; i < sequence + 180; i++) {
    const zero = game.snapshot(0)
    if (!zero) break
    if (zero.phase === 'wrecked') {
      wreckedTicks++
      if (zero.enemiesQueued === 0 && zero.enemiesAirborne === 0) squadronEmptyDuringCutscene = true
      if ((ended as RunResult | null) !== null) resultDuringCutscene = true
    }
    field.arm()
    game.step(hands)
  }

  /* The floor. Without this the two checks below pass on a match where the squadron
     never emptied while anybody was exploding — which is to say, on nothing. */
  /* The floor, and its message has to stay honest under the mutation it guards
     against: with the win ungated, `finish` clears the arena on the very tick the
     squadron empties, so this floor fails *because the state was destroyed as it was
     created* rather than because it never happened. Saying "never reached" there would
     be a diagnostic asserting something untrue. */
  check(
    'the squadron did empty while a seat was still exploding',
    squadronEmptyDuringCutscene,
    'never observed — either it did not happen, or the match resolved before it could be sampled',
  )
  check(
    'no result is reported over a wreck',
    !resultDuringCutscene,
    'the match resolved while a seat was mid-explosion',
  )
  check(
    'the wreck got its whole cutscene even so',
    wreckedTicks >= sequence,
    `held ${wreckedTicks} of ${sequence} ticks`,
  )
  const final = ended as RunResult | null
  check('and the cleared squadron is reported afterwards', final !== null, 'never resolved')
  check('as a win, to the seat still flying', final?.won === true, `won=${final?.won}`)

  game.dispose()
  SHIPS.hornet.maxHull = original.hornetHull
  SHIPS.wasp.maxHull = original.waspHull
  SHIPS.drone.maxHull = original.droneHull
  SHIPS.wasp.damage = original.waspDamage
  SHIPS.drone.damage = original.droneDamage
  SHIPS.wasp.radius = original.waspRadius
  SHIPS.drone.radius = original.droneRadius
  check(
    'the specs were restored',
    SHIPS.hornet.maxHull === original.hornetHull &&
      SHIPS.wasp.damage === original.waspDamage &&
      SHIPS.wasp.radius === original.waspRadius,
  )
}

/**
 * An eliminated participant does not inherit a teammate's win.
 *
 * The mirror of `testAWinWaitsForEveryExplosion`, and it was missing for a reason worth
 * recording: that check deliberately draws the *survivor*, and its comment says so — to
 * keep the reported result a clean win rather than a loss sealed earlier. Choosing the
 * convenient viewpoint is how the other one goes untested. Same match, same seed, same
 * mine; only which seat is drawn changes.
 *
 * The defect: the drawn seat is eliminated, sealing its loss, and the surviving
 * participant then clears the squadron. `finish(sealResult(true))` reported `won: true`
 * for a participant who had been dead for seconds — and computed the win bonuses off a
 * hull sitting at zero. Their run ended at their death; a teammate finishing the job
 * afterwards is not their victory.
 */
function testAnEliminatedSeatDoesNotInheritTheWin(): void {
  section('An eliminated participant does not inherit a teammate’s win')

  const original = {
    hornetHull: SHIPS.hornet.maxHull,
    waspHull: SHIPS.wasp.maxHull,
    droneHull: SHIPS.drone.maxHull,
    waspDamage: SHIPS.wasp.damage,
    droneDamage: SHIPS.drone.damage,
    waspRadius: SHIPS.wasp.radius,
    droneRadius: SHIPS.drone.radius,
  }
  SHIPS.hornet.maxHull = 40
  SHIPS.wasp.maxHull = 30
  SHIPS.drone.maxHull = 30
  SHIPS.wasp.damage = 0
  SHIPS.drone.damage = 0
  SHIPS.wasp.radius = 350
  SHIPS.drone.radius = 350
  const SENTINEL = 350

  /**
   * Runs the whole thing from one viewpoint: drain the queue, kill seat 0 with a one-shot
   * mine (roster order picks it), then clear the remaining hostiles while its cutscene
   * plays. Returns what the drawn seat's debrief was told.
   */
  function playFrom(localSeat: number): {
    result: RunResult | null
    deaths: number
    wrecked: boolean
    scoreAtDeath: number
    scoreAtEnd: number
  } {
    const field = aimedMinefield()
    let ended: RunResult | null = null
    const game = newMatch({
      environment: { ...stubEnvironment(), minefield: field },
      onEnd: (r) => {
        ended = r
      },
    })
    game.start({ ships: ['hornet', 'hornet'], seed: 0x5eed, local: localSeat })
    const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
    const sequence = Math.round(DEATH_SEQUENCE / STEP)

    field.aim((r) => r === SENTINEL)
    for (let i = 0; i < Math.ceil(40 / STEP); i++) {
      if (!game.snapshot(0)) break
      field.arm()
      game.step(hands)
      if ((game.snapshot(0)?.enemiesQueued ?? 1) === 0) break
    }
    field.aim(() => false)

    field.aim((r) => r !== SENTINEL)
    field.arm()
    let wrecked = false
    let deaths = 0
    let scoreAtDeath = -1
    for (let i = 0; i < 60; i++) {
      const view = game.snapshot(0)
      if (!view) break
      deaths = Math.max(deaths, view.deaths)
      if (view.phase === 'wrecked') {
        wrecked = true
        // Read on the first tick the wreck is visible, which is the tick after the seal.
        scoreAtDeath = view.score
        break
      }
      game.step(hands)
    }

    field.aim((r) => r === SENTINEL)
    let scoreAtEnd = scoreAtDeath
    for (let i = 0; i < sequence + 240 && (ended as RunResult | null) === null; i++) {
      const view = game.snapshot(0)
      if (!view) break
      deaths = Math.max(deaths, view.deaths)
      scoreAtEnd = view.score
      field.arm()
      game.step(hands)
    }

    game.dispose()
    return { result: ended as RunResult | null, deaths, wrecked, scoreAtDeath, scoreAtEnd }
  }

  const asVictim = playFrom(0)
  const asSurvivor = playFrom(1)

  SHIPS.hornet.maxHull = original.hornetHull
  SHIPS.wasp.maxHull = original.waspHull
  SHIPS.drone.maxHull = original.droneHull
  SHIPS.wasp.damage = original.waspDamage
  SHIPS.drone.damage = original.droneDamage
  SHIPS.wasp.radius = original.waspRadius
  SHIPS.drone.radius = original.droneRadius

  /* The premises, so neither verdict below can pass on a match that did something else. */
  check('the drawn seat was killed in the first run', asVictim.wrecked && asVictim.deaths === 1,
    `wrecked=${asVictim.wrecked} deaths=${asVictim.deaths}`)
  check('both runs resolved', asVictim.result !== null && asSurvivor.result !== null,
    `victim ${asVictim.result === null ? 'none' : 'ok'}, survivor ${asSurvivor.result === null ? 'none' : 'ok'}`)

  /* The finding. */
  check(
    'the eliminated participant is told it lost',
    asVictim.result?.won === false,
    `won=${asVictim.result?.won} — a dead participant was handed the squadron clear`,
  )
  /*
   * Exactly the score it had when it died, and the assertion is the *equality* rather
   * than a bound. A threshold was the first attempt and it was a bad proxy: this seat
   * legitimately earned 1813 points, because unattributable kills fall back to seat 0
   * and the mine clearing the squadron produced a lot of them — so "the score is small"
   * says nothing about whether a bonus was added.
   *
   * The freeze is load-bearing here, which the second check establishes: the seat keeps
   * being credited after it is dead, for exactly the reason `sealResult` exists — "long
   * enough for a hostile to fly into the star and post a bounty to a pilot who is
   * already dead".
   */
  check(
    'and its result is the scoreline it died with',
    asVictim.result?.score === asVictim.scoreAtDeath,
    `reported ${asVictim.result?.score}, had ${asVictim.scoreAtDeath} at death`,
  )
  check(
    'which is not the same as its scoreline at the end — the seal is doing work',
    asVictim.scoreAtEnd > asVictim.scoreAtDeath,
    `${asVictim.scoreAtDeath} at death, ${asVictim.scoreAtEnd} when the match ended`,
  )
  /* The other viewpoint, from the same match: the survivor really did win, so the check
     above is about *whose* result is reported rather than about the match's outcome. */
  check(
    'the surviving participant is told it won',
    asSurvivor.result?.won === true,
    `won=${asSurvivor.result?.won}`,
  )
  check(
    'so the two viewpoints report different results from one match',
    asVictim.result?.won !== asSurvivor.result?.won,
    `both reported won=${asVictim.result?.won}`,
  )
  check(
    'the specs were restored',
    SHIPS.hornet.maxHull === original.hornetHull && SHIPS.wasp.damage === original.waspDamage,
  )
}

/**
 * Pause is the roster's answer, not the drawn seat's.
 *
 * `paused` stops the whole simulation, so a guard that consulted `local` meant the
 * same match in the same state — one wreck, one hull still flying — could be frozen
 * from one machine and not from another. Reproduced: `local: 0` refused the pause
 * and `local: 1` accepted it.
 */
function testPauseIsMirroredAcrossSeats(): void {
  section('Pause answers to the roster, not to the drawn seat')

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  function pausedInOneWreckState(localSeat: number): boolean {
    const field = disarmedArena()
    const game = newMatch({ environment: { ...stubEnvironment(), minefield: field } })
    game.start({ ships: ['wasp', 'wasp'], seed: 0x0e11a, local: localSeat })
    const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
    for (let i = 0; i < 90; i++) game.step(hands)
    field.arm()
    for (let i = 0; i < 5; i++) game.step(hands)
    const wrecked = game.snapshot(0)?.phase === 'wrecked'
    const flying = game.snapshot(1)?.phase === 'flying'
    game.pause()
    const paused = game.paused
    game.dispose()
    // Guards the comparison: if the state was not "one wreck, one flying" then the
    // two runs are not being asked the same question.
    return wrecked && flying ? paused : true
  }

  const fromWreck = pausedInOneWreckState(0)
  const fromSurvivor = pausedInOneWreckState(1)
  check(
    'the same state answers pause the same way from either seat',
    fromWreck === fromSurvivor,
    `drawing the wreck gave paused=${fromWreck}, drawing the survivor gave paused=${fromSurvivor}`,
  )
  check('and a cutscene anywhere refuses the pause', fromWreck === false && fromSurvivor === false,
    'a wreck mid-explosion was frozen')

  /*
   * `pause()` says whether it paused, and a caller must be able to trust that
   * instead of predicting it.
   *
   * These assert the *callee*: `dying` is not the pause condition, and the only
   * reliable answer is the return value. That is worth pinning, and it is not enough
   * on its own — the bug was in the caller, and an earlier version of this comment
   * claimed to protect a caller this file could not execute. It certified something
   * untrue, which is the failure it was describing. The caller now lives behind a
   * seam and is tested for real in `testTheScreenMachineCanBeLeftAgain`.
   */
  {
    const field = disarmedArena()
    const game = newMatch({ environment: { ...stubEnvironment(), minefield: field } })
    game.start({ ships: ['wasp', 'wasp'], seed: 0x0e11a, local: 1 })
    const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
    for (let i = 0; i < 90; i++) game.step(hands)
    field.arm()
    for (let i = 0; i < 5; i++) game.step(hands)

    const remoteWrecked = game.snapshot(0)?.phase === 'wrecked'
    const localFlying = game.snapshot(1)?.phase === 'flying'
    check('the state is a remote wreck with the drawn seat still flying',
      remoteWrecked && localFlying,
      `remote ${game.snapshot(0)?.phase}, drawn ${game.snapshot(1)?.phase}`)

    const saidDying = game.dying
    const accepted = game.pause()
    check('`dying` is false here — it is the drawn seat only', saidDying === false, `dying=${saidDying}`)
    check('pause refuses anyway, and says so', accepted === false, `pause() returned ${accepted}`)
    check('its answer matches what actually happened', accepted === game.paused,
      `returned ${accepted}, paused=${game.paused}`)

    // And the simulation really is still advancing, which is what made the overlay a
    // lie rather than a cosmetic slip.
    const before = game.snapshot(1)!.position
    for (let i = 0; i < 60; i++) game.step(hands)
    const after = game.snapshot(1)!.position
    const travelled = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)
    check('a refused pause leaves the match running, as it must', travelled > 1,
      `${travelled.toFixed(1)} units`)
    game.dispose()
  }

  /* The mirror: a pause that *is* accepted stops everything, the environment
     included. `environment.step` used to run before the not-live return, so a paused
     game kept its pod respawn clocks ticking — pre-existing, and fixed with the pause
     path rather than left next to it. */
  {
    let envTicks = 0
    const counted: Environment = { ...stubEnvironment(), step: () => { envTicks++ } }
    const game = newMatch({ environment: counted })
    game.start({ ships: ['hornet'], seed: 0x9a05e })
    const hands = [controls({ throttle: 0.6 })]
    for (let i = 0; i < 30; i++) game.step(hands)
    const ranBefore = envTicks
    const accepted = game.pause()
    const at = game.snapshot(0)!.position
    for (let i = 0; i < 120; i++) game.step(hands)
    const still = game.snapshot(0)!.position

    check('a healthy match accepts the pause', accepted === true && game.paused)
    check('the environment advanced while the match was running', ranBefore === 30, `${ranBefore} ticks`)
    check('and advances not at all while it is paused', envTicks === ranBefore,
      `${envTicks - ranBefore} tick(s) during the pause`)
    check('nor does the hull move', at.x === still.x && at.y === still.y && at.z === still.z,
      `moved to ${still.z}`)

    game.resume()
    for (let i = 0; i < 10; i++) game.step(hands)
    check('and both start again on resume', envTicks === ranBefore + 10 &&
      game.snapshot(0)!.position.z !== still.z, `${envTicks - ranBefore} env ticks after resume`)
    game.dispose()
  }

  SHIPS.wasp.maxHull = originalHull
}

/**
 * A call that throws costs nothing.
 *
 * Two separate versions of the same mistake: validate, then mutate. `step` advanced
 * the environment before checking the intent count, so a rejected tick still moved
 * the world clock and a caller that retried advanced it twice for one tick of
 * simulation. And `start` tore the arena down before finding out whether the setup
 * was buildable, so a refused roster left `active` true with no seats — a blank
 * zombie in place of the match the caller already had.
 */
function testARefusedCallChangesNothing(): void {
  section('A refused call leaves the match exactly as it found it')

  /* ---- step ------------------------------------------------------------- */

  let envTicks = 0
  const counted: Environment = { ...stubEnvironment(), step: () => { envTicks++ } }
  const game = newMatch({ environment: counted })
  game.start({ ships: ['hornet', 'wasp'], seed: 0x5afe })

  for (let i = 0; i < 3; i++) {
    try {
      game.step([controls()])
    } catch {
      /* expected */
    }
  }
  const afterRejects = envTicks
  game.step([controls(), controls()])

  check('three refused ticks advanced the environment not at all', afterRejects === 0, `${afterRejects} tick(s)`)
  check('and the valid tick advanced it exactly once', envTicks === 1, `${envTicks} tick(s)`)
  game.dispose()

  /* ---- start ------------------------------------------------------------ */

  const running = newMatch()
  running.start({ ships: ['hornet'], seed: 0x5afe })
  running.step([controls({ throttle: 0.5 })])
  const before = running.snapshot()

  function refuses(label: string, setup: () => void): void {
    let threw = false
    try {
      setup()
    } catch (e) {
      threw = e instanceof RangeError
    }
    check(`${label} is refused`, threw)
  }

  refuses('a match with no seats', () => running.start({ ships: [] }))
  refuses('a seat asking for a hull that does not exist', () =>
    running.start({ ships: ['hornet', 'zephyr' as ShipId] }))

  const after = running.snapshot()
  check(
    'the running match survived both refusals',
    running.active && running.seatCount === 1 && after !== null,
    `active=${running.active} seatCount=${running.seatCount} snapshot=${after === null ? 'null' : 'present'}`,
  )
  check(
    'and survived them unchanged',
    before !== null && after !== null && before.throttle === after.throttle && before.hull === after.hull,
    `${before?.hull}/${before?.throttle} -> ${after?.hull}/${after?.throttle}`,
  )
  /* The positive, so a `start` that refused everything could not pass the two
     negatives above. Wrapped, so that mutant reports instead of aborting. */
  let restarted = false
  try {
    running.start({ ships: ['wasp'], seed: 1 })
    restarted = running.seatCount === 1
  } catch {
    restarted = false
  }
  check('a valid restart is still accepted', restarted)
  running.dispose()
}

/**
 * The screen state machine: entering the pause screen, and getting back out.
 *
 * Four rounds landed on this one transition, and every fix moved the tested boundary
 * one layer inward while leaving the last step of the decision in code no test could
 * reach — the caller's own copy of the pause condition, then an answer it had to
 * honour, then a value it had to assign, then an object it had to pass by reference
 * rather than by copy. Each regression stayed green across the whole suite.
 *
 * So `createScreens` owns the state outright: there is nothing to hand it and nothing
 * to assign back. These checks assert two things, and the second is the one every
 * earlier version missed — not "did the transition return the right thing" but **can
 * the player get back out**, driven through a model of `main.ts`'s own key handler
 * rather than by calling enter and exit in whatever order suits the test.
 */
function testTheScreenMachineCanBeLeftAgain(): void {
  section('The pause screen can be entered, and left again')

  interface Rig {
    screens: ReturnType<typeof createScreens>
    log: string[]
  }

  /*
   * `resume` is wired separately from `pause`, and not for symmetry. The first version
   * of the live case below wired only `pause` to the real game and left `resume` as a
   * log entry, then asserted the real game had resumed — which failed, correctly. A
   * double whose halves reach different places is a check on nothing in particular.
   */
  function rig(
    from: 'hangar' | 'flight' | 'debrief',
    pause: () => boolean,
    resume: () => void = () => {},
  ): Rig {
    const log: string[] = []
    const host: PauseHost = {
      pause: () => {
        const ok = pause()
        log.push(`pause->${ok}`)
        return ok
      },
      resume: () => {
        resume()
        log.push('resume')
      },
      showPanel: () => log.push('showPanel'),
      hidePanel: () => log.push('hidePanel'),
      grabPointer: () => log.push('grabPointer'),
    }
    return { screens: createScreens(host, from), log }
  }

  /* ---- Both answers ------------------------------------------------------- */

  const yes = rig('flight', () => true)
  yes.screens.enterPause()
  check('an accepted pause reaches the pause screen', yes.screens.screen === 'paused', yes.screens.screen)
  check('and puts the panel up, after asking', yes.log.join(',') === 'pause->true,showPanel', yes.log.join(','))

  const no = rig('flight', () => false)
  no.screens.enterPause()
  /* A refusal changes *nothing*. Not "the screen is right and the panel is up anyway",
     which is the same bug wearing a correct answer. */
  check('a refused pause leaves the screen in flight', no.screens.screen === 'flight', no.screens.screen)
  check('and does nothing else at all', no.log.join(',') === 'pause->false', no.log.join(','))

  /* ---- Leaving ------------------------------------------------------------ */

  const leaving = rig('flight', () => true)
  leaving.screens.enterPause()
  leaving.log.length = 0
  leaving.screens.exitPause()
  check('leaving returns to flight', leaving.screens.screen === 'flight', leaving.screens.screen)
  check(
    'and takes the panel down before the simulation restarts',
    leaving.log.join(',') === 'hidePanel,resume,grabPointer',
    leaving.log.join(','),
  )

  /* ---- Preconditions, which used to live at the call site ---------------- */

  for (const from of ['hangar', 'debrief'] as const) {
    const r = rig(from, () => true)
    r.screens.enterPause()
    check(`pausing from the ${from} screen does nothing`, r.screens.screen === from && r.log.length === 0,
      `screen ${r.screens.screen}, did ${r.log.join(',') || 'nothing'}`)
    r.screens.exitPause()
    check(`leaving the pause screen from ${from} does nothing`, r.screens.screen === from && r.log.length === 0,
      `screen ${r.screens.screen}, did ${r.log.join(',') || 'nothing'}`)
  }
  const flying = rig('flight', () => true)
  flying.screens.exitPause()
  check('leaving the pause screen while in flight does nothing',
    flying.screens.screen === 'flight' && flying.log.length === 0, flying.log.join(','))

  /* ---- The trap: two presses of Escape, through main.ts's own handler ----- */

  /*
   * `src/main.ts` binds Escape and P to `screens.togglePause()` and nothing else, so
   * this *is* the shipped handler. Driving it twice is the property the last two
   * regressions broke: the panel went up, the screen stayed in flight, and Resume —
   * which refuses unless the screen says paused — could never fire.
   */
  const app = rig('flight', () => true)
  app.screens.togglePause()
  check('one press of Escape pauses', app.screens.screen === 'paused', app.screens.screen)
  app.screens.togglePause()
  check(
    'a second press gets the player back out again',
    app.screens.screen === 'flight',
    `stuck on ${app.screens.screen} — the panel is up and nothing will take it down`,
  )
  check(
    'and the round trip did exactly what it should, in order',
    app.log.join(',') === 'pause->true,showPanel,hidePanel,resume,grabPointer',
    app.log.join(','),
  )

  // Ten presses, because a toggle that only works once is still a trap.
  const many = rig('flight', () => true)
  const seen: string[] = []
  for (let i = 0; i < 10; i++) {
    many.screens.togglePause()
    seen.push(many.screens.screen)
  }
  check(
    'Escape keeps working, press after press',
    seen.join(',') === 'paused,flight,paused,flight,paused,flight,paused,flight,paused,flight',
    seen.join(','),
  )

  /* ---- The transitions the app owns, and the one it may not ------------- */

  /*
   * The fourth regression was `createPauseFlow({ ...state }, host)` — a copy, so the app
   * launched while the flow still saw `hangar` and Escape did nothing. There is no holder
   * to copy now, and this is the property that broke: what the app moves to is what the
   * pause transitions see.
   */
  const moving = rig('hangar', () => true)
  check('it starts where it was told to', moving.screens.screen === 'hangar', moving.screens.screen)
  moving.screens.moveTo('flight')
  check('the app can launch', moving.screens.screen === 'flight', moving.screens.screen)
  moving.screens.togglePause()
  check(
    'and pausing sees the screen the app moved to',
    moving.screens.screen === 'paused',
    `${moving.screens.screen} — the transitions and the reads disagree`,
  )
  moving.screens.togglePause()
  moving.screens.moveTo('debrief')
  check('and the app can reach the debrief', moving.screens.screen === 'debrief', moving.screens.screen)
  moving.screens.moveTo('hangar')
  check('and the hangar', moving.screens.screen === 'hangar', moving.screens.screen)

  /* All four documented screens are reachable. What the *dev hook* reports for them is
     `testTheDevHookReadsTheRunningGame`, which reads them through an installed
     `window.__neon` — this rig would have been perfectly green while the hook returned
     the browser's `Screen` object, which is exactly what happened. */
  const reachable = new Set<Screen>()
  const tour = rig('hangar', () => true)
  reachable.add(tour.screens.screen)
  tour.screens.moveTo('flight')
  reachable.add(tour.screens.screen)
  tour.screens.togglePause()
  reachable.add(tour.screens.screen)
  tour.screens.togglePause()
  tour.screens.moveTo('debrief')
  reachable.add(tour.screens.screen)
  check(
    'all four documented screens are reachable',
    reachable.size === 4 &&
      ['hangar', 'flight', 'paused', 'debrief'].every((s) => reachable.has(s as Screen)),
    [...reachable].join(','),
  )

  /* Only `enterPause` may reach the overlay. That is what makes the trap those four
     rounds kept producing unrepresentable from outside rather than merely absent. */
  const forbidden = rig('flight', () => true)
  let refused = false
  try {
    ;(forbidden.screens.moveTo as (s: Screen) => void)('paused')
  } catch (e) {
    refused = e instanceof RangeError
  }
  check('the app cannot move itself onto the pause screen', refused)
  check('and the attempt left it where it was', forbidden.screens.screen === 'flight',
    forbidden.screens.screen)

  /* ---- Against a real Game, in the state the shipped UI cannot build ------ */

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  const field = disarmedArena()
  const game = newMatch({ environment: { ...stubEnvironment(), minefield: field } })
  game.start({ ships: ['wasp', 'wasp'], seed: 0x0e11a, local: 1 })
  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
  for (let i = 0; i < 90; i++) game.step(hands)
  field.arm()
  for (let i = 0; i < 5; i++) game.step(hands)

  const live = rig('flight', () => game.pause(), () => game.resume())

  check(
    'the state is a remote wreck with the drawn seat flying',
    game.snapshot(0)?.phase === 'wrecked' && game.snapshot(1)?.phase === 'flying',
    `remote ${game.snapshot(0)?.phase}, drawn ${game.snapshot(1)?.phase}`,
  )
  live.screens.togglePause()
  check('the real game refuses, and the screen stays in flight', live.screens.screen === 'flight',
    live.screens.screen)
  check('no panel went up over it', !live.log.includes('showPanel'), live.log.join(','))
  check('and the simulation was not frozen', !game.paused)

  const sequence = Math.round(DEATH_SEQUENCE / STEP)
  for (let i = 0; i < sequence + 30; i++) {
    if (!game.snapshot(1)) break
    game.step(hands)
  }
  /* Unconditional, so the count does not move with behaviour — the mutation harness
     needs it constant. `survived` carries the premise instead of a branch. */
  const survived = game.snapshot(1) !== null
  check('the match survived to be paused', survived, 'it resolved first')
  if (survived) live.screens.togglePause()
  check('once every explosion has finished the same press pauses',
    survived && live.screens.screen === 'paused' && game.paused,
    survived ? `screen ${live.screens.screen}, paused=${game.paused}` : 'the match resolved first')
  if (survived) live.screens.togglePause()
  check('and the next one resumes the real game',
    survived && live.screens.screen === 'flight' && !game.paused,
    survived ? `screen ${live.screens.screen}, paused=${game.paused}` : 'the match resolved first')

  game.dispose()
  SHIPS.wasp.maxHull = originalHull
}

/**
 * `window.__neon`, read through an installed hook rather than described.
 *
 * The hook regressed once already: moving the screen state out of `main.ts` left it
 * reading a bare `screen`, which compiles against the DOM global, so it reported the
 * browser's `Screen` object instead of any documented value. The repair was one line —
 * and the check written to protect it toured a local `createScreens` rig and never
 * touched `window.__neon` at all. Restoring the exact stale read left TypeScript, 396
 * simulation checks, 41 balance checks, 42 mutations and the build entirely green.
 *
 * That is the same mistake as the pause rounds, in the smallest possible form: a check
 * that certifies the *source* and claims the *reader*. So this installs the hook on a
 * stand-in global and reads it back — the property descriptor, the getters, and the
 * objects behind them.
 *
 * The two properties that matter are liveness and provenance. A hook snapshotted at
 * construction reports boot-time values forever, which for a debugging surface is worse
 * than not existing; and a hook reading the wrong source is what happened.
 */
function testTheDevHookReadsTheRunningGame(): void {
  section('The dev hook reads the running game')

  const screens = createScreens({
    pause: () => true,
    resume: () => {},
    showPanel: () => {},
    hidePanel: () => {},
    grabPointer: () => {},
  })
  const device = stubInput()
  const game = newMatch()
  const launched: ShipId[] = []

  const host: { __neon?: DevHook } = {}
  installDevHook(host, createDevHook({
    screens,
    game,
    input: device,
    start: (ship) => launched.push(ship),
  }))

  /* No early return: a missing hook must fail the eight checks below by name rather than
     silently removing them from the run. The harness requires a constant assertion count,
     and "the hook was never installed" is exactly the case where the rest matter most. */
  const hook = host.__neon ?? createDevHook({
    screens,
    game,
    input: device,
    start: () => {},
  })
  check('the hook is installed under its documented name', host.__neon !== undefined)

  /* ---- The screen, across every documented value -------------------------- */

  const reported: string[] = []
  reported.push(hook.screen)
  screens.moveTo('flight')
  reported.push(hook.screen)
  screens.togglePause()
  reported.push(hook.screen)
  screens.togglePause()
  screens.moveTo('debrief')
  reported.push(hook.screen)

  check(
    'it reports all four documented screens, by name, as the app moves',
    reported.join(',') === 'hangar,flight,paused,debrief',
    reported.join(','),
  )
  /* The stale read this replaces returned a browser `Screen` *object*, which is not a
     string at all — so the shape is asserted rather than only the values. */
  check(
    'and reports them as strings rather than whatever else is in scope',
    reported.every((r) => typeof r === 'string'),
    reported.map((r) => typeof r).join(','),
  )

  /* ---- Liveness: every field tracks the thing behind it ------------------- */

  screens.moveTo('flight')
  game.start({ ships: ['hornet'], seed: 0x0eb0 })
  const atStart = hook.run
  check('the run view arrives with the match', atStart !== null && atStart.hull > 0,
    `${atStart === null ? 'null' : atStart.hull}`)

  const intents: Controls[] = [controls({ throttle: 0.8 })]
  for (let i = 0; i < 60; i++) game.step(intents)
  const later = hook.run
  check(
    'and keeps up with it rather than reporting the moment it was built',
    later !== null && atStart !== null && later.elapsed > atStart.elapsed,
    `${atStart?.elapsed} -> ${later?.elapsed}`,
  )

  device.write.pitch = 0.5
  device.write.fire = true
  check(
    'the input view is live too',
    hook.input.pitch === 0.5 && hook.input.fire === true,
    `pitch=${hook.input.pitch} fire=${hook.input.fire}`,
  )
  /* Read-only in the sense that matters: writing to what the console is shown must not
     reach the device, or `__neon` becomes a cheat rather than a window. */
  hook.input.pitch = -1
  check('and writing to it does not reach the device', device.state.pitch === 0.5,
    `device pitch=${device.state.pitch}`)

  hook.start('wasp')
  check('the launch command reaches the app', launched.join(',') === 'wasp', launched.join(','))

  /* ---- Reinstallable, which is what `configurable` is for ---------------- */

  let reinstalled = true
  try {
    installDevHook(host, createDevHook({
      screens,
      game,
      input: device,
      start: (ship) => launched.push(ship),
    }))
  } catch {
    reinstalled = false
  }
  check('the hook can be replaced, as a hot reload does', reinstalled,
    'the second install threw — a reloaded session would keep the dead one')

  game.dispose()
}

/**
 * The shipped frame loop keeps calling into a match that has ended.
 *
 * `src/main.ts` only skips the simulation on the hangar screen: on **paused** and on
 * **debrief** it still runs `game.step(intents)` and `game.render(...)` every frame,
 * with the same one-slot array it has always used. But a finished run has already been
 * through `clearArena`, so the roster is empty and the intent array no longer matches
 * it — and the milestone that introduced "exactly one intent per seat" introduced a
 * throw on that mismatch.
 *
 * Nothing else in this file exercises that path, because nothing else in this file is
 * the browser's loop: every other check drives `step` while a match is live and stops
 * when it ends. Had the length check been unconditional, the game would have thrown on
 * the first frame of every debrief — a crash on the most-travelled screen in the game,
 * invisible to a fully green suite. This is the assertion standing in for the browser
 * pass that a headless run cannot make.
 */
function testTheLoopSurvivesTheEndOfARun(): void {
  section('The frame loop survives the end of a run')

  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  const field = disarmedArena()
  let ended: RunResult | null = null
  const game = newMatch({
    environment: { ...stubEnvironment(), minefield: field },
    onEnd: (r) => {
      ended = r
    },
  })
  game.start({ ships: ['wasp'] })

  // Exactly what `main.ts` holds: one reused slot, filled from a device each tick.
  const device = stubInput()
  const pilot = createPilot()
  const intents: Controls[] = [pilot.advance(device.state, STEP)]

  function frame(): void {
    intents[0] = pilot.advance(device.state, STEP)
    game.step(intents)
    game.render(0.5, STEP)
  }

  for (let i = 0; i < 90; i++) frame()
  field.arm()

  let resolvedAt = -1
  let ticks = 0
  for (; ticks < Math.ceil(20 / STEP) && resolvedAt < 0; ticks++) {
    frame()
    if ((ended as RunResult | null) !== null) resolvedAt = ticks
  }

  check('the run resolved', resolvedAt >= 0, `no result in ${ticks} ticks`)
  check('and the roster is empty afterwards', game.seatCount === 0 && game.snapshot() === null,
    `seatCount=${game.seatCount}`)

  /*
   * The debrief. `main.ts` keeps driving the loop here for as long as the player reads
   * the screen — a couple of seconds at 60fps is a hundred-odd frames of stepping a
   * match that no longer exists.
   */
  let threw = ''
  try {
    for (let i = 0; i < 180; i++) frame()
  } catch (e) {
    threw = `${(e as Error).constructor.name}: ${(e as Error).message}`
  }
  check('stepping and drawing a finished match is a no-op, not a throw', threw === '', threw)

  // And the same on the pause screen, which `main.ts` also keeps stepping.
  let pausedThrew = ''
  try {
    game.start({ ships: ['wasp'] })
    for (let i = 0; i < 30; i++) frame()
    game.pause()
    for (let i = 0; i < 120; i++) frame()
    game.resume()
    for (let i = 0; i < 30; i++) frame()
  } catch (e) {
    pausedThrew = `${(e as Error).constructor.name}: ${(e as Error).message}`
  }
  check('and so is stepping a paused match', pausedThrew === '', pausedThrew)
  check('the match is still live after resuming', game.snapshot() !== null && game.active)

  /* The positive, so "no throw" cannot be satisfied by a `step` that refuses nothing.
     A live match with the wrong number of intents must still be refused. */
  let refusedWhenLive = false
  try {
    game.step([])
  } catch (e) {
    refusedWhenLive = e instanceof RangeError
  }
  check('a live match still refuses the wrong number of intents', refusedWhenLive)

  game.dispose()
  SHIPS.wasp.maxHull = originalHull
}

/**
 * A drawn-seat index that is not a number falls back rather than throwing.
 *
 * `Math.min`/`Math.max` propagate `NaN`, so the obvious clamp produced `seats[NaN]`
 * and a `TypeError` one line later — under a comment that said "clamped, not
 * fatal". A comment certifying something untrue is worse than no comment, and this
 * file has recorded that exact shape before. Deliberately not `Number.isFinite`:
 * `Infinity` is a clampable request for "the last seat", the same reasoning as
 * `clamp` in `ship.ts`.
 */
function testTheDrawnSeatIsClampedNotTrusted(): void {
  section('The drawn seat is clamped, including when it is not a number')

  function drawsSomething(label: string, local: number | undefined): void {
    const game = newMatch()
    let seat = -1
    let threw = ''
    try {
      game.start({ ships: ['hornet', 'wasp'], seed: 7, local })
      seat = game.snapshot()?.seat ?? -1
    } catch (e) {
      threw = (e as Error).constructor.name
    }
    game.dispose()
    check(`local ${label} draws a real seat`, threw === '' && seat >= 0 && seat <= 1,
      threw ? `threw ${threw}` : `drew seat ${seat}`)
  }

  drawsSomething('undefined', undefined)
  drawsSomething('0', 0)
  drawsSomething('1', 1)
  drawsSomething('9 (past the end)', 9)
  drawsSomething('-3', -3)
  drawsSomething('1.7', 1.7)
  drawsSomething('NaN', Number.NaN)
  drawsSomething('Infinity', Number.POSITIVE_INFINITY)
  drawsSomething('-Infinity', Number.NEGATIVE_INFINITY)

  /* And the two ends land where they should rather than merely landing somewhere.
     Wrapped, like the probes above: a regressed clamp throws, and an unwrapped call
     here reported its own failure and then took the whole suite down — 289 of 341
     ran, which is a mutant caught by an assertion and a harness that stopped
     talking. */
  function draws(label: string, local: number, expected: number): void {
    const game = newMatch()
    let seat = -1
    try {
      game.start({ ships: ['hornet', 'wasp'], seed: 7, local })
      seat = game.snapshot()?.seat ?? -1
    } catch {
      seat = -1
    }
    game.dispose()
    check(`${label} draws seat ${expected}`, seat === expected, `drew ${seat}`)
  }

  draws('a negative index', -3, 0)
  draws('an index past the end', 9, 1)
  draws('a non-number', Number.NaN, 0)
  draws('a fractional index', 1.7, 1)
}

/**
 * A minefield the test can arm when it is ready.
 *
 * `armedArena` above detonates on the first contact anywhere, which kills a hull
 * the frame its warp-in immunity expires — before it has fired a shot or scored a
 * point. That is exactly what the death-cutscene check wants and exactly wrong
 * here: what respawn has to preserve is a scoreline, so there has to be one first.
 */
function disarmedArena(): Minefield & { arm(): void } {
  const mine: Mine = { position: new THREE.Vector3(), live: false }
  return {
    group: new THREE.Group(),
    mines: [mine],
    avoidance: [],
    findContact: () => (mine.live ? mine : null),
    detonate: (m) => {
      m.live = false
    },
    // `start` calls this, so arming has to happen after it.
    reset: () => {
      mine.live = false
    },
    arm: () => {
      mine.live = true
    },
    update() {},
    dispose() {},
  } as Minefield & { arm(): void }
}

/**
 * Death returns a seat to the arena, or ends the run, and which one is a policy.
 *
 * The plan has milestone 3 replacing run-end with respawn outright. It cannot:
 * single-player is a match with one seat, and a shipped game where dying neither
 * ends the run nor reaches the debrief has no lose condition at all. So respawn is
 * a flag, off by default, and the two branches are asserted against each other
 * here — from the same seed, the same intents and the same fatal mine, so the only
 * difference between the two runs is the policy.
 *
 * That pairing is the point. Either half alone is much weaker: "the seat came
 * back" passes for a game that never resolves anything, and "the run ended" passes
 * for a game that ignores the flag.
 */
function testDeathEitherRespawnsOrResolves(): void {
  section('A death respawns the seat, or resolves the run')

  const SEED = 0xdefea7

  /**
   * Fly until the seat has something worth preserving, arm the mine, and keep
   * flying. Returns what the seat looked like on the last tick before it died and
   * on the last tick of the run.
   */
  function flyIntoAMine(respawn: boolean) {
    const field = disarmedArena()
    let result: RunResult | null = null
    const game = newMatch({
      environment: { ...stubEnvironment(), minefield: field },
      onEnd: (r) => {
        result = r
      },
    })
    game.start({ ships: ['hornet'], seed: SEED, respawn })

    const crew = seatPilots(1)
    const intents: Controls[] = []
    let armed = false
    let atDeath: RunSnapshot | null = null
    let atRespawn: RunSnapshot | null = null
    let deathTick = -1
    let respawnTick = -1
    let resolvedTick = -1
    let ticks = 0

    /*
     * Sampled on the transition rather than at the end of the run, which is the
     * mistake this replaces: the first version read the hull after the budget ran
     * out and found 75 of 120, because the seat had come back on a full hull and
     * then spent forty seconds being shot at. The claim is about the moment the
     * seat returns, so it has to be measured at that moment.
     */
    const budget = Math.ceil(30 / STEP)
    for (; ticks < budget; ticks++) {
      const before = game.snapshot(0)
      // Arm it once there is a scoreline to preserve, so "the score survived" is a
      // claim about a number that was not zero.
      if (!armed && before && before.shotsFired > 0 && before.score > 0) {
        field.arm()
        armed = true
        atDeath = before
      }
      const wreckedBefore = before?.phase === 'wrecked'
      flyAll(game, crew, intents)
      /*
       * Recorded here rather than at the top of the next pass, which is the bug
       * this replaces. `finish` calls `clearArena`, so the tick that resolves the
       * run is also the tick `snapshot` starts returning null — and the null check
       * below fired first, leaving `resolvedTick` at -1 and the assertion reading
       * "result at -1" against a run that had resolved perfectly well.
       */
      if (result && resolvedTick < 0) resolvedTick = ticks
      const now = game.snapshot(0)
      if (!now) break
      if (deathTick < 0 && now.phase === 'wrecked' && !wreckedBefore) deathTick = ticks
      if (respawnTick < 0 && deathTick >= 0 && wreckedBefore && now.phase !== 'wrecked') {
        respawnTick = ticks
        atRespawn = now
      }
    }

    game.dispose()
    return {
      atDeath,
      atRespawn,
      deathTick,
      respawnTick,
      resolvedTick,
      result: result as RunResult | null,
      ticks,
    }
  }

  /* ---- Respawn on: the seat comes back and the match carries on ----------- */

  const back = flyIntoAMine(true)
  check('the seat had a scoreline before it died', (back.atDeath?.score ?? 0) > 0,
    `score ${back.atDeath?.score}, shots ${back.atDeath?.shotsFired}`)
  check('the mine killed it', back.deathTick > 0, `never wrecked in ${back.ticks} ticks`)
  check('a respawning match does not report a result', back.result === null,
    `reported won=${back.result?.won}`)
  check('the seat came back', back.respawnTick > 0 && back.atRespawn !== null,
    `never returned in ${back.ticks} ticks`)
  check('it came back on a full hull', back.atRespawn?.hull === SHIPS.hornet.maxHull,
    `hull ${back.atRespawn?.hull}/${SHIPS.hornet.maxHull}`)
  check('and came back flying rather than wrecked', back.atRespawn?.phase === 'flying')
  check('the death was counted', back.atRespawn?.deaths === 1, `deaths ${back.atRespawn?.deaths}`)
  /* The two halves of the accuracy stat, which is the substantive thing a respawn
     must not reset. `Ship.spawn` deliberately leaves `shotsFired` and the score
     alone — "resets flight state but not the score" — and this is that comment
     asserted rather than trusted. A respawn that built a fresh hull instead would
     zero both and still pass every check above. */
  check(
    'the score survived the death',
    (back.atRespawn?.score ?? 0) >= (back.atDeath?.score ?? 0) && (back.atRespawn?.score ?? 0) > 0,
    `${back.atDeath?.score} → ${back.atRespawn?.score}`,
  )
  check(
    'and so did the shots it had fired',
    (back.atRespawn?.shotsFired ?? 0) >= (back.atDeath?.shotsFired ?? 0) &&
      (back.atRespawn?.shotsFired ?? 0) > 0,
    `${back.atDeath?.shotsFired} → ${back.atRespawn?.shotsFired}`,
  )
  /* The wreck holds the screen for its whole sequence before the seat returns —
     the same guarantee the debrief gets, and the reason respawn could be made a
     policy rather than a second code path. A respawn that fired on the frame of
     death would satisfy every other check here. */
  const held = back.respawnTick - back.deathTick
  const sequence = Math.round(DEATH_SEQUENCE / STEP)
  check(
    'the wreck held the screen for the whole cutscene first',
    back.deathTick > 0 && held >= sequence && held <= sequence + 2,
    `held ${held} ticks, expected ${sequence}`,
  )

  /* ---- Respawn off: the same death ends the run --------------------------- */

  const over = flyIntoAMine(false)
  check('without respawn the same death resolves the run', over.result !== null,
    `no result in ${over.ticks} ticks`)
  check('and resolves it as a loss', over.result?.won === false, `won=${over.result?.won}`)
  check(
    'the debrief still waits for the whole cutscene',
    over.deathTick > 0 && over.resolvedTick - over.deathTick >= Math.floor(DEATH_SEQUENCE / STEP),
    `death at ${over.deathTick}, result at ${over.resolvedTick}`,
  )
  /* The discriminator. Everything above passes for a game that ignores the flag in
     one direction or the other; only comparing the two says the flag is what
     decided. */
  check(
    'the flag is what decided, and nothing else',
    back.result === null && over.result !== null,
    `respawn gave ${back.result === null ? 'no result' : 'a result'}, elimination gave ${over.result === null ? 'no result' : 'a result'}`,
  )
}

/**
 * Elimination ends the run when the arena empties, not when the watcher dies.
 *
 * The reading that suggests itself first is "the run is over when the seat being
 * drawn is out", and with one seat it is the same sentence — which is why the
 * difference is invisible in every other check here. With two it makes the moment
 * a match resolves depend on which machine is watching, so two clients would
 * disagree about when their own match ended.
 *
 * The drawn seat still decides what the *report* says, because `RunResult` is one
 * participant's run. When it ends is the match's business. Both halves are asserted
 * from the same match, so a game that resolved too early fails the first and one
 * that never resolves fails the second.
 *
 * What this deliberately does not claim is that watching a teammate fly on after
 * your own hull is gone is *good*. It is the honest generalisation of the rule
 * that exists, and what a match should actually do with an eliminated participant
 * is milestone 8's.
 */
function testEliminationEndsWhenTheArenaEmpties(): void {
  section('Elimination ends the run when the arena empties')

  // A mine is 45 damage flat, so the hull has to be under that for one to be
  // fatal — the same lever `testDeathPlaysBeforeTheDebrief` pulls, and for the
  // same reason: this is about what a death *resolves*, not about how much a mine
  // hurts.
  const originalHull = SHIPS.wasp.maxHull
  SHIPS.wasp.maxHull = 40

  const field = disarmedArena()
  let ended: RunResult | null = null
  const game = newMatch({
    environment: { ...stubEnvironment(), minefield: field },
    onEnd: (r) => {
      ended = r
    },
  })
  // Drawn seat 0, and seat 0 is the one that dies first — `resolveMines` walks the
  // seats in roster order, so the single armed mine finds it before seat 1. The
  // mine is spent on contact, so seat 1 is not touched in the same tick.
  game.start({ ships: ['wasp', 'wasp'], seed: 0x0e11a, local: 0 })

  const hands = [controls({ throttle: 0.3 }), controls({ throttle: 0.3 })]
  const sequence = Math.round(DEATH_SEQUENCE / STEP)

  // Let both seats clear their warp-in immunity, then arm the mine for seat 0.
  for (let i = 0; i < 90; i++) game.step(hands)
  field.arm()

  let firstDown = -1
  for (let i = 0; i < sequence + 120 && firstDown < 0; i++) {
    game.step(hands)
    if (game.snapshot(0)?.phase !== 'flying' || (game.snapshot(0)?.hull ?? 1) <= 0) firstDown = i
  }
  check('the drawn seat was killed', firstDown >= 0, 'the mine never went off')

  // Long enough for its whole cutscene plus room to spare.
  for (let i = 0; i < sequence + 60; i++) {
    if (!game.snapshot(1)) break
    game.step(hands)
  }
  const midway = ended as RunResult | null
  const survivor = game.snapshot(1)
  check(
    'the drawn seat being out does not end the run while another seat flies',
    midway === null,
    `reported won=${midway?.won} with seat 1 still airborne`,
  )
  check(
    'the surviving seat is still flying',
    (survivor?.hull ?? 0) > 0 && survivor?.phase === 'flying',
    `hull ${survivor?.hull}, phase ${survivor?.phase}`,
  )

  // Now take the last seat as well.
  field.arm()
  for (let i = 0; i < sequence + 300 && ended === null; i++) {
    if (!game.snapshot(1)) break
    game.step(hands)
  }
  const final = ended as RunResult | null
  check('and the last seat down does end it', final !== null, 'the arena emptied and nothing resolved')
  check('reported as a loss', final?.won === false, `won=${final?.won}`)

  game.dispose()
  SHIPS.wasp.maxHull = originalHull
  check('the hull spec was restored', SHIPS.wasp.maxHull === originalHull)
}

function testARunReplaysFromRecordedControls(): void {
  section('A run replays from its recorded controls alone')

  const SEED = 0xc0ffee
  const TICKS = Math.ceil(10 / STEP)

  function fingerprint(run: RunSnapshot | null): string {
    if (!run) return 'none'
    const t = run.target
    return [
      run.score,
      run.kills,
      run.shotsFired,
      run.hull,
      run.speed,
      run.enemiesAirborne,
      t ? `${t.yaw},${t.pitch},${t.range}` : 'nolock',
    ].join(' ')
  }

  /**
   * The game still takes an `Input` for pointer-lock prompts and pause
   * handling, and which one it gets is load-bearing for this check.
   *
   * The recording run is handed the *same* device the autopilot is driving, as
   * `main.ts` does. The replay run is handed a dead one. So if any part of the
   * simulation still reached past its controls to the device, the two runs would
   * see different sticks and diverge. Give both a fresh stub and that hole
   * closes invisibly — both read zeros, both agree, and the check passes while
   * proving nothing. That is how the first version of this was written.
   */
  function newGame(device: Input) {
    return createGame({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
      environment: stubEnvironment(),
      input: device,
      audio: silentAudio(),
      hud: stubHud(),
      bestScoreFor: () => 0,
      onEnd: () => {},
    })
  }

  /* ---- Record: a real device, a real pilot, an autopilot at the stick ---- */

  const input = stubInput()
  const pilot = createPilot()
  const recorded: Controls[] = []
  const recording = newGame(input)
  recording.start({ ships: ['hornet'], seed: SEED })

  for (let i = 0; i < TICKS; i++) {
    const target = recording.snapshot()?.target ?? null
    if (target) {
      input.write.pitch = clampTo(target.pitch * 3, -1, 1)
      input.write.yaw = clampTo(target.yaw * 3, -1, 1)
      input.write.fire = Math.abs(target.pitch) < 0.35 && Math.abs(target.yaw) < 0.35
      input.write.throttleUp = target.range > 260
      input.write.throttleDown = target.range < 170
    } else {
      input.write.pitch = 0
      input.write.yaw = 0
      input.write.fire = false
      input.write.throttleUp = true
      input.write.throttleDown = false
    }
    const c = pilot.advance(input.state, STEP)
    // Copied, not referenced: `Pilot` reuses one struct across ticks, so
    // storing it directly would record the same object sixty times a second.
    recorded.push({ ...c })
    recording.step([c])
  }

  const live = fingerprint(recording.snapshot())

  /* ---- Replay: no device, no pilot, no autopilot ------------------------- */

  // A dead device: nothing ever writes to it.
  const replay = newGame(stubInput())
  replay.start({ ships: ['hornet'], seed: SEED })
  for (const c of recorded) replay.step([c])

  const replayed = fingerprint(replay.snapshot())

  check('the recorded stream is the whole run', recorded.length === TICKS, `${recorded.length} ticks`)
  check('the recorded run was a real fight', live.includes('nolock') === false, live)
  check('replaying the controls reproduces the run', live === replayed, `${live}  vs  ${replayed}`)

  /* A different stream against the same seed must diverge, or the comparison
     above would hold for a simulation that ignored its controls entirely. */
  const idle = newGame(stubInput())
  idle.start({ ships: ['hornet'], seed: SEED })
  const neutral: Controls = { ...recorded[0], pitch: 0, yaw: 0, roll: 0, fire: false, dash: false }
  for (let i = 0; i < TICKS; i++) idle.step([neutral])
  check(
    'a different control stream is a different run',
    fingerprint(idle.snapshot()) !== live,
    'idle stream produced the same run as the autopilot',
  )
}

/**
 * The step clock — the piece that converts irregular frames into whole ticks.
 *
 * This is tested directly rather than through the simulation, because through
 * the simulation it cannot be tested at all. An earlier version of this check
 * fed `ship.step(..., STEP, ...)` the same number of times down two code paths
 * and compared the results; since `step` takes a fixed delta, both paths were
 * identical by construction and the check could not fail. The accumulator it
 * meant to cover lives in the render loop, which nothing headless executes.
 *
 * So the accumulator moved into `src/core/loop.ts` and is exercised here. The
 * property that matters is that no owed simulation time is ever silently
 * dropped: a loop that discarded the remainder each frame would still run at a
 * fixed step, still look approximately right, and would quietly run the game
 * slower than real time on any display whose refresh is not a multiple of 60.
 */
/**
 * A pinned fingerprint of a real run, per airframe.
 *
 * Every other check here asserts a *property* — a bound holds, a rule fires, a
 * seed replays. None of them notice a change that is merely different: a tweak
 * that shifts every trajectory by a hair leaves them all green.
 *
 * Milestones 1 and 2 both claimed "no behaviour change", and both times the
 * evidence was a probe run by hand and pasted into a message. That evidence
 * evaporates the moment the terminal closes, and it cannot protect the *next*
 * change. This bakes it in: a closed-loop autopilot flies a seeded run and the
 * result is compared against numbers stored in this file.
 *
 * It is deliberately the most brittle check in the suite, and that is its job.
 * If it fails, the question is not "what is wrong with the test" — it is
 * "which number moved, and did I mean to move it". A retune *should* fail this;
 * the fix is then to update the baseline in the same commit that explains why,
 * which puts a behaviour change on the record instead of letting it pass as
 * green.
 *
 * Milestone 3 de-singularises `player` across 135 references. This is the net
 * under it.
 */
function testARunMatchesItsRecordedBaseline(): void {
  section('A seeded run still flies the way it used to')

  /*
   * Captured from this harness on `feat/factions`.
   *
   * What that does and does not establish, stated precisely because a baseline
   * invites over-reading. It does *not* independently prove milestone 2 changed
   * nothing — these numbers were recorded after the change. That proof is
   * separate: a cross-commit probe against `origin/main` before and after, run
   * once by me and once by BOLTy, byte-identical on all three airframes.
   *
   * What this *does* is carry that property forward. From here on, a change
   * that shifts a trajectory has to say so.
   */
  const BASELINE: Record<string, string> = {
    hornet:
      '0/0/0/120/177.65902947694352/0 | 10/0/5/120/346.74667078924824/2 | 70/0/13/120/120.17605570806118/3 | 80/0/28/120/10.756811887398108/3',
    wasp:
      '0/0/0/70/235.30300057403224/0 | 55/0/19/70/445.3298881633059/2 | 100/0/59/70/292.3947361912082/3 | 115/0/84/70/442.1328492907095/3',
    drone:
      '0/0/0/200/125.05555269793625/0 | 0/0/1/180/207.80567967883238/2 | 20/0/5/175/233.0433285191874/3 | 20/0/7/165/197.12698816305436/3',
  }

  function fly(ship: ShipId): string {
    const input = stubInput()
    const pilot = createPilot()
    const game = createGame({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000),
      environment: stubEnvironment(),
      input,
      audio: silentAudio(),
      hud: stubHud(),
      bestScoreFor: () => 0,
      onEnd: () => {},
    })
    game.start({ ships: [ship], seed: 0xfac7107 })

    const marks: string[] = []
    const ticks = Math.ceil(20 / STEP)
    for (let i = 0; i < ticks; i++) {
      const t = game.snapshot()?.target ?? null
      if (t) {
        input.write.pitch = clampTo(t.pitch * 3, -1, 1)
        input.write.yaw = clampTo(t.yaw * 3, -1, 1)
        input.write.fire = Math.abs(t.pitch) < 0.35 && Math.abs(t.yaw) < 0.35
        input.write.throttleUp = t.range > 260
        input.write.throttleDown = t.range < 170
      } else {
        input.write.pitch = 0
        input.write.yaw = 0
        input.write.fire = false
        input.write.throttleUp = true
        input.write.throttleDown = false
      }
      game.step([pilot.advance(input.state, STEP)])
      if (i % 300 === 0) {
        const r = game.snapshot()!
        marks.push(
          [r.score, r.kills, r.shotsFired, r.hull, r.speed, r.enemiesAirborne].join('/'),
        )
      }
    }
    return marks.join(' | ')
  }

  for (const ship of SHIP_ORDER) {
    const flown = fly(ship)
    const expected = BASELINE[ship]
    if (!expected) {
      // Recording mode: printed so the constant above can be filled in. Fails
      // rather than passes, so an unfilled baseline cannot masquerade as one
      // that matched.
      check(`a ${ship} run has a recorded baseline`, false, `record this: ${flown}`)
      continue
    }
    check(`a ${ship} run matches its baseline`, flown === expected, `got ${flown}`)
  }
}

function testTheStepClockNeverLosesTime(): void {
  section('The fixed-step clock converts frames to ticks without drift')

  const MAX_FRAME = 1 / 5

  const even = createStepClock(STEP, MAX_FRAME)
  check('a frame of exactly one step runs exactly one tick', even.advance(STEP).ticks === 1)
  check('a frame of half a step runs none', even.advance(STEP / 2).ticks === 0)
  check('the other half completes the tick', even.advance(STEP / 2).ticks === 1)

  /* The one that catches a dropped remainder. Frames of 1.5 steps must average
     1.5 ticks; a clock that reset its accumulator every frame would return a
     steady 1 and lose a third of the game's time without ever looking wrong. */
  const fractional = createStepClock(STEP, MAX_FRAME)
  let ticks = 0
  for (let i = 0; i < 200; i++) ticks += fractional.advance(STEP * 1.5).ticks
  check('fractional frames carry their remainder', ticks === 300, `ran ${ticks} ticks, expected 300`)

  /* Uneven pacing, the way a real display stutters. Total simulated time must
     track total real time to within the tick that is still in the accumulator. */
  const uneven = createStepClock(STEP, MAX_FRAME)
  const frames = [0.004, 0.021, 0.009, 0.033, 0.016, 0.007, 0.048, 0.011]
  let unevenTicks = 0
  let realTime = 0
  for (let i = 0; i < 500; i++) {
    const dt = frames[i % frames.length]
    realTime += dt
    unevenTicks += uneven.advance(dt).ticks
  }
  const expected = Math.floor(realTime / STEP)
  check(
    'uneven frames simulate real time to within one tick',
    Math.abs(unevenTicks - expected) <= 1,
    `ran ${unevenTicks} ticks against ${expected} of real time`,
  )

  /* A frame longer than the clamp drops the excess rather than queueing it.
     Queueing is what turns one slow frame into a permanently slower game. */
  const stalled = createStepClock(STEP, MAX_FRAME)
  const afterStall = stalled.advance(10)
  check(
    'a stalled frame is clamped rather than queued',
    afterStall.ticks === Math.floor(MAX_FRAME / STEP),
    `ran ${afterStall.ticks} ticks for a 10s frame`,
  )
  check('a clamped frame reports the clamped delta', afterStall.frameSeconds === MAX_FRAME)

  /* Alpha is a blend factor and is handed straight to `lerp`/`slerp`. Out of
     range it would extrapolate rather than interpolate, throwing hulls past
     where the simulation ever put them. */
  const blend = createStepClock(STEP, MAX_FRAME)
  let alphaInRange = true
  for (let i = 0; i < 500; i++) {
    const a = blend.advance(frames[i % frames.length]).alpha
    if (!(a >= 0 && a < 1)) alphaInRange = false
  }
  check('alpha stays in [0, 1)', alphaInRange)
}

/**
 * Everything drawn in one frame must agree on which instant it depicts.
 *
 * This is the invariant behind the whole render half, and it is stricter than
 * "interpolate the hulls" — which is how it has been broken twice. First bolts
 * were left on raw tick positions while ships were interpolated. Then the fix
 * for the chase camera moved the disagreement into the death cutscene: the
 * camera started interpolating while the wreck it is locked onto did not.
 *
 * Both were the same failure. Smoothing one consumer of a shared pose relocates
 * the mismatch rather than removing it, and the artefact is worse than plain
 * judder because it is *relative* — two things that should be pinned together
 * sliding against each other. So the check is on the invariant itself rather
 * than on any one consumer, and it asserts positions against the arithmetic
 * they are supposed to be, not against a recorded baseline.
 */
function testOneFrameDepictsOneInstant(): void {
  section('Everything drawn in a frame agrees on one instant')

  const ALPHA = 0.37

  function agrees(actual: THREE.Vector3, want: THREE.Vector3): boolean {
    return actual.distanceTo(want) < 1e-9
  }

  /**
   * Draw the same simulation state at three blends and compare, rather than
   * reaching into the game for each entity's tick endpoints.
   *
   * Interpolation has a property that needs no privileged access to check: with
   * the simulation held still, whatever is drawn at 0.5 must be the midpoint of
   * what is drawn at 0 and at 1. Anything that ignores `alpha` collapses all
   * three onto one point and is caught by the "actually moved" count; anything
   * that interpolates *differently* from its neighbours fails the midpoint test.
   * `frameDt` is zero throughout so the presentation-rate systems — camera
   * smoothing, particles, world spin — cannot move underneath the comparison.
   */
  /**
   * `extra` exists because the scene graph is not the whole frame, and the
   * consumers outside it are the ones that get missed.
   *
   * The HUD is DOM, not `Object3D`, so a contact bracket placed from the wrong
   * pose is invisible to `scene.traverse` — and that is exactly where the fourth
   * instance of this bug turned up, after three had been found and fixed inside
   * the graph. Anything that positions itself from a ship pose without being a
   * node in the scene belongs in `extra`, keyed by name.
   */
  function midpointCheck(
    scene: THREE.Scene,
    render: (alpha: number) => void,
    extra: () => Map<string, THREE.Vector3> = () => new Map(),
  ) {
    interface Pose {
      position: THREE.Vector3
      quaternion: THREE.Quaternion | null
    }

    const extraKeys = new Set<string>()

    function draw(alpha: number): Map<string, Pose> {
      render(alpha)
      const out = new Map<string, Pose>()
      scene.traverse((o) =>
        out.set(o.uuid, { position: o.position.clone(), quaternion: o.quaternion.clone() }),
      )
      // After the traversal, so a name collision would surface as a failure
      // rather than silently shadowing a real node.
      for (const [name, position] of extra()) {
        extraKeys.add(name)
        out.set(name, { position: position.clone(), quaternion: null })
      }
      return out
    }

    const at0 = draw(0)
    const at1 = draw(1)
    const atHalf = draw(0.5)

    let moved = 0
    let extraMoved = 0
    let turned = 0
    let disagreed = ''
    for (const [id, a] of at0) {
      const b = at1.get(id)
      const half = atHalf.get(id)
      if (!b || !half) continue

      if (a.position.distanceTo(b.position) >= 1e-6) {
        moved++
        if (extraKeys.has(id)) extraMoved++
        const want = new THREE.Vector3().lerpVectors(a.position, b.position, 0.5)
        if (!agrees(half.position, want) && !disagreed) {
          disagreed = `${id}: drawn ${JSON.stringify(half.position)} want ${JSON.stringify(want)}`
        }
      }

      /* Orientation is half of a pose and is checked the same way, but not with
         the same arithmetic: slerp is not linear in alpha, so the half-way
         orientation is not the componentwise midpoint of the ends. It is
         something better — slerp turns at constant angular velocity, so the
         half-way orientation is *equidistant* from both ends, exactly, with no
         tolerance to justify. Verified against a worst-case tick: the two gaps
         agree to 1e-13 relative. */
      // `extra` entries are bare points with no orientation of their own.
      if (!a.quaternion || !b.quaternion || !half.quaternion) continue
      const sweep = a.quaternion.angleTo(b.quaternion)
      if (sweep >= 1e-6) {
        turned++
        const toStart = half.quaternion.angleTo(a.quaternion)
        const toEnd = half.quaternion.angleTo(b.quaternion)
        if (Math.abs(toStart - toEnd) > sweep * 1e-3 && !disagreed) {
          disagreed = `rotation: ${toStart} to start vs ${toEnd} to end, over ${sweep}`
        }
      }
    }
    return { moved, extraMoved, turned, disagreed }
  }

  /**
   * The camera needs its own check, because `midpointCheck` structurally cannot
   * see it: it is never added to the scene, so the traversal misses it, and it
   * moves by `1 - exp(-follow * dt)`, which at the zero delta that keeps the
   * comparison stable is exactly zero. Both of those are the right calls for
   * everything else and together they make the camera invisible — which is how
   * the one consumer this whole invariant was discovered through ended up
   * unguarded.
   *
   * `SNAP` and the two settling calls below are one mechanism, not two
   * conveniences, and neither works without the other. A delta that large makes
   * the smoothing factor exactly 1, so the camera lands on its ideal pose in a
   * single call — a pure function of the drawn ship transform, and therefore of
   * alpha, with no accumulated state left to drift between measurements. The
   * same delta drives `shakeAmount *= exp(-6 * dt)` to exactly zero, so the
   * first call spends whatever camera shake the run accumulated and the second
   * settles with the shake provably gone rather than merely small. Shake is
   * applied with `Math.random`, so leaving any of it inside a measurement is how
   * a check ends up failing once a fortnight — worse than not existing.
   */
  function cameraTracksAlpha(
    camera: THREE.PerspectiveCamera,
    render: (alpha: number, frameDt: number) => void,
  ) {
    const SNAP = 1000
    render(0, SNAP)
    render(0, SNAP)
    const c0 = camera.position.clone()
    const q0 = camera.quaternion.clone()
    render(1, SNAP)
    const c1 = camera.position.clone()
    const q1 = camera.quaternion.clone()
    render(0.5, SNAP)
    const cHalf = camera.position.clone()
    const qHalf = camera.quaternion.clone()

    const travel = c0.distanceTo(c1)
    const mid = new THREE.Vector3().lerpVectors(c0, c1, 0.5)

    // Same equidistance property as the scene traversal uses, for the same
    // reason: the view direction is half of what the camera does per frame, and
    // an orientation pinned to the raw tick pose judders the entire view.
    const sweep = q0.angleTo(q1)
    const rotationSkew =
      sweep < 1e-9 ? 0 : Math.abs(qHalf.angleTo(q0) - qHalf.angleTo(q1)) / sweep

    return { travel, deviation: cHalf.distanceTo(mid), sweep, rotationSkew }
  }

  /**
   * How far off the midpoint the camera is allowed to sit, as a fraction of how
   * far it travels across the tick.
   *
   * Not zero, and the reason is real rather than a fudge: the camera's offset
   * hangs off the *slerped* orientation, and slerp is not linear in alpha, so
   * the exact midpoint is not the mid-slerp. The error is second order in the
   * rotation covered by one tick. Measured worst case — the hardest-turning
   * hull at full rate — is 0.16%, so this leaves better than tenfold headroom
   * while staying far below anything a real regression produces: a camera that
   * ignored alpha would not move between the two ends at all, and is caught by
   * the travel check rather than this one.
   */
  const CAMERA_CURVATURE = 0.02

  /* ---- Bolts ----------------------------------------------------------- */

  const bolts = createBolts()
  const origin = new THREE.Vector3(10, -20, 30)
  const speed = 1450
  bolts.fire({
    origin,
    direction: new THREE.Vector3(0, 0, -1),
    speed,
    damage: 1,
    faction: FACTION_PLAYER,
    color: new THREE.Color(0xffffff),
  })
  bolts.update(STEP, [], [])
  bolts.render(ALPHA)

  const boltMatrix = new THREE.Matrix4()
  bolts.mesh.getMatrixAt(0, boltMatrix)
  const boltDrawn = new THREE.Vector3().setFromMatrixPosition(boltMatrix)
  const boltWant = origin.clone().addScaledVector(new THREE.Vector3(0, 0, -1), speed * STEP * ALPHA)
  // Looser than the hull comparison on purpose: this one round-trips through
  // the instance matrix, which is a Float32Array, so ~1e-6 of noise is the
  // storage rather than the maths. Still four orders of magnitude tighter than
  // the ~24 units a bolt would be out if it ignored alpha entirely.
  check(
    'a bolt is drawn at alpha between its last two ticks',
    boltDrawn.distanceTo(boltWant) < 1e-3,
    `${JSON.stringify(boltDrawn)} vs ${JSON.stringify(boltWant)}`,
  )
  // Guards the assertion above: if the bolt had not moved, the check would pass
  // for a renderer that ignored alpha entirely.
  check('the bolt actually travelled', boltDrawn.distanceTo(origin) > 1, `moved ${boltDrawn.distanceTo(origin)}`)
  bolts.dispose()

  /* ---- Ships in flight -------------------------------------------------- */

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000)
  const input = stubInput()
  const pilot = createPilot()
  const hud = recordingHud()
  const game = createGame({
    scene,
    camera,
    environment: stubEnvironment(),
    input,
    audio: silentAudio(),
    hud,
    bestScoreFor: () => 0,
    onEnd: () => {},
  })

  game.start({ ships: ['hornet'], seed: 0x0a11ce })
  input.write.throttleUp = true
  input.write.pitch = 0.5
  input.write.yaw = -0.3
  input.write.fire = true
  for (let i = 0; i < Math.ceil(8 / STEP); i++) game.step([pilot.advance(input.state, STEP)])

  const flight = midpointCheck(
    scene,
    (alpha) => game.render(alpha, 0),
    () => new Map(hud.contactPoints.map((p, i) => [`hud:contact:${i}`, p])),
  )
  /* Not a sanity check — this is the detector for the "ignores alpha entirely"
     case. Anything pinned to the raw tick pose is identical at 0 and at 1, so it
     never enters the midpoint comparison at all and would pass it vacuously.
     This is the assertion that fails instead. Do not remove it as redundant. */
  check('hulls in flight are moving to compare', flight.moved >= 2, `${flight.moved} moved`)
  /* The off-graph detector, and it has to count what *moved* rather than what
     exists. The first version of this asserted only that contacts were present,
     which a marker pinned to the raw tick pose satisfies perfectly — it is there,
     it just never varies with alpha, so it never enters the comparison and the
     check passes on nothing. That is the same vacuous guard this file has now
     produced twice, once in a check written specifically to prevent it. */
  check(
    'HUD contact markers track alpha',
    flight.extraMoved >= 1,
    `${hud.contactPoints.length} contacts recorded, ${flight.extraMoved} moved with alpha`,
  )
  check('hulls in flight are rotating to compare', flight.turned >= 2, `${flight.turned} turned`)
  check('every hull in flight is drawn at one instant', flight.disagreed === '', flight.disagreed)

  const flightCam = cameraTracksAlpha(camera, (alpha, dt) => game.render(alpha, dt))
  check(
    'the camera in flight tracks alpha rather than the raw tick pose',
    flightCam.travel > 1e-6,
    `travelled ${flightCam.travel}`,
  )
  check(
    'the camera in flight sits on the interpolation between ticks',
    flightCam.deviation < flightCam.travel * CAMERA_CURVATURE,
    `off by ${flightCam.deviation} over ${flightCam.travel}`,
  )
  check(
    'the camera in flight turns with alpha rather than snapping per tick',
    flightCam.sweep > 1e-6,
    `swept ${flightCam.sweep} rad`,
  )
  check(
    'the camera in flight is half-turned at half alpha',
    flightCam.rotationSkew < 1e-3,
    `skew ${flightCam.rotationSkew}`,
  )

  /* ---- The wreck, mid-cutscene ------------------------------------------ */

  const originalHull = SHIPS.hornet.maxHull
  SHIPS.hornet.maxHull = 1
  const dyingScene = new THREE.Scene()
  const dyingCamera = new THREE.PerspectiveCamera(74, 16 / 9, 1, 150000)
  const dyingInput = stubInput()
  const dyingPilot = createPilot()
  const dyingGame = createGame({
    scene: dyingScene,
    camera: dyingCamera,
    environment: { ...stubEnvironment(), minefield: armedArena() },
    input: dyingInput,
    audio: silentAudio(),
    hud: stubHud(),
    bestScoreFor: () => 0,
    onEnd: () => {},
  })

  dyingGame.start({ ships: ['hornet'], seed: 0xdead01 })
  dyingInput.write.throttleUp = true
  let reachedDying = false
  for (let i = 0; i < Math.ceil(30 / STEP) && !reachedDying; i++) {
    dyingGame.step([dyingPilot.advance(dyingInput.state, STEP)])
    reachedDying = dyingGame.dying
  }

  check('the run reached the death cutscene', reachedDying)

  /*
   * The five checks below run whether or not the cutscene was reached, and that is a
   * change from `if (reachedDying) { ... }`.
   *
   * Skipping them was defensible — their meaning depends on a wreck existing — but it
   * made the suite's *assertion count* a function of behaviour, and the mutation harness
   * needs that count to be a constant: a mutant that runs 400 of 405 checks has hidden
   * five, and it reported itself cleanly caught. Exactly that happened with the "respawn
   * fires on the frame of death" mutant, which leaves no cutscene to inspect.
   *
   * Made unconditional rather than allowlisted, because there is a version that is both
   * complete and non-vacuous: every measurement is `null` when there was no cutscene, and
   * every check reads "no cutscene was reached" and fails. Six named failures instead of
   * one, and 405 either way.
   */
  let cutscene: ReturnType<typeof midpointCheck> | null = null
  let wreckCam: ReturnType<typeof cameraTracksAlpha> | null = null
  if (reachedDying) {
    // One more tick so the wreck has drift to interpolate across, and so this
    // lands inside `WRECK_TUMBLE` while the hull is still on screen and the
    // camera is still locked to it.
    dyingGame.step([dyingPilot.advance(dyingInput.state, STEP)])
    cutscene = midpointCheck(dyingScene, (alpha) => dyingGame.render(alpha, 0))
    wreckCam = cameraTracksAlpha(dyingCamera, (alpha, dt) => dyingGame.render(alpha, dt))
  }

  const noCutscene = 'no cutscene was reached'
  {
    /* As above, this is the detector rather than a sanity check: a wreck pinned
       to the raw tick pose never moves between 0 and 1, so the midpoint below
       would pass on an empty comparison. This is what actually fails. */
    check('the wreck is moving to compare', (cutscene?.moved ?? 0) >= 1,
      cutscene ? `${cutscene.moved} moved` : noCutscene)
    check('the wreck is drawn at one instant', cutscene !== null && cutscene.disagreed === '',
      cutscene ? cutscene.disagreed : noCutscene)

    // And the other half of the pairing the wreck check is named for.
    check(
      'the camera following the wreck tracks alpha too',
      (wreckCam?.travel ?? 0) > 1e-6,
      wreckCam ? `travelled ${wreckCam.travel}` : noCutscene,
    )
    check(
      'the camera following the wreck sits on the interpolation',
      wreckCam !== null && wreckCam.deviation < wreckCam.travel * CAMERA_CURVATURE,
      wreckCam ? `off by ${wreckCam.deviation} over ${wreckCam.travel}` : noCutscene,
    )
    /* Deliberately no rotation check on the cutscene camera, and the reason is
       worth writing down rather than leaving as a gap.

       `stepDeathSequence` never touches `player.quaternion` — the tumble is
       applied to the mesh alone, so the camera stays bracketed to the hull
       instead of spinning with it. The simulated orientation is therefore
       frozen for the whole cutscene, both ends of the interpolation are equal,
       and there is no alpha-varying rotation here to assert. Demanding one
       fails against correct code; asserting the skew anyway would pass on an
       empty comparison, which is the vacuous-guard mistake this file has
       already made once. Camera rotation is covered by the flight case above,
       where it actually varies. */
    check(
      'the cutscene camera does not rotate with the tumbling wreck',
      wreckCam !== null && wreckCam.sweep < 1e-9,
      wreckCam
        ? `swept ${wreckCam.sweep} rad — the camera is following the mesh, not the hull`
        : noCutscene,
    )
  }

  SHIPS.hornet.maxHull = originalHull
}

/* -------------------------------------------------------------------------- */

console.log('NEON ORBIT — headless simulation checks')
testPlayerBoltsKillEnemies()
testHullBarFadeCurve()
testDamageClockDrivesEnemyBars()
testFriendlyFireIsOff()
testFactionsAreOpenNotTwoSided()
testMintingAFactionIsGuarded()
testBoundaryTurnsShipsAround()
testQuirks()
testSolarSear()
testBoltPoolDoesNotLeak()
testMines()
testPickups()
testARunCanBeWon()
testDeathPlaysBeforeTheDebrief()
testASeededRunReproduces()
testARunReplaysFromRecordedControls()
testTheAirframeCannotBeAskedToExceedItself()
testStepDoesNotRetainCallerControls()
testAFactionResolvesToASeatOrToNobody()
testTwoSeatsFlyOneArena()
testStepNeedsOneIntentPerSeat()
testPresentationCannotChangeTheMatch()
testIntentIsAdmittedNotTrusted()
testASeatShootsAlongItsNose()
testTheWorldSurvivesTheWire()
testAMirrorIsTheHostsMatch()
testHullsComeAndGoByIdAndBadFramesDoNothing()
testAnIntentFrameEndsInAdmission()
testAMatchCrossesTheWire()
testABadWireIsSurvived()
testThePeerFliesItsOwnSeatOnly()
testTheStickIsAttachedToTheShip()
testDeathEitherRespawnsOrResolves()
testEliminationEndsWhenTheArenaEmpties()
testAnEliminatedSeatStaysEliminated()
testStaggeredWrecksEachGetTheirWholeCutscene()
testAWinWaitsForEveryExplosion()
testAnEliminatedSeatDoesNotInheritTheWin()
testASeatRespawnsWhileTheOthersKeepFlying()
testARespawnPointReplaysFromItsSeed()
testPauseIsMirroredAcrossSeats()
testTheSquadronIsNotAFunctionOfTheWatcher()
testTheDrawnSeatIsClampedNotTrusted()
testARefusedCallChangesNothing()
testTheScreenMachineCanBeLeftAgain()
testTheDevHookReadsTheRunningGame()
testTheLoopSurvivesTheEndOfARun()
testScoringIsPerSeat()
testTwoScorersKeepSeparateStreaks()
testShootingAParticipantScoresNothingYet()
testTheStepClockNeverLosesTime()
testARunMatchesItsRecordedBaseline()
testOneFrameDepictsOneInstant()

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
