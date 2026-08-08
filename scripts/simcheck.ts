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
import { createBolts } from '../src/game/bolts'
import { createGame, DEATH_SEQUENCE } from '../src/game/game'
import { barBrightness, DAMAGE_BAR_FADE, DAMAGE_BAR_HOLD, type Hud } from '../src/game/hud'
import { Ship, type Controls, type ShipContext } from '../src/game/ship'
import { mulberry32 } from '../src/core/rng'
import { SHIPS } from '../src/ships/specs'
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
  const ctx: ShipContext = { hazards: [], audio, bolts }

  const player = new Ship(SHIPS.hornet, 'player')
  player.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))

  const enemy = new Ship(SHIPS.wasp, 'enemy')
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
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  const player = new Ship(SHIPS.hornet, 'player')
  player.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))

  // A Hornet on the receiving end: six volleys of hull, so it survives every
  // hit this check lands, and a dash quirk rather than the Drone's repair, so
  // nothing quietly refills the hull between assertions.
  const enemy = new Ship(SHIPS.hornet, 'enemy')
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
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  const shooter = new Ship(SHIPS.drone, 'enemy')
  shooter.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))

  const ally = new Ship(SHIPS.wasp, 'enemy')
  ally.spawn(new THREE.Vector3(0, 0, -300), new THREE.Vector3(0, 0, -2000))

  const victim = new Ship(SHIPS.hornet, 'player')
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

