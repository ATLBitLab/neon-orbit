/**
 * Mutation runs for the simulation checks.
 *
 *   npm run check:mutants
 *
 * Every claim in this repo's review history that a check "would catch" something has
 * been backed by a mutation run pasted into a message, and every one of those
 * evaporated when the terminal closed. This is the same evidence, checked in, so a
 * reviewer can replay the set instead of taking the author's word for the result —
 * which is the same argument that put the recorded baseline in `simcheck.ts`.
 *
 * Each entry breaks the code in one named way and asserts that the suite reports it.
 * The verdicts are deliberately three, not two:
 *
 * - **CAUGHT** — `FAIL > 0`, the suite reached its own summary, **and every expected
 *   assertion ran**. That last clause is not pedantry: a mutant reporting 365 ok + 35
 *   FAIL against an expected 414 has hidden fourteen checks, and it called itself
 *   cleanly caught until the count was part of the verdict.
 * - **CAUGHT-THEN-ABORTED** — named its failures but did not finish the run. Still a
 *   gap: whatever came after is unmeasured.
 * - **CRASH-ONLY** — non-zero exit with `FAIL = 0`. The mutant is still stopped, but
 *   the diagnostic is "39 of 201 ran" rather than the name of the thing that broke.
 *   Treated as a gap in the suite, not a pass. This repo has produced it twice.
 * - **SURVIVED** — green. Either the check is missing or the mutation is genuinely
 *   unobservable; the difference has to be established, not assumed.
 *
 * Exits non-zero if anything survives or is caught only by a crash, so this can be a
 * CI job rather than a habit somebody has to remember.
 *
 * Refuses to run on a dirty tree: it edits files in place and restores them
 * afterwards, and it will not risk somebody's uncommitted work to do that.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** @type {{ name: string, file: string, from: string, to: string }[]} */
