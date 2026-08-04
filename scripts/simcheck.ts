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
import { createGame } from '../src/game/game'
import type { Hud } from '../src/game/hud'
import { Ship, type Controls, type ShipContext } from '../src/game/ship'
import { mulberry32 } from '../src/core/rng'
import { SHIPS } from '../src/ships/specs'
import { ARENA_HARD_LIMIT, ARENA_RADIUS, type Environment } from '../src/world/environment'

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
    setEngine() {},
    laser() {
      stub.laserCount++
    },
    hit() {},
    hullHit() {},
    explosion() {},
    warp() {},
    dash() {},
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

/** An empty arena: no stations, so this measures the dogfight and nothing else. */
function stubEnvironment(): Environment {
  const group = new THREE.Group()
  return {
    group,
    stations: [],
    hazards: [],
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
 * Three things are pinned down so this is an assertion rather than a coin flip:
 *
 * - `Math.random` is seeded. Spawn placement, AI jink and roster order all use
 *   it, so an unseeded run varies enormously — the first version of this check
 *   passed and failed on alternate runs, which is worse than having no check.
 * - Enemy hulls drop to one volley. A proportional controller is a poor stand-in
 *   for a human: it treats a jinking target's lead point as raw signal and
 *   oscillates, where a person reading the lead pip anticipates. Tuning an
 *   autopilot until it beat the real balance would be testing the autopilot.
 * - The player is made unkillable, so the only way the run can end is by
 *   clearing the roster. That is the transition under test.
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
  SHIPS.wasp.maxHull = 12
  SHIPS.drone.maxHull = 12
  SHIPS.hornet.maxHull = 1_000_000

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
      const gate = Math.atan2(26, Math.max(60, target.range))
      input.write.fire =
        Math.abs(target.pitch) < gate && Math.abs(target.yaw) < gate && target.range < 1000
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
  Math.random = realRandom

  const run = result as RunResult | null
  check('the run resolved', run !== null, `gave up after ${(frames * STEP).toFixed(0)}s`)
  check('an emptied roster reports a win', run?.won === true, run ? `won=${run.won}, kills=${run.kills}` : 'no result')
  check('every hostile in the roster was accounted for', run?.kills === 6, `kills=${run?.kills}`)
  check('the run scored points', (run?.score ?? 0) > 0, `score=${run?.score}`)
  check('accuracy was recorded', (run?.accuracy ?? 0) > 0, `accuracy=${run?.accuracy?.toFixed(3)}`)
  check('a win awards the hull and time bonuses', (run?.score ?? 0) > 6 * SHIPS.wasp.bounty, `score=${run?.score}`)
  check('the player spec was restored', SHIPS.hornet.maxHull === originalHulls.hornet)
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

/* -------------------------------------------------------------------------- */

console.log('NEON ORBIT — headless simulation checks')
testPlayerBoltsKillEnemies()
testFriendlyFireIsOff()
testBoundaryTurnsShipsAround()
testQuirks()
testBoltPoolDoesNotLeak()
testARunCanBeWon()

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