function testBoundaryTurnsShipsAround(): void {
  section('Patrol boundary beats full thrust')

  const bolts = createBolts()
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  /**
   * Worst case: the fastest, grippiest hull, nose pointed *straight* out at full
   * throttle. This is the case that used to park itself at the hard limit.
   * Radial-only motion means low total speed near the turnaround is expected
   * and fine — what matters is that it is held near the line and comes back in,
   * not that it is fast while doing so.
   */
  const radial = new Ship(SHIPS.wasp, 'player')
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
  const oblique = new Ship(SHIPS.wasp, 'player')
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
  const ctx: ShipContext = { hazards: [], audio, bolts }

  /* Wasp: sustained fire must lock the guns out. */
  const wasp = new Ship(SHIPS.wasp, 'player')
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
  const drone = new Ship(SHIPS.drone, 'enemy')
  drone.spawn(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1000))
  drone.warpTimer = 0
  drone.takeDamage(80, 'player')
  const wounded = drone.hull
  for (let i = 0; i < 60 * 2; i++) drone.step(controls(), STEP, ctx)
  check('Drone does not repair inside the delay window', drone.hull === wounded)
  for (let i = 0; i < 60 * 6; i++) drone.step(controls(), STEP, ctx)
  check('Drone repairs after the delay', drone.hull > wounded, `hull=${drone.hull.toFixed(1)}`)
  check('repair never exceeds max hull', drone.hull <= drone.spec.maxHull)

  /* Hornet: dash adds speed, grants brief immunity, then goes on cooldown. */
  const hornet = new Ship(SHIPS.hornet, 'player')
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
  const ctx: ShipContext = { hazards: [], audio, bolts }

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

  const burning = new Ship(SHIPS.hornet, 'player')
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

  const hostile = new Ship(SHIPS.wasp, 'enemy')
  hostile.spawn(deep, new THREE.Vector3(0, 0, 0))
  hostile.warpTimer = 0

  let creditedToPlayer = 0
  hostile.onDamaged = (_self, _amount, from) => {
    if (from === 'player') creditedToPlayer++
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

  const shaded = new Ship(SHIPS.hornet, 'player')
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

  const arriving = new Ship(SHIPS.wasp, 'enemy')
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
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  const ship = new Ship(SHIPS.wasp, 'player')
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
 */
function testARunCanBeWon(): void {
  section('A cleared roster reports a win')

  const realRandom = Math.random
  Math.random = mulberry32(0x5120fa11)

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

  game.start('hornet')

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

    game.update(STEP)
  }

  SHIPS.wasp.maxHull = originalHulls.wasp
  SHIPS.drone.maxHull = originalHulls.drone
  SHIPS.hornet.maxHull = originalHulls.hornet
  SHIPS.hornet.fireInterval = originalGuns.fireInterval
  SHIPS.hornet.boltSpeed = originalGuns.boltSpeed
  SHIPS.hornet.damage = originalGuns.damage
  SHIPS.wasp.radius = originalRadii.wasp
  SHIPS.drone.radius = originalRadii.drone
  Math.random = realRandom

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

  game.start('wasp')

  let deathFrame = -1
  let resultFrame = -1
  let dyingFrames = 0
  let pausedMidDeath = false

  const budget = Math.ceil(20 / STEP)
  let frames = 0
  for (; frames < budget && resultFrame < 0; frames++) {
    game.update(STEP)

    if (deathFrame < 0 && (game.snapshot()?.playerHull ?? 1) <= 0) deathFrame = frames
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
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  const target = field.mines[0]
  const ship = new Ship(SHIPS.hornet, 'player')
  ship.spawn(target.position.clone(), new THREE.Vector3(0, 0, 0))
  ship.warpTimer = 0

  check('a ship on top of a mine registers contact', field.findContact(ship.position, ship.radius) === target)

  const before = ship.hull
  field.detonate(target)
  ship.takeDamage(MINE_DAMAGE, 'enemy')

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
    if (field.findContact(ship.position, ship.radius)) ship.takeDamage(MINE_DAMAGE, 'enemy')
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
  const ctx: ShipContext = { hazards: [], audio: silentAudio(), bolts }

  const repairPad = field.pods.find((p) => p.kind === 'repair')!
  const ship = new Ship(SHIPS.hornet, 'player')
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

  ship.takeDamage(60, 'enemy')
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
  const drone = new Ship(SHIPS.drone, 'player')
  drone.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  drone.warpTimer = 0
  drone.takeDamage(120, 'enemy')
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

  const half = repairPad.respawnIn / 2
  for (let i = 0; i < Math.round(half / STEP); i++) field.update(STEP, eye)
  check('it stays gone while the clock runs', !repairPad.live, `${repairPad.respawnIn.toFixed(1)}s left`)
  for (let i = 0; i < Math.round((half + 1) / STEP); i++) field.update(STEP, eye)
  check('it re-arms once the clock expires', repairPad.live)
  check('a re-armed pad registers contact again', field.findContact(repairPad.position, 40) === repairPad)

  field.collect(repairPad)
  field.reset()
  check('reset re-arms the whole field', field.pods.every((p) => p.live && p.respawnIn === 0))

  /* ---- Overdrive --------------------------------------------------------- */

  const gunner = new Ship(SHIPS.hornet, 'player')
  gunner.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  gunner.warpTimer = 0

  check('a stock ship is not overdriven', !gunner.overdriven)

  // Count shots and total damage over a fixed window, stock and boosted, with
  // the ship pinned — this is the same trick the balance harness uses.
  function fireFor(ship: Ship, seconds: number): { shots: number; damage: number } {
    const dummy = new Ship(SHIPS.drone, 'enemy')
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
  const boostedBolt = new Ship(SHIPS.drone, 'player')
  boostedBolt.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  boostedBolt.warpTimer = 0
  boostedBolt.engageOverdrive(OVERDRIVE_DURATION)
  const mark = new Ship(SHIPS.wasp, 'enemy')
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

  const guarded = new Ship(SHIPS.hornet, 'player')
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
  guarded.takeDamage(40, 'enemy')
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
  guarded.takeDamage(MINE_DAMAGE, 'enemy')
  check('a shield eats a mine too', guarded.hull === full, `hull=${guarded.hull}`)

  /**
   * The shield must not reset the damage clock. `sinceHit` is the Drone's
   * nanite timer, so a shielded Drone should keep repairing right through
   * incoming fire — nothing reached its hull.
   */
  const guardedDrone = new Ship(SHIPS.drone, 'player')
  guardedDrone.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1000))
  guardedDrone.warpTimer = 0
  guardedDrone.takeDamage(120, 'enemy')
  for (let i = 0; i < 60 * 8; i++) guardedDrone.step(controls(), STEP, ctx)
  const repairing = guardedDrone.hull
  guardedDrone.engageShield(SHIELD_DURATION)
  for (let i = 0; i < 60; i++) {
    guardedDrone.takeDamage(10, 'enemy')
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
  guarded.takeDamage(20, 'enemy')
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

/* -------------------------------------------------------------------------- */

console.log('NEON ORBIT — headless simulation checks')
testPlayerBoltsKillEnemies()
testHullBarFadeCurve()
testDamageClockDrivesEnemyBars()
testFriendlyFireIsOff()
testBoundaryTurnsShipsAround()
testQuirks()
testSolarSear()
testBoltPoolDoesNotLeak()
testMines()
testPickups()
testARunCanBeWon()
testDeathPlaysBeforeTheDebrief()

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