const MUTATIONS = [
  /* ---- Intent routing: which seat flies which controls -------------------- */
  {
    name: 'every seat flies intents[0]',
    file: 'src/game/game.ts',
    from: '      recordControls(seat, intents[i])\n      seat.ship.step(intents[i], STEP, ctx)',
    to: '      recordControls(seat, intents[0])\n      seat.ship.step(intents[0], STEP, ctx)',
  },
  {
    name: "every seat flies the drawn seat's intent",
    file: 'src/game/game.ts',
    from: '      recordControls(seat, intents[i])\n      seat.ship.step(intents[i], STEP, ctx)',
    to: '      recordControls(seat, intents[localIndex])\n      seat.ship.step(intents[localIndex], STEP, ctx)',
  },
  {
    name: 'seat i flies intents[i+1], wrapped',
    file: 'src/game/game.ts',
    from: '      recordControls(seat, intents[i])\n      seat.ship.step(intents[i], STEP, ctx)',
    to:
      '      const j = (i + 1) % seats.length\n' +
      '      recordControls(seat, intents[j])\n' +
      '      seat.ship.step(intents[j], STEP, ctx)',
  },
  {
    name: 'step accepts any number of intents',
    file: 'src/game/game.ts',
    from: '    if (live && intents.length !== seats.length) {',
    to: '    if (false && live && intents.length !== seats.length) {',
  },
  {
    name: 'the two seats share one control record',
    file: 'src/game/roster.ts',
    from:
      'export function recordControls(seat: Participant, c: Controls): void {\n' +
      '  const held = seat.lastControls',
    to:
      'const oneRecord = freshControls()\n' +
      'export function recordControls(seat: Participant, c: Controls): void {\n' +
      '  const held = oneRecord\n  void seat',
  },

  /* ---- Scoring attribution ----------------------------------------------- */
  {
    name: 'every hit is credited to seat 0',
    file: 'src/game/game.ts',
    from: '      const scorer = seatOf(seats, from)\n      if (!scorer) return\n      creditHit(scorer, amount)',
    to: '      const scorer = seats[0]\n      if (!scorer) return\n      creditHit(scorer, amount)',
  },
  {
    name: 'every kill is credited to seat 0',
    file: 'src/game/game.ts',
    from: '    return seatOf(seats, from) ?? seats[0] ?? null',
    to: '    return seats[0] ?? null',
  },
  {
    name: 'the streak is shared between seats',
    file: 'src/game/roster.ts',
    from: '  seat.multiplier = Math.min(3, 1 + seat.kills * 0.25)',
    to: '  seat.multiplier = Math.min(3, 1 + (seat.kills + seat.index) * 0.25)',
  },

  /* ---- Faction resolution ------------------------------------------------ */
  {
    name: 'a faction miss resolves to seat 0',
    file: 'src/game/roster.ts',
    from: '  for (const seat of seats) {\n    if (seat.faction === faction) return seat\n  }\n  return undefined',
    to: '  for (const seat of seats) {\n    if (seat.faction === faction) return seat\n  }\n  return seats[0]',
  },
  {
    name: 'seat i mints faction i+1',
    file: 'src/game/roster.ts',
    from: '      faction: humanFaction(index),',
    to: '      faction: humanFaction(index + 1),',
  },

  /* ---- Seat lifecycle: the P1s from the PR #19 review -------------------- */
  {
    name: 'elimination clears the phase instead of naming it',
    file: 'src/game/game.ts',
    from: '    seat.phase = ELIMINATED\n    seat.ship.visual.group.visible = false',
    to: '    seat.phase = FLYING\n    seat.ship.visual.group.visible = false',
  },
  {
    name: 'finish waits only for flying seats, not for wrecks',
    file: 'src/game/game.ts',
    from: '    if (!matchStillRunning()) finish(pendingResult ?? sealResult(false))',
    to: '    if (!anySeatFlying()) finish(pendingResult ?? sealResult(false))',
  },
  {
    /*
     * A teammate's win overwrites the drawn seat's sealed loss. Found in review, not by
     * a check: the existing win-over-wreck rig deliberately drew the *survivor*, so the
     * opposite viewpoint — the one where a dead participant is handed the squadron clear
     * — was never played.
     */
    name: "a teammate's win overwrites the drawn seat's sealed loss",
    file: 'src/game/game.ts',
    from: '      finish(pendingResult ?? sealResult(true))',
    to: '      finish(sealResult(true))',
  },
  {
    name: 'a win is reported over a wreck',
    file: 'src/game/game.ts',
    from: '    if (queue.length === 0 && pilots.length === 0 && anySeatFlying() && !anySeatWrecked()) {',
    to: '    if (queue.length === 0 && pilots.length === 0 && anySeatFlying()) {',
  },
  {
    name: 'a respawn starts the scoreline over',
    file: 'src/game/game.ts',
    from: '  function respawnSeat(seat: Participant): void {\n    seat.phase = FLYING',
    to:
      '  function respawnSeat(seat: Participant): void {\n' +
      '    seat.score = 0\n    seat.ship.shotsFired = 0\n    seat.phase = FLYING',
  },
  {
    name: 'a respawn fires on the frame of death',
    file: 'src/game/game.ts',
    from: "      if (seat.phase.kind === 'wrecked' && seat.phase.timer >= DEATH_SEQUENCE) resolveWreck(seat)",
    to: "      if (seat.phase.kind === 'wrecked' && seat.phase.timer >= 0) resolveWreck(seat)",
  },
  {
    name: 'a respawn lands on a fixed point rather than a seeded one',
    file: 'src/game/game.ts',
    from:
      '      if (clear) {\n' +
      '        for (const other of boltTargets) {',
    to:
      '      if (clear) return launchPoint(seat.index, seats.length, out)\n' +
      '      if (clear) {\n' +
      '        for (const other of boltTargets) {',
  },
  {
    name: 'every match respawns, whatever the flag says',
    file: 'src/game/game.ts',
    from: '      respawns = setup.respawn ?? false',
    to: '      respawns = true',
  },
  {
    name: 'no match respawns, whatever the flag says',
    file: 'src/game/game.ts',
    from: '      respawns = setup.respawn ?? false',
    to: '      respawns = false',
  },

  /* ---- Presentation reaching an outcome ---------------------------------- */
  {
    name: 'the squadron is drawn from the watched seat',
    file: 'src/game/game.ts',
    from: '      for (const id of otherShips(seats[0].ship.spec.id)) {',
    to: '      for (const id of otherShips(localSpec.id)) {',
  },
  {
    name: 'pause asks the drawn seat rather than the roster',
    file: 'src/game/game.ts',
    from: '      if (!active || anySeatWrecked()) return',
    to: "      if (!active || local()?.phase.kind === 'wrecked') return",
  },
  {
    name: 'enemy arrivals anchor on the drawn seat',
    file: 'src/game/game.ts',
    from: '    out.set(0, 0, 0)\n    let counted = 0\n    for (const seat of seats) {\n      if (!seat.ship.alive) continue',
    to:
      '    const drawn = local()\n    if (drawn) return out.copy(drawn.ship.position)\n' +
      '    out.set(0, 0, 0)\n    let counted = 0\n    for (const seat of seats) {\n      if (!seat.ship.alive) continue',
  },
  {
    name: 'hostiles chase the drawn seat rather than the nearest',
    file: 'src/game/game.ts',
    from: '      const quarry = nearestSeat(pilot.ship.position)',
    to: '      const quarry = local()?.ship ?? nearestSeat(pilot.ship.position)',
  },
  {
    name: 'every seat shares one lock',
    file: 'src/game/game.ts',
    from: '    for (const seat of seats) acquireTarget(seat)',
    to:
      '    for (const seat of seats) { acquireTarget(seats[0]); seat.lockedTarget = seats[0].lockedTarget }',
  },

  /* ---- Atomicity: a refused call must cost nothing ----------------------- */
  /* ---- The dev hook: the reader, not only its source ----------------------- */
  {
    /*
     * The exact regression, in its new home: the hook reports a value captured when it
     * was built rather than the app's current screen. This is what "reads a stale
     * screen" becomes once the bare-global spelling is impossible — and the check that
     * used to claim this ground toured a local rig and stayed green through it.
     */
    name: 'the dev hook reports the screen it was built with',
    file: 'src/core/dev-hook.ts',
    from: '    get screen() {\n      return sources.screens.screen\n    },',
    to: '    screen: sources.screens.screen,',
  },
  {
    name: 'the dev hook reports the run it was built with',
    file: 'src/core/dev-hook.ts',
    from: '    get run() {\n      return sources.game.snapshot()\n    },',
    to: '    run: sources.game.snapshot(),',
  },
  {
    name: 'the dev hook hands the console the live input struct',
    file: 'src/core/dev-hook.ts',
    from: '      return { ...sources.input.state, pointerLocked: sources.input.pointerLocked }',
    to: '      return Object.assign(sources.input.state, { pointerLocked: sources.input.pointerLocked })',
  },
  {
    name: 'the dev hook cannot be reinstalled by a hot reload',
    file: 'src/core/dev-hook.ts',
    from: '  Object.defineProperty(target, name, { value: hook, configurable: true })',
    to: '  Object.defineProperty(target, name, { value: hook, configurable: false })',
  },

  /* ---- The screen machine: one entry per regression round ------------------ */
  {
    // Round 1, restored: show the panel without honouring the refusal.
    name: 'the pause transition ignores a refused pause',
    file: 'src/ui/screens.ts',
    from: '      if (!host.pause()) return\n      host.showPanel()',
    to: '      host.pause()\n      host.showPanel()',
  },
  {
    name: 'the pause transition shows the panel before asking',
    file: 'src/ui/screens.ts',
    from: '      if (!host.pause()) return\n      host.showPanel()',
    to: '      host.showPanel()\n      if (!host.pause()) return',
  },
  {
    /*
     * Round 3, restored: the panel goes up and the screen is never written — which is
     * what `flow.enter()` as a bare statement did when the flow returned the new screen
     * for the app to assign. Resume then refuses, and the player is sealed in.
     */
    name: 'entering the pause screen never writes the screen',
    file: 'src/ui/screens.ts',
    from: "      host.showPanel()\n      screen = 'paused'",
    to: '      host.showPanel()',
  },
  {
    name: 'leaving the pause screen never writes the screen',
    file: 'src/ui/screens.ts',
    from: "      host.grabPointer()\n      screen = 'flight'",
    to: '      host.grabPointer()',
  },
  {
    /*
     * Round 4, restored: the pause transitions read a screen that stops tracking the one
     * the app moves. The holder copy did this from outside; there is no holder now, so
     * the equivalent is a getter that answers from a snapshot taken at construction.
     */
    name: 'the screen is reported from a stale copy',
    file: 'src/ui/screens.ts',
    from: '    get screen() {\n      return screen\n    },',
    to: '    get screen() {\n      return start\n    },',
  },
  {
    name: 'the app can move itself onto the pause screen',
    file: 'src/ui/screens.ts',
    from: "      if ((next as Screen) === 'paused') {",
    to: '      if (false) {',
  },
  {
    name: 'moving to another screen does not change the screen',
    file: 'src/ui/screens.ts',
    from: '      screen = next\n    },',
    to: '    },',
  },
  {
    name: 'the pause screen is entered from any screen at all',
    file: 'src/ui/screens.ts',
    from: "      if (screen !== 'flight') return",
    to: '      if (false) return',
  },
  {
    name: 'the pause screen is left from any screen at all',
    file: 'src/ui/screens.ts',
    from: "      if (screen !== 'paused') return",
    to: '      if (false) return',
  },
  {
    name: 'Escape toggles the wrong way',
    file: 'src/ui/screens.ts',
    from: "      if (screen === 'paused') screens.exitPause()\n      else screens.enterPause()",
    to: "      if (screen === 'paused') screens.enterPause()\n      else screens.exitPause()",
  },
  {
    name: 'leaving the pause screen restarts the sim before hiding the panel',
    file: 'src/ui/screens.ts',
    from: '      host.hidePanel()\n      host.resume()',
    to: '      host.resume()\n      host.hidePanel()',
  },
  {
    name: 'pause claims to have paused when it refused',
    file: 'src/game/game.ts',
    from: '      if (!active || anySeatWrecked()) return false',
    to: '      if (!active || anySeatWrecked()) return true',
  },
  {
    name: 'the environment advances while the match is paused',
    file: 'src/game/game.ts',
    from: '    if (!live) return\n    environment.step(STEP)',
    to: '    environment.step(STEP)\n    if (!live) return',
  },
  {
    // The one that would have crashed the shipped game on every debrief frame while
    // the whole headless suite stayed green.
    name: 'the intent count is checked even when no match is running',
    file: 'src/game/game.ts',
    from: '    if (live && intents.length !== seats.length) {',
    to: '    if (intents.length !== seats.length) {',
  },
  {
    name: 'a rejected tick still advances the environment',
    file: 'src/game/game.ts',
    from: '    if (live && intents.length !== seats.length) {',
    to: '    environment.step(STEP)\n    if (live && intents.length !== seats.length) {',
  },
  {
    name: 'start tears the arena down before validating the setup',
    file: 'src/game/game.ts',
    from: '      const built = createSeats(specs, seed)\n\n      clearArena()',
    to: '      clearArena()\n      const built = createSeats(specs, seed)',
  },
  {
    name: 'the drawn seat is clamped with Math.min, which propagates NaN',
    file: 'src/game/game.ts',
    from:
      '    if (typeof requested !== \'number\' || Number.isNaN(requested)) return 0\n' +
      '    const asked = Math.trunc(requested)\n' +
      '    return asked < 0 ? 0 : asked > count - 1 ? count - 1 : asked',
    to: '    return Math.min(Math.max(0, Math.trunc(requested ?? 0)), count - 1)',
  },
  {
    name: 'createSeats accepts an empty roster',
    file: 'src/game/roster.ts',
    from: '  if (specs.length === 0) {',
    to: '  if (specs.length === -1) {',
  },

  /* ---- Spawn placement --------------------------------------------------- */
  {
    name: 'all seats launch from the same point',
    file: 'src/game/roster.ts',
    from:
      '  out.copy(PLAYER_SPAWN)\n  if (index === 0) return out\n' +
      '  return out.applyAxisAngle(_launchAxis, (index / count) * Math.PI * 2)',
    to: '  void count\n  void index\n  return out.copy(PLAYER_SPAWN)',
  },
]

