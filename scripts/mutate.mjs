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
 * - **CAUGHT** — `FAIL > 0`. A named assertion said which property broke.
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

/*
 * The control run, and it is not ceremony.
 *
 * Every verdict below is "did the suite report a failure", which is only evidence
 * that the *mutation* did something if the suite reported none to begin with. Against
 * an already-failing suite this harness prints "28 caught" and exits 0 while proving
 * nothing at all — the same shape as comparing two empty strings, which this codebase
 * has now recorded five times. So: measure the floor first, and refuse to draw
 * conclusions from a baseline that is not clean.
 */
const baseline = runSuite()
console.log(
  `control (no mutation): exit=${baseline.code} ok=${baseline.ok} FAIL=${baseline.fail} last=${JSON.stringify(baseline.last)}\n`,
)
if (baseline.code !== 0 || baseline.fail !== 0 || baseline.ok === 0) {
  console.error('Refusing to run: the unmutated suite is not green.')
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
  const finished = /check\(s\) failed\.$|All checks passed\.$/.test(result.last)
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
    `     exit=${result.code} ok=${result.ok} FAIL=${result.fail} last=${JSON.stringify(result.last)} -> ${verdict}`,
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