function dirty() {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
}

function runSuite() {
  const r = spawnSync('npm', ['run', 'check:sim'], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const lines = out.split('\n').filter((l) => l.trim().length > 0)
  return {
    code: r.status,
    ok: (out.match(/^ {2}ok/gm) ?? []).length,
    fail: (out.match(/^ {2}FAIL/gm) ?? []).length,
    named: (out.match(/^ {2}FAIL (.*)$/gm) ?? []).map((l) => l.replace(/^ {2}FAIL /, '')),
    last: lines.length > 0 ? lines[lines.length - 1].trim() : '(no output)',
  }
}

const changed = dirty()
if (changed) {
  console.error('Refusing to run: the working tree has uncommitted changes.\n')
  console.error(changed)
  console.error('\nThis harness edits source files in place and restores them. Commit or stash first.')
  process.exit(2)
}

const only = process.argv[2]
console.log('NEON ORBIT — mutation runs against scripts/simcheck.ts\n')

/**
 * How many assertions `check:sim` runs when nothing is wrong.
 *
 * Pinned, and deliberately brittle for the same reason the recorded baseline in
 * `simcheck.ts` is: it is the only thing that can tell "the suite is green" from "the
 * suite is green and ran everything". Green-and-short is the dangerous one, because
 * every verdict in this file is "did the suite report a failure" and a suite missing a
 * whole test invocation still reports none.
 *
 * If you added or removed checks on purpose, bump this in the same commit. If you did
 * not, something stopped running.
 */
const EXPECTED_ASSERTIONS = 414
const PASS_SUMMARY = 'All checks passed.'

/**
 * Why a control run cannot be trusted, or `null` if it can.
 *
 * Four ways it fails, and only the first two were checked before. A run that exits 0
 * with 348 of 367 assertions and prints its own cheerful summary satisfied the old
 * guard completely — reproduced by deleting one nine-assertion invocation from a
 * detached copy of this head, after which all mutants were still reported caught and
 * the harness exited 0.
 */
function controlProblem(r) {
  if (r.code !== 0) return `it exited ${r.code}`
  if (r.fail !== 0) return `${r.fail} check(s) failed`
  if (r.ok === 0) return 'it ran no assertions at all'
  if (r.last !== PASS_SUMMARY) {
    return `it never reached its own summary (last line ${JSON.stringify(r.last)})`
  }
  if (r.ok !== EXPECTED_ASSERTIONS) {
    return `it ran ${r.ok} assertions where ${EXPECTED_ASSERTIONS} were expected — ${
      r.ok < EXPECTED_ASSERTIONS ? 'something stopped running' : 'checks were added'
    }; bump EXPECTED_ASSERTIONS in scripts/mutate.mjs if that was deliberate`
  }
  return null
}

/*
 * Self-test, before anything else: prove the control guard can *fail*.
 *
 * A guard nobody has seen reject anything is documentation. This removes one real test
 * invocation from `simcheck.ts`, confirms `controlProblem` names the shortfall, and puts
 * it back — so the thing that catches a partial suite is exercised on every run rather
 * than having been checked by hand once, by the person who wrote it, in a commit nobody
 * can replay.
 */
const SELF_TEST_FILE = 'scripts/simcheck.ts'
const SELF_TEST_ANCHOR = '\ntestTwoScorersKeepSeparateStreaks()\n'
{
  const source = readFileSync(SELF_TEST_FILE, 'utf8')
  if (source.split(SELF_TEST_ANCHOR).length - 1 !== 1) {
    console.error(
      `Refusing to run: the self-test anchor ${JSON.stringify(SELF_TEST_ANCHOR.trim())} is not in ` +
        `${SELF_TEST_FILE} exactly once. The control guard would go unexercised.`,
    )
    process.exit(2)
  }
  writeFileSync(SELF_TEST_FILE, source.split(SELF_TEST_ANCHOR).join('\n'))
  let partial
  try {
    partial = runSuite()
  } finally {
    writeFileSync(SELF_TEST_FILE, source)
  }
  const complaint = controlProblem(partial)
  console.log(
    `self-test (one test invocation removed): exit=${partial.code} ok=${partial.ok} ` +
      `FAIL=${partial.fail} -> ${complaint ?? 'ACCEPTED'}`,
  )
  if (!complaint) {
    console.error(
      '\nRefusing to run: the control guard accepted a suite with a whole test missing.',
    )
    process.exit(2)
  }
  if (partial.fail !== 0 || partial.code !== 0) {
    console.error(
      '\nRefusing to run: removing that invocation made the suite fail, so this proves nothing ' +
        'about a green-but-short run. Pick an anchor whose absence leaves the suite passing.',
    )
    process.exit(2)
  }
  console.log('  (green, short, and correctly refused — the guard bites)\n')
}

/*
 * Second self-test: the *verdict* rule, not the control rule.
 *
 * The control guard above only ever inspects the unmutated run. Each mutant got its own,
 * weaker test — "did it name failures and reach a summary" — and that accepted a run of
 * 400 of 405 as cleanly caught, hiding five assertions. So this proves the verdict rule
 * rejects a run that *fails loudly and is still short*, which is the exact shape that
 * slipped through: a real mutation plus a removed test invocation, which is failing and
 * short at once.
 */
{
  const source = readFileSync(SELF_TEST_FILE, 'utf8')
  const gameSource = readFileSync('src/game/game.ts', 'utf8')
  const BREAK = "      if (!host.pause()) return\n      host.showPanel()"
  if (gameSource.includes(BREAK)) {
    console.error('Refusing to run: the verdict self-test patched the wrong file.')
    process.exit(2)
  }
  const screensPath = 'src/ui/screens.ts'
  const screens = readFileSync(screensPath, 'utf8')
  if (screens.split(BREAK).length - 1 !== 1) {
    console.error(`Refusing to run: the verdict self-test anchor is not in ${screensPath} once.`)
    process.exit(2)
  }
  writeFileSync(SELF_TEST_FILE, source.split(SELF_TEST_ANCHOR).join('\n'))
  writeFileSync(screensPath, screens.split(BREAK).join('      host.pause()\n      host.showPanel()'))
  let both
  try {
    both = runSuite()
  } finally {
    writeFileSync(SELF_TEST_FILE, source)
    writeFileSync(screensPath, screens)
  }
  const complete = both.ok + both.fail === EXPECTED_ASSERTIONS
  console.log(
    `self-test (failing *and* short): exit=${both.code} ok=${both.ok} FAIL=${both.fail} ` +
      `(${both.ok + both.fail}/${EXPECTED_ASSERTIONS} ran)`,
  )
  if (both.fail === 0) {
    console.error('\nRefusing to run: that combination was supposed to fail loudly and did not.')
    process.exit(2)
  }
  if (complete) {
    console.error(
      '\nRefusing to run: a run missing a whole test invocation still counted as complete, ' +
        'so the per-mutant verdict cannot tell a full run from a short one.',
    )
    process.exit(2)
  }
  console.log('  (loud, short, and it would be judged CAUGHT-THEN-ABORTED — the verdict bites)\n')
}

/*
 * The control run, and it is not ceremony.
 *
 * Every verdict below is "did the suite report a failure", which is only evidence that
 * the *mutation* did something if the suite reported none to begin with. Against an
 * already-failing suite this harness prints "29 caught" and exits 0 while proving
 * nothing at all — the same shape as comparing two empty strings, which this codebase
 * has now recorded five times.
 */
const baseline = runSuite()
console.log(
  `control (no mutation): exit=${baseline.code} ok=${baseline.ok} FAIL=${baseline.fail} last=${JSON.stringify(baseline.last)}\n`,
)
const problem = controlProblem(baseline)
if (problem) {
  console.error(`Refusing to run: the unmutated suite cannot be trusted — ${problem}.`)
  console.error('Every mutation would report a failure and none of it would mean anything.')
  process.exit(2)
}

let caught = 0
let crashOnly = 0
let survived = 0
let unapplied = 0

for (const [i, m] of MUTATIONS.entries()) {
  if (only !== undefined && String(i) !== only && !m.name.includes(only)) continue

  const source = readFileSync(m.file, 'utf8')
  const hits = source.split(m.from).length - 1
  if (hits !== 1) {
    // A mutation that no longer applies is not a pass. It means the code moved and
    // this entry is now testing nothing, which is worth failing over.
    console.log(`[${i}] ${m.name}\n     PATCH DID NOT APPLY (${hits} matches in ${m.file}) — NOT TESTED`)
    unapplied++
    continue
  }

  writeFileSync(m.file, source.split(m.from).join(m.to))
  let result
  try {
    result = runSuite()
  } finally {
    writeFileSync(m.file, source)
  }

  /*
   * Four verdicts, not three. A mutant that names its assertion and *then* takes the
   * process down has still hidden every check after it — the suite reported 289 of
   * 341 and stopped — so it is a gap in the harness rather than a clean catch. The
   * summary line is the tell: a finished run ends with its own count.
   */
  const finished =
    /check\(s\) failed\.$|All checks passed\.$/.test(result.last) &&
    result.ok + result.fail === EXPECTED_ASSERTIONS
  const verdict =
    result.fail > 0
      ? finished
        ? 'CAUGHT'
        : 'CAUGHT-THEN-ABORTED'
      : result.code !== 0
        ? 'CRASH-ONLY'
        : 'SURVIVED'
  if (verdict === 'CAUGHT') caught++
  else if (verdict === 'CRASH-ONLY' || verdict === 'CAUGHT-THEN-ABORTED') crashOnly++
  else survived++

  console.log(`[${i}] ${m.name}`)
  console.log(
    `     exit=${result.code} ok=${result.ok} FAIL=${result.fail} ` +
      `(${result.ok + result.fail}/${EXPECTED_ASSERTIONS} ran) last=${JSON.stringify(result.last)} -> ${verdict}`,
  )
  for (const name of result.named.slice(0, 6)) console.log(`       - ${name}`)
  if (result.named.length > 6) console.log(`       ... and ${result.named.length - 6} more`)
}

console.log(
  `\n${caught} caught cleanly, ${crashOnly} caught but the run did not finish, ${survived} survived, ${unapplied} not testable`,
)

/*
 * The known survivor, stated rather than hidden by an allowlist.
 *
 * `sealResult` was made pure so a win bonus cannot land on the drawn seat's
 * scoreline. There is no mutation entry for it, because restoring it is provably
 * unobservable: `sealResult(true)` is reached from one call site and `finish` clears
 * the arena before returning, so nothing can read the write. It becomes observable at
 * milestone 8, where a win stops ending the match. See the note at `sealResult`.
 */
/*
 * A run that tested nothing is not a clean run.
 *
 * Without this the harness printed "Every mutation was caught by a named assertion"
 * and exited 0 for a filter that matched no entry — a green verdict over an empty
 * set, inside the tool built to catch exactly that. Found by pointing it at a name
 * that does not exist, which is the first thing anybody attacking it would try.
 */
const ran = caught + crashOnly + survived + unapplied
if (ran === 0) {
  console.error(
    only === undefined
      ? '\nRefusing to pass: no mutations ran. The list is empty.'
      : `\nRefusing to pass: no mutation matched ${JSON.stringify(only)}. Nothing was tested.`,
  )
  process.exit(2)
}
if (only !== undefined && ran < MUTATIONS.length) {
  console.log(`\nFiltered run: ${ran} of ${MUTATIONS.length} mutations. Not a full verdict.`)
}
if (crashOnly > 0 || survived > 0 || unapplied > 0) {
  console.log('\nA surviving, crash-only or unapplied mutation is a gap in the suite, not a pass.')
  process.exit(1)
}
console.log(`\nAll ${ran} mutations were caught by a named assertion.`)
