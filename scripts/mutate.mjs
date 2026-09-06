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
 * **Only `CAUGHT` is a pass**, and the verdicts are enumerated once, on `classify` —
 * deliberately not repeated here. A second copy of that list is a second thing to keep
 * true, and it was already false: it announced "three, not two" while four were
 * implemented and six exist today. Documentation with two implementations goes the same
 * way as a rule with two implementations, which this file exists to complain about.
 *
 * The job exits non-zero unless every mutation was caught cleanly, so it can be a CI job
 * rather than a habit somebody has to remember. Five self-tests run first and prove the
 * deciders can *refuse* — a guard nobody has watched reject anything is documentation.
 *
 * Refuses to run on a dirty tree: it edits files in place and restores them afterwards,
 * and it will not risk somebody's uncommitted work to do that.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** @type {{ name: string, file: string, from: string, to: string }[]} */
const MUTATIONS = [
  /* ---- Intent routing: which seat flies which controls -------------------- */
  {
    name: 'every seat flies intents[0]',
    file: 'src/game/game.ts',
    from: '      recordControls(seat, intents[i])\n      // The hull flies the *record*, not the caller\'s struct: admission — `aim`\n      // dropped, `spread` zeroed — happens in `recordControls`, and flying its\n      // output is what makes the record the truth rather than a copy of it.\n      seat.ship.step(seat.lastControls, STEP, ctx)',
    to: '      recordControls(seat, intents[0])\n      seat.ship.step(seat.lastControls, STEP, ctx)',
  },
  {
    name: "every seat flies the drawn seat's intent",
    file: 'src/game/game.ts',
    from: '      recordControls(seat, intents[i])\n      // The hull flies the *record*, not the caller\'s struct: admission — `aim`\n      // dropped, `spread` zeroed — happens in `recordControls`, and flying its\n      // output is what makes the record the truth rather than a copy of it.\n      seat.ship.step(seat.lastControls, STEP, ctx)',
    to: '      recordControls(seat, intents[localIndex])\n      seat.ship.step(seat.lastControls, STEP, ctx)',
  },
  {
    name: 'seat i flies intents[i+1], wrapped',
    file: 'src/game/game.ts',
    from: '      recordControls(seat, intents[i])\n      // The hull flies the *record*, not the caller\'s struct: admission — `aim`\n      // dropped, `spread` zeroed — happens in `recordControls`, and flying its\n      // output is what makes the record the truth rather than a copy of it.\n      seat.ship.step(seat.lastControls, STEP, ctx)',
    to:
      '      const j = (i + 1) % seats.length\n' +
      '      recordControls(seat, intents[j])\n' +
      '      seat.ship.step(seat.lastControls, STEP, ctx)',
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

  /* ---- Intent admission: the anti-cheat surface --------------------------- */
  {
    name: "a seat flies the caller's struct instead of the admitted record",
    file: 'src/game/game.ts',
    from: '      seat.ship.step(seat.lastControls, STEP, ctx)',
    to: '      seat.ship.step(intents[i], STEP, ctx)',
  },
  {
    name: 'a seat keeps its aim override',
    file: 'src/game/roster.ts',
    from: '  held.aim = null\n  held.spread = 0',
    to: '  held.aim = c.aim\n  held.spread = 0',
  },
  {
    name: 'a seat keeps its spread',
    file: 'src/game/roster.ts',
    from: '  held.aim = null\n  held.spread = 0',
    to: '  held.aim = null\n  held.spread = c.spread',
  },
  {
    name: 'the throttle ramp is skipped for a snapped request',
    file: 'src/game/intent.ts',
    from: '  return target > up ? up : target < down ? down : target',
    to: '  return target',
  },
  {
    name: 'the throttle ramp is symmetric',
    file: 'src/game/intent.ts',
    from: '  const down = held - THROTTLE_DOWN_RATE * dt',
    to: '  const down = held - THROTTLE_UP_RATE * dt',
  },
  {
    name: 'a NaN throttle stalls instead of holding',
    file: 'src/game/intent.ts',
    from: "  if (typeof wanted !== 'number' || Number.isNaN(wanted)) return held",
    to: "  if (typeof wanted !== 'number' || Number.isNaN(wanted)) return 0",
  },
  {
    name: 'bound rejects infinity along with NaN',
    file: 'src/game/intent.ts',
    from: "  if (typeof v !== 'number' || Number.isNaN(v)) return 0",
    to: "  if (typeof v !== 'number' || !Number.isFinite(v)) return 0",
  },
  {
    name: 'bound passes NaN through',
    file: 'src/game/intent.ts',
    from: "  if (typeof v !== 'number' || Number.isNaN(v)) return 0",
    to: "  if (typeof v !== 'number') return 0",
  },
  {
    name: 'a truthy fire is a trigger pull',
    file: 'src/game/intent.ts',
    from: '  out.fire = claim.fire === true',
    to: '  out.fire = Boolean(claim.fire)',
  },
  {
    name: 'a late packet keeps firing',
    file: 'src/game/intent.ts',
    from: '    out.fire = false\n    out.dash = false\n    out.aim = null',
    to: '    out.fire = held.fire\n    out.dash = held.dash\n    out.aim = null',
  },
  {
    name: 'a late packet stalls the throttle',
    file: 'src/game/intent.ts',
    from: '    out.throttle = held.throttle\n    out.fire = false',
    to: '    out.throttle = 0\n    out.fire = false',
  },
  {
    name: 'an admitted intent keeps the aim override',
    file: 'src/game/intent.ts',
    from: '  out.dash = claim.dash === true\n  out.aim = null',
    to: '  out.dash = claim.dash === true\n  out.aim = claim.aim as THREE.Vector3 | null',
  },

  /* ---- Snapshots: the world on the wire ----------------------------------- */
  {
    name: 'capture never reads shotsFired',
    file: 'src/game/game.ts',
    from: '      shotsFired: ship.shotsFired,\n    }\n  }',
    to: '      shotsFired: 0,\n    }\n  }',
  },
  {
    name: 'apply never writes the hull',
    file: 'src/game/game.ts',
    from: '    ship.hull = s.hull\n    ship.throttle = s.throttle',
    to: '    ship.throttle = s.throttle',
  },
  {
    name: 'apply never writes heat',
    file: 'src/game/game.ts',
    from: '    ship.heat = s.heat\n',
    to: '',
  },
  {
    name: 'apply keeps a hull the host stopped sending',
    file: 'src/game/game.ts',
    from: '      if (seen.has(pilotIds.get(pilot) ?? -1)) continue',
    to: '      continue',
  },
  {
    name: 'apply ignores a lock',
    file: 'src/game/game.ts',
    from: '    for (let i = 0; i < seats.length; i++) seats[i].lockedTarget = resolveLock(s.seats[i].lock)',
    to: '',
  },
  {
    name: "apply reports its own queue, not the host's",
    file: 'src/game/game.ts',
    from: '    return mirrored ? mirroredQueued : queue.length',
    to: '    return queue.length',
  },
  {
    name: 'apply never sets the wreck clock',
    file: 'src/game/game.ts',
    from: '        wreck.timer = state.wreckTimer\n',
    to: '',
  },
  {
    name: 'the snapshot codec drops sinceHit',
    file: 'src/net/snapshot.ts',
    from: '  w.f32(s.warpTimer).f32(s.flash).f32(s.sinceHit)',
    to: '  w.f32(s.warpTimer).f32(s.flash)',
  },
  {
    name: 'the snapshot codec reads big-endian',
    file: 'src/net/wire.ts',
    from: '    const v = this.view.getFloat32(this.offset, true)',
    to: '    const v = this.view.getFloat32(this.offset, false)',
  },
  {
    name: 'a frame with a tail is accepted',
    file: 'src/net/wire.ts',
    from: '  finish(): void {\n    if (!this.done) {',
    to: '  finish(): void {\n    if (false) {',
  },
  {
    name: 'restoring the bolt pool keeps stale bolts alive',
    file: 'src/game/bolts.ts',
    from: '      for (let i = 0; i < MAX_BOLTS; i++) pool[i].active = false\n      for (const b of live) {',
    to: '      for (const b of live) {',
  },
  {
    name: 'an intent frame bypasses admission',
    file: 'src/net/wire.ts',
    from: '  return { seat, tick, controls: admitIntent(claim, held, dt, out) }',
    to: '  return { seat, tick, controls: Object.assign(out, claim, { aim: null, spread: 0 }) }',
  },
  {
    name: 'a squadron hull is captured without its id',
    file: 'src/game/game.ts',
    from: '      id: pilotIds.get(pilot) ?? 0,\n      spec: pilot.ship.spec.id,',
    to: '      id: 0,\n      spec: pilot.ship.spec.id,',
  },

  /* ---- Backfill: a seat with no peer is flown --------------------------- */
  {
    name: 'an empty seat holds instead of being flown',
    file: 'src/net/session.ts',
    from: '        if (!peer && auto) {\n',
    to: '        if (false && !peer && auto) {\n',
  },
  {
    name: 'the autopilot keeps flying a seat a peer has taken',
    file: 'src/net/session.ts',
    from: '        if (!peer && auto) {\n',
    to: '        if (auto) {\n',
  },
  {
    name: 'a peer taking a seat over starts from launch throttle',
    file: 'src/net/session.ts',
    from: '      if (auto) holds[seat].throttle = auto.controls.throttle\n',
    to: '',
  },
  {
    name: 'the seat autopilot never fires',
    file: 'src/game/autopilot.ts',
    from: '      controls.fire = t.range < FIRE_RANGE && Math.abs(t.pitch) < FIRE_CONE && Math.abs(t.yaw) < FIRE_CONE\n',
    to: '      controls.fire = false\n',
  },
  {
    name: 'the seat autopilot steers away from its target',
    file: 'src/game/autopilot.ts',
    from: '      controls.pitch = clamp(t.pitch * STEER_GAIN + (closing ? jinkPitch : 0))\n      controls.yaw = clamp(t.yaw * STEER_GAIN + (closing ? jinkYaw : 0))\n',
    to: '      controls.pitch = clamp(-t.pitch * STEER_GAIN + (closing ? jinkPitch : 0))\n      controls.yaw = clamp(-t.yaw * STEER_GAIN + (closing ? jinkYaw : 0))\n',
  },
  /* ---- Transport: the session protocol ------------------------------------ */
  {
    name: 'the host flies whatever seat an intent claims',
    file: 'src/net/session.ts',
    from: '    if (frame.seat !== peer.seat) {\n      stats.wrongSeat++\n      return\n    }',
    to: '',
  },
  {
    name: 'the host replays an intent for a tick already flown',
    file: 'src/net/session.ts',
    from: '    if (frame.tick <= peer.lastTick) {\n      stats.stale++\n      return\n    }',
    to: '',
  },
  {
    name: 'a lost intent snaps the seat to neutral',
    file: 'src/net/session.ts',
    from: '          admitIntent(undefined, held, STEP, scratch)\n          Object.assign(held, scratch)',
    to: '          Object.assign(held, neutral())',
  },
  {
    name: 'the client applies a snapshot older than the last',
    file: 'src/net/session.ts',
    from: '        if (world.tick <= hostTick) {\n          stats.stale++\n          return\n        }',
    to: '',
  },
  {
    name: 'the host seats a peer where there is no seat',
    file: 'src/net/session.ts',
    from: '      const seat = peers.findIndex((p, i) => i > 0 && p === null)',
    to: '      const seat = Math.max(1, peers.findIndex((p, i) => i > 0 && p === null))',
  },
  {
    name: 'a repeated hello is ignored',
    file: 'src/net/session.ts',
    from: '      peer.channel.send(encodeWelcome(peer.seat, setup))\n      return',
    to: '      return',
  },
  {
    name: 'the loopback never loses a frame',
    file: 'src/net/channel.ts',
    from: '        if (rng() < loss) {',
    to: '        if (false) {',
  },

  /* ---- Prediction ---------------------------------------------------------- */
  {
    name: 'reconcile never replays',
    file: 'src/game/game.ts',
    from: '    for (const c of replay) s.ship.step(c, STEP, dryCtx)\n',
    to: '',
  },
  {
    name: 'predict records the intent but never flies it',
    file: 'src/game/game.ts',
    from: '    recordControls(s, controls)\n    s.ship.step(s.lastControls, STEP, dryCtx)',
    to: '    recordControls(s, controls)',
  },
  {
    name: 'the host never acknowledges an intent',
    file: 'src/net/session.ts',
    from: '        game.acknowledge(seat, peer ? peer.flownTick : -1)',
    to: '        game.acknowledge(seat, -1)',
  },

  /* ---- Match rules: attribution and the feed ------------------------------- */
  {
    name: 'a kill with no author pays seat 0 whatever the roster',
    file: 'src/game/game.ts',
    from: '    return seatOf(seats, from) ?? lastHitter.get(victim) ?? soleSeat()',
    to: '    return seatOf(seats, from) ?? lastHitter.get(victim) ?? seats[0] ?? null',
  },
  {
    name: 'a kill with no author pays nobody, even the last hitter',
    file: 'src/game/game.ts',
    from: '    return seatOf(seats, from) ?? lastHitter.get(victim) ?? soleSeat()',
    to: '    return seatOf(seats, from) ?? soleSeat()',
  },
  {
    name: 'the last hitter is never remembered',
    file: 'src/game/game.ts',
    from: '      if (direct) {\n        lastHitter.set(self, direct)\n        creditHit(direct, amount)\n        return\n      }',
    to: '      if (direct) {\n        creditHit(direct, amount)\n        return\n      }',
  },
  {
    name: "the arena's damage is nobody's, even in a match of one",
    file: 'src/game/game.ts',
    from: '    if (from === FACTION_ENVIRONMENT) return lastHitter.get(victim) ?? soleSeat()',
    to: '    if (from === FACTION_ENVIRONMENT) return null',
  },
  {
    name: 'a hit on a participant pays nothing',
    file: 'src/game/game.ts',
    from: '            lastHitter.set(self, direct)\n            creditHit(direct, amount)',
    to: '            lastHitter.set(self, direct)',
  },
  {
    name: 'a participant kill pays the victim',
    file: 'src/game/game.ts',
    from: '          const scorer = owed && owed !== seat ? owed : null',
    to: '          const scorer = owed',
  },
  {
    name: "a participant's hull is worth the same as the squadron's",
    file: 'src/game/game.ts',
    from: '          const award = scorer ? creditKill(scorer, Math.round(self.spec.bounty * PARTICIPANT_BOUNTY_MULT)) : 0',
    to: '          const award = scorer ? creditKill(scorer, self.spec.bounty) : 0',
  },
  {
    name: 'a mirror announces every kill in every snapshot',
    file: 'src/game/game.ts',
    from: '      if (e.seq > feedSeen) {\n        feedSeen = e.seq\n        announceKill(e)\n      }',
    to: '      announceKill(e)',
  },
  {
    name: 'the feed ring never lets go',
    file: 'src/game/game.ts',
    from: '    if (feed.length > FEED_RING) feed.shift()',
    to: '',
  },
  {
    name: 'the feed is never captured',
    file: 'src/game/game.ts',
    from: '      feed: feed.map((e) => ({ ...e })),',
    to: '      feed: [],',
  },
  {
    name: 'a scrape is blamed on the other side again',
    file: 'src/game/ship.ts',
    from: '        this.takeDamage(Math.min(55, 4 + impact * 0.1), FACTION_ENVIRONMENT)',
    to: '        this.takeDamage(Math.min(55, 4 + impact * 0.1), (this.faction === 0 ? -1 : 0) as Faction)',
  },

  /* ---- Match rules: the result ------------------------------------------- */
  {
    name: 'an eliminated seat places by score like a flying one',
    file: 'src/game/game.ts',
    from: '  const order = lines.slice().sort((a, b) => (a.alive === b.alive ? b.score - a.score : a.alive ? -1 : 1))',
    to: '  const order = lines.slice().sort((a, b) => b.score - a.score)',
  },
  {
    name: 'equal scores do not share a place',
    file: 'src/game/game.ts',
    from: '    if (!prev || prev.alive !== line.alive || prev.score !== line.score) place = i + 1',
    to: '    place = i + 1',
  },
  {
    name: 'the finishing bonus is paid to the eliminated too',
    file: 'src/game/game.ts',
    from: '      const bonus = cleared && alive ? Math.round(seat.ship.hullFraction * 1200) + timeBonus : 0',
    to: '      const bonus = cleared ? Math.round(seat.ship.hullFraction * 1200) + timeBonus : 0',
  },
  {
    name: 'the host never tells its peers the match ended',
    file: 'src/net/session.ts',
    from: '        if (++sinceResult >= HELLO_EVERY) {',
    to: '        if (false) {',
  },
  {
    name: 'the result is said once and never again',
    file: 'src/net/session.ts',
    from: '          sinceResult = 0\n          const bytes = encodeResult(result)',
    to: '          sinceResult = Number.NEGATIVE_INFINITY\n          const bytes = encodeResult(result)',
  },
  {
    name: 'the host snapshots a roster of nobody on the resolving tick',
    file: 'src/net/session.ts',
    from: '      if (++sinceSnapshot >= snapshotEvery && game.active) {',
    to: '      if (++sinceSnapshot >= snapshotEvery) {',
  },
  {
    name: 'a mirror ignores the result',
    file: 'src/net/session.ts',
    from: '      queue.length = 0\n      game.conclude(result)',
    to: '      queue.length = 0',
  },
  {
    name: 'a mirror reports seat 0 whatever seat it flies',
    file: 'src/game/game.ts',
    from: '    const line = mine ? result.lines.find((l) => l.seat === mine.index) : undefined\n    lastResult = result',
    to: '    const line = result.lines[0]\n    lastResult = result',
  },

  /* ---- Snapshot pacing ----------------------------------------------------- */
  {
    name: 'the client applies a snapshot the tick it arrives',
    file: 'src/net/session.ts',
    from: '        if (!pace) {\n          applySnapshot(world)\n          return\n        }',
    to: '        if (true) {\n          applySnapshot(world)\n          return\n        }',
  },
  {
    name: 'a tick nothing arrived for is a stall, not a coast',
    file: 'src/net/session.ts',
    from: '  function coast(): void {\n    game.coast(predict ? seat : -1)',
    to: '  function coast(): void {',
  },
  {
    name: 'a gap in the queue is applied straight away',
    file: 'src/net/session.ts',
    from: '    if (hostTick >= 0 && queue[0].tick > hostTick + 1 && coastedAt !== hostTick) {',
    to: '    if (false) {',
  },
  {
    name: 'the client never drains a backlog',
    file: 'src/net/session.ts',
    from: '    if (queue.length > SNAPSHOT_DEPTH) {\n      applySnapshot(queue.shift()!)\n      stats.skipped++\n    }',
    to: '',
  },
  {
    name: 'the client queues the same tick twice',
    file: 'src/net/session.ts',
    from: '    if (at > 0 && queue[at - 1].tick === world.tick) return false',
    to: '',
  },
  {
    name: 'a coast holds every hull where it was',
    file: 'src/game/game.ts',
    from: '    ship.prevQuaternion.copy(ship.quaternion)\n    ship.position.addScaledVector(ship.velocity, STEP)\n  }',
    to: '    ship.prevQuaternion.copy(ship.quaternion)\n  }',
  },
  {
    name: 'a coast leaves the bolts behind',
    file: 'src/game/bolts.ts',
    from: '        bolt.prev.copy(bolt.pos)\n        bolt.pos.addScaledVector(bolt.vel, dt)\n      }\n    },',
    to: '        bolt.prev.copy(bolt.pos)\n      }\n    },',
  },
  {
    name: 'the client replays intents the host already flew',
    file: 'src/net/session.ts',
    from: '      while (buffer.length > 0 && buffer[0].tick <= ack) buffer.shift()\n',
    to: '',
  },
  {
    name: 'a predicted shot fires a real bolt',
    file: 'src/game/game.ts',
    from: '    bolts: { ...bolts, fire() {} },',
    to: '    bolts,',
  },

  /* ---- Link monitor: a dropped link is noticed ---------------------------- */
  {
    name: 'a dropped link is down at once, with no grace',
    file: 'src/net/link.ts',
    from: "      if (held >= grace) move('down', `ice disconnected for ${Math.round(held / 1000)} s`)",
    to: "      if (held >= 0) move('down', `ice disconnected for ${Math.round(held / 1000)} s`)",
  },
  {
    name: 'a recovered link stays degraded',
    file: 'src/net/link.ts',
    from: "      if (ice === 'connected' || ice === 'completed') {\n        move('up', `ice ${ice}`)",
    to: "      if (ice === 'connected' || ice === 'completed') {\n        // recovered, but nobody is told",
  },
  {
    name: 'a link that went down can come back up',
    file: 'src/net/link.ts',
    from: "    if (state === 'down' || next === state) return",
    to: "    if (next === state) return",
  },
  {
    name: 'the channel closing is not the link going down',
    file: 'src/net/link.ts',
    from: "    closed() {\n      move('down', 'channel closed')\n    },",
    to: "    closed() {},",
  },
  {
    name: 'a second outage inherits the first one\'s clock',
    file: 'src/net/link.ts',
    from: "        if (state === 'up') degradedAt = now()",
    to: "        if (degradedAt === 0) degradedAt = now()",
  },

  /* ---- Scoring attribution ----------------------------------------------- */
  {
    name: 'every hit is credited to seat 0',
    file: 'src/game/game.ts',
    from: '      const direct = seatOf(seats, from)\n      if (direct) {',
    to: '      const direct = seats[0]\n      if (direct) {',
  },
  {
    name: 'every kill is credited to seat 0',
    file: 'src/game/game.ts',
    from: '    return seatOf(seats, from) ?? lastHitter.get(victim) ?? soleSeat()',
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
    from: '    if (!matchStillRunning()) resolveMatch(false)',
    to: '    if (!anySeatFlying()) resolveMatch(false)',
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
    from: '    const report = pendingResult\n      ? { ...pendingResult, match: match.lines.length > 1 ? match : undefined }\n      : line',
    to: '    const report = line',
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
    // Retained for diagnosis: with `status === null` this is the only thing that says
    // what stopped the run.
    signal: r.signal ?? null,
    ok: (out.match(/^ {2}ok/gm) ?? []).length,
    fail: (out.match(/^ {2}FAIL/gm) ?? []).length,
    named: (out.match(/^ {2}FAIL (.*)$/gm) ?? []).map((l) => l.replace(/^ {2}FAIL /, '')),
    last: lines.length > 0 ? lines[lines.length - 1].trim() : '(no output)',
  }
}

/**
 * How many assertions `check:sim` runs when nothing is wrong.
 *
 * Pinned, and deliberately brittle for the same reason the recorded baseline in
 * `simcheck.ts` is: it is the only thing that can tell "the suite is green" from "the suite
 * is green and ran everything". Green-and-short is the dangerous shape, because every
 * verdict here is "did the suite report a failure" and a suite missing a whole test still
 * reports none.
 *
 * If you added or removed checks on purpose, bump this in the same commit. If you did not,
 * something stopped running.
 */
const EXPECTED_ASSERTIONS = 629
const PASS_SUMMARY = 'All checks passed.'
const SUMMARY = /check\(s\) failed\.$|All checks passed\.$/

/**
 * What a mutation run means. **The only place that decides.**
 *
 * It was two places, which is the defect this replaces: the loop had one rule and the
 * self-test meant to protect that rule computed its own equivalent. Deleting the
 * assertion-count clause from the loop's copy left the self-test printing "the verdict
 * bites" and all 47 mutants reported caught — a regression guard passing while the thing it
 * guards was gone. A rule with two implementations is a rule with one untested one.
 *
 * Only `CAUGHT` is a pass:
 *
 * - **CAUGHT** — the suite named failures, exited non-zero, and ran every expected
 *   assertion. All three clauses have caught something real.
 * - **CAUGHT-THEN-ABORTED** — named failures but did not finish the run. Whatever came
 *   after is unmeasured, so this is a gap rather than a clean catch.
 * - **BROKEN-GATE** — printed failures and **exited 0**. The mutation is beside the point:
 *   `npm run check:sim` would have reported success to CI, so nothing this run says can be
 *   trusted. Reproduced by changing the suite's footer to `process.exit(0)`, after which
 *   every mutant looked caught and the job passed.
 * - **KILLED** — terminated by a signal, so `status` is `null`. Avoiding "clean exit" was
 *   not enough: every non-zero status was then treated alike, and a run that had printed a
 *   complete failure summary before being killed read as `CAUGHT`. A signal is not a
 *   verdict — the suite did not decide anything, something else stopped it.
 * - **CRASH-ONLY** — died without naming a failure. Still stops a merge, but the diagnostic
 *   is "39 of 201 ran" instead of the property that broke.
 * - **SURVIVED** — green. Either the check is missing or the mutation is genuinely
 *   unobservable; the difference has to be established, not assumed.
 */
function classify(result) {
  const complete = SUMMARY.test(result.last) && result.ok + result.fail === EXPECTED_ASSERTIONS
  // Three states, not two: exited zero, exited non-zero, or never exited at all.
  // `spawnSync().status` is `null` in that third case and `null !== 0` is true, which is how
  // a killed process came to be read as a failing one.
  if (!Number.isInteger(result.code)) return 'KILLED'
  if (result.fail > 0) {
    if (result.code === 0) return 'BROKEN-GATE'
    return complete ? 'CAUGHT' : 'CAUGHT-THEN-ABORTED'
  }
  return result.code === 0 ? 'SURVIVED' : 'CRASH-ONLY'
}

/**
 * Why a control run cannot be trusted, or `null` if it can.
 *
 * Five ways it fails, and only the first two were checked before. A run that exits 0 with
 * 348 of 414 assertions and prints its own cheerful summary satisfied the old guard
 * completely — reproduced by deleting one nine-assertion invocation, after which all mutants
 * were still reported caught and the harness exited 0.
 */
function controlProblem(r) {
  if (!Number.isInteger(r.code)) {
    return `it was killed by ${r.signal ?? 'a signal'} rather than exiting`
  }
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

/**
 * Apply a set of `[file, from, to]` patches, run the suite, and put everything back.
 *
 * Shared by the self-tests so each one is a fixture plus an expected verdict and nothing
 * else. Refuses unless every pattern matches exactly once, because a self-test whose patch
 * silently missed is a self-test that proves nothing.
 */
function runPatched(label, patches) {
  const saved = patches.map(([file]) => [file, readFileSync(file, 'utf8')])
  for (const [file, from] of patches) {
    const source = saved.find(([f]) => f === file)[1]
    const hits = source.split(from).length - 1
    if (hits !== 1) {
      for (const [f, text] of saved) writeFileSync(f, text)
      console.error(
        `Refusing to run: the ${label} self-test pattern matched ${hits} times in ${file}. ` +
          'Its guard would go unexercised.',
      )
      process.exit(2)
    }
  }
  // Applied in a second pass so multiple patches to one file compose.
  for (const [file, from, to] of patches) {
    writeFileSync(file, readFileSync(file, 'utf8').split(from).join(to))
  }
  try {
    return runSuite()
  } finally {
    for (const [file, text] of saved) writeFileSync(file, text)
  }
}

const argv = process.argv.slice(2)
const fixtureArg = argv.find((a) => a.startsWith('--fixture='))
const only = argv.find((a) => !a.startsWith('--'))

/**
 * Run a list of mutations and count the verdicts.
 *
 * Extracted so that the self-check fixtures below travel the *same* path as real
 * mutations — loop, `classify`, counters, and the exit decision. The previous version
 * inlined all of that, so the fixtures could only ever reach `classify`: replacing the
 * loop's use of its answer with a bare `'CAUGHT'` left all three self-tests green, 47
 * mutants reported caught, and the job exiting 0.
 */
function runMutations(list) {
  const counts = { caught: 0, notClean: 0, survived: 0, unapplied: 0 }

  for (const [i, m] of list.entries()) {
    if (only !== undefined && String(i) !== only && !m.name.includes(only)) continue

    // One entry may carry several patches: a fixture needs to be, say, loud *and* short at
    // once, which takes a real mutation plus a removed test invocation.
    const patches = m.patches ?? [[m.file, m.from, m.to]]
    const saved = [...new Set(patches.map(([file]) => file))].map((file) => [
      file,
      readFileSync(file, 'utf8'),
    ])
    const missed = patches.find(([file, from]) => {
      const source = saved.find(([f]) => f === file)[1]
      return source.split(from).length - 1 !== 1
    })
    if (missed) {
      // A mutation that no longer applies is not a pass. It means the code moved and this
      // entry is now testing nothing, which is worth failing over.
      console.log(`[${i}] ${m.name}\n     PATCH DID NOT APPLY (in ${missed[0]}) — NOT TESTED`)
      counts.unapplied++
      continue
    }

    for (const [file, from, to] of patches) {
      writeFileSync(file, readFileSync(file, 'utf8').split(from).join(to))
    }
    let result
    try {
      result = runSuite()
    } finally {
      for (const [file, text] of saved) writeFileSync(file, text)
    }

    const verdict = classify(result)
    if (verdict === 'CAUGHT') counts.caught++
    else if (verdict === 'SURVIVED') counts.survived++
    else counts.notClean++

    console.log(`[${i}] ${m.name}`)
    console.log(
      `     exit=${result.code}${result.signal ? ` signal=${result.signal}` : ''} ` +
        `ok=${result.ok} FAIL=${result.fail} ` +
        `(${result.ok + result.fail}/${EXPECTED_ASSERTIONS} ran) last=${JSON.stringify(result.last)} -> ${verdict}`,
    )
    for (const name of result.named.slice(0, 6)) console.log(`       - ${name}`)
    if (result.named.length > 6) console.log(`       ... and ${result.named.length - 6} more`)
  }

  return counts
}

/**
 * Turn the counts into the process's exit status. **The only place that decides.**
 *
 * Separate from the loop for the same reason `classify` is separate from its callers: the
 * self-check below drives fixtures through this exact function rather than re-deriving
 * what their exit ought to be.
 */
function finalVerdict(counts, total) {
  const { caught, notClean, survived, unapplied } = counts
  console.log(
    `\n${caught} caught cleanly, ${notClean} not cleanly caught, ${survived} survived, ` +
      `${unapplied} not testable`,
  )

  const ran = caught + notClean + survived + unapplied
  if (ran === 0) {
    console.error(
      only === undefined
        ? '\nRefusing to pass: no mutations ran. The list is empty.'
        : `\nRefusing to pass: no mutation matched ${JSON.stringify(only)}. Nothing was tested.`,
    )
    return 2
  }
  if (only !== undefined && ran < total) {
    console.log(`\nFiltered run: ${ran} of ${total} mutations. Not a full verdict.`)
  }
  if (notClean > 0 || survived > 0 || unapplied > 0) {
    console.log(
      '\nOnly CAUGHT is a pass. A mutation that survived, aborted, was killed, crashed\n' +
        'without naming a failure, exited zero while printing failures, or no longer applies\n' +
        'is a gap in the suite.',
    )
    return 1
  }
  console.log(`\nAll ${ran} mutations were caught by a named assertion.`)
  return 0
}

/*
 * Fixtures for the self-check, kept out of `MUTATIONS` so the ordinary run cannot fail on
 * them. Each is run *as a child process* — `node scripts/mutate.mjs --fixture=N` — so the
 * thing under test is the real command's real exit status, not a prediction of it.
 */
const FIXTURES = [
  {
    name: 'fixture: an inert change — SURVIVED, must fail the job',
    file: 'src/ui/screens.ts',
    from: 'export type Screen =',
    to: '/* canary */ export type Screen =',
    expectExit: 1,
  },
  {
    name: 'fixture: a pattern that no longer applies — must fail the job',
    file: 'src/ui/screens.ts',
    from: 'a string that is deliberately not present in this file',
    to: 'unreachable',
    expectExit: 1,
  },
  {
    /*
     * The one the first version of this section was missing, and the gap was exactly the
     * finding: with only a survivor, an unapplied patch and a clean catch, a loop that
     * returned `'CAUGHT'` for *any* failing run passed every fixture — because none of them
     * was a failing run that should have been judged something else.
     *
     * Loud and short at once: a real mutation plus a removed test invocation.
     */
    name: 'fixture: loud but short — CAUGHT-THEN-ABORTED, must fail the job',
    patches: [
      ['scripts/simcheck.ts', '\ntestTwoScorersKeepSeparateStreaks()\n', '\n'],
      [
        'src/ui/screens.ts',
        '      if (!host.pause()) return\n      host.showPanel()',
        '      host.pause()\n      host.showPanel()',
      ],
    ],
    expectExit: 1,
  },
  {
    name: 'fixture: a real mutation — CAUGHT, must pass the job',
    file: 'src/ui/screens.ts',
    from: "      host.showPanel()\n      screen = 'paused'",
    to: '      host.showPanel()',
    expectExit: 0,
  },
]

if (fixtureArg) {
  /*
   * Child mode. No self-tests, no control, no recursion — just one fixture through the
   * production loop and the production exit decision.
   */
  const at = Number(fixtureArg.slice('--fixture='.length))
  const fixture = FIXTURES[at]
  if (!fixture) {
    console.error(`No fixture ${at}.`)
    process.exit(2)
  }
  process.exit(finalVerdict(runMutations([fixture]), FIXTURES.length))
}

const changed = dirty()
if (changed) {
  console.error('Refusing to run: the working tree has uncommitted changes.\n')
  console.error(changed)
  console.error('\nThis harness edits source files in place and restores them. Commit or stash first.')
  process.exit(2)
}

console.log('NEON ORBIT — mutation runs against scripts/simcheck.ts\n')

/*
 * Self-tests, before anything else: prove the deciders can *reject*.
 *
 * A guard nobody has watched refuse anything is documentation — and an earlier version was
 * worse than that, because it built its own copy of the verdict rule and kept passing after
 * the real rule lost its assertion-count clause. Every fixture below is checked against the
 * *production* function, `controlProblem` or `classify`, or against the production command
 * itself. There is no second implementation to drift.
 *
 * Ordered by dependency, not by narrative. The exit contract comes first because if the
 * suite cannot tell its caller it failed, no verdict about anything else means anything —
 * the first version ran completeness first, so a broken exit contract was reported as a
 * completeness problem.
 */
const SELF_TEST_FILE = 'scripts/simcheck.ts'
const SELF_TEST_ANCHOR = '\ntestTwoScorersKeepSeparateStreaks()\n'
/** A real mutation, so a fixture can be made to fail loudly on demand. */
const BREAK_PAUSE = [
  'src/ui/screens.ts',
  '      if (!host.pause()) return\n      host.showPanel()',
  '      host.pause()\n      host.showPanel()',
]
/** The suite's own exit contract. */
const BREAK_EXIT = [SELF_TEST_FILE, 'process.exit(failures === 0 ? 0 : 1)', 'process.exit(0)']
const DROP_A_TEST = [SELF_TEST_FILE, SELF_TEST_ANCHOR, '\n']

{
  /* 1. Loud, complete — and exiting zero. The gate itself is broken: `npm run check:sim`
        would report success to CI while printing failures, so no mutation verdict from
        such a run is worth reading, however many appear to be caught. */
  const loudButPassing = runPatched('zero-exit', [BREAK_EXIT, BREAK_PAUSE])
  const gateVerdict = classify(loudButPassing)
  console.log(
    `self-test 1 — loud, exits zero:   exit=${loudButPassing.code} ok=${loudButPassing.ok} ` +
      `FAIL=${loudButPassing.fail} (${loudButPassing.ok + loudButPassing.fail}/${EXPECTED_ASSERTIONS}) ` +
      `-> ${gateVerdict}`,
  )
  if (loudButPassing.fail === 0 || loudButPassing.code !== 0) {
    console.error(
      '\nRefusing to run: that fixture was supposed to print failures and exit 0, and did not, ' +
        `so it proves nothing about a broken gate (exit=${loudButPassing.code}, FAIL=${loudButPassing.fail}).`,
    )
    process.exit(2)
  }
  if (gateVerdict !== 'BROKEN-GATE') {
    console.error(
      `\nRefusing to run: classify() called a zero-exit failing run ${gateVerdict}. ` +
        'A suite that reports failures and tells CI it passed is not a caught mutation.',
    )
    process.exit(2)
  }

  /* 2. Green but short. The *control* guard owns this one: a suite missing a whole test
        still passes, so nothing downstream can tell it from a complete run. */
  const short = runPatched('short-control', [DROP_A_TEST])
  const complaint = controlProblem(short)
  console.log(
    `self-test 2 — green but short:    exit=${short.code} ok=${short.ok} FAIL=${short.fail} ` +
      `-> ${complaint ?? 'ACCEPTED'}`,
  )
  if (short.fail !== 0 || short.code !== 0) {
    console.error(
      '\nRefusing to run: that fixture was supposed to stay green, so it proves nothing about ' +
        'a green-but-short run. Pick an anchor whose absence leaves the suite passing.',
    )
    process.exit(2)
  }
  if (!complaint) {
    console.error('\nRefusing to run: the control guard accepted a suite with a whole test missing.')
    process.exit(2)
  }

  /* 3. Loud but short — the per-mutant verdict, through `classify` itself. */
  const loudShort = runPatched('short-mutant', [DROP_A_TEST, BREAK_PAUSE])
  const shortVerdict = classify(loudShort)
  console.log(
    `self-test 3 — loud but short:     exit=${loudShort.code} ok=${loudShort.ok} ` +
      `FAIL=${loudShort.fail} (${loudShort.ok + loudShort.fail}/${EXPECTED_ASSERTIONS}) ` +
      `-> ${shortVerdict}`,
  )
  if (loudShort.fail === 0 || loudShort.code === 0) {
    console.error(
      '\nRefusing to run: that fixture was supposed to fail loudly *and* exit non-zero ' +
        `(got exit=${loudShort.code}, FAIL=${loudShort.fail}), so it cannot test completeness.`,
    )
    process.exit(2)
  }
  if (shortVerdict !== 'CAUGHT-THEN-ABORTED') {
    console.error(
      `\nRefusing to run: classify() called an incomplete failing run ${shortVerdict}. ` +
        'A mutant that hides assertions must not read as cleanly caught.',
    )
    process.exit(2)
  }

  /*
   * 4. Every status a suite run can end in, put straight through `classify`.
   *
   * A `spawnSync` result is a handful of fields, so these are exact inputs rather than
   * stand-ins — and the null-status rows are the ones that mattered. Avoiding "clean exit"
   * was not the same as handling "never exited": every non-zero status was treated alike,
   * so a run killed by a signal after printing a complete failure summary read as `CAUGHT`.
   */
  // Derived from the constant rather than written beside it: the first version
  // said `ok: 408`, which was 414 - 6 spelled out, and it went stale the first
  // time the suite grew.
  const LOUD = { ok: EXPECTED_ASSERTIONS - 6, fail: 6, last: '6 check(s) failed.' }
  const statuses = [
    ['killed mid-run, complete output', { ...LOUD, code: null, signal: 'SIGKILL' }, 'KILLED'],
    ['killed with nothing to show', { ok: 30, fail: 0, last: 'Node.js v22', code: null }, 'KILLED'],
    ['failures, exited zero', { ...LOUD, code: 0 }, 'BROKEN-GATE'],
    ['failures, exited one, complete', { ...LOUD, code: 1 }, 'CAUGHT'],
    ['failures, exited one, short', { ok: 100, fail: 6, last: '6 check(s) failed.', code: 1 }, 'CAUGHT-THEN-ABORTED'],
    ['no failures, died anyway', { ok: 30, fail: 0, last: 'Node.js v22', code: 1 }, 'CRASH-ONLY'],
    ['clean and complete', { ok: EXPECTED_ASSERTIONS, fail: 0, last: 'All checks passed.', code: 0 }, 'SURVIVED'],
  ]
  const wrong = statuses.filter(([, result, want]) => classify(result) !== want)
  console.log(`self-test 4 — every exit status:  ${statuses.length} exact shapes through classify()`)
  if (wrong.length > 0) {
    console.error(
      '\nRefusing to run: classify() disagreed on ' +
        wrong
          .map(([label, result, want]) => `${label} (wanted ${want}, got ${classify(result)})`)
          .join('; '),
    )
    process.exit(2)
  }

  /*
   * 5. The verdict *consumer*, driven as a child process.
   *
   * Everything above stops at `classify`, which left the loop free to ignore its answer:
   * replacing the loop's use of it with a bare `'CAUGHT'` kept every self-test green, had
   * all 47 mutants reported caught, and exited 0 — including a sentinel that printed one
   * failure and stopped partway.
   *
   * So these run `node scripts/mutate.mjs --fixture=N` and assert **the real command's real
   * exit status**: loop, `classify`, counters, `finalVerdict`, `process.exit`, with nothing
   * left between the verdict and the number CI reads. Two fixtures must fail the job and
   * one must pass it, so "it always fails" cannot satisfy them either.
   */
  console.log('self-test 5 — the job’s own exit status, through child runs:')
  for (const [at, fixture] of FIXTURES.entries()) {
    const child = spawnSync(process.execPath, [process.argv[1], `--fixture=${at}`], {
      encoding: 'utf8',
    })
    console.log(`  [${at}] ${fixture.name}\n       exit=${child.status} (wanted ${fixture.expectExit})`)
    if (child.status !== fixture.expectExit) {
      console.error(
        `\nRefusing to run: fixture ${at} exited ${child.status} where ${fixture.expectExit} was ` +
          'required. The verdict does not reach the exit status.\n\n' +
          (child.stdout ?? '') +
          (child.stderr ?? ''),
      )
      process.exit(2)
    }
  }
  console.log('  (three shapes of non-pass fail the job; only a clean catch passes it)\n')
}

/*
 * The control run, and it is not ceremony.
 *
 * Every verdict below is "did the suite report a failure", which is only evidence that the
 * *mutation* did something if the suite reported none to begin with. Against an already
 * failing suite this harness prints "47 caught" and exits 0 while proving nothing at all —
 * the same shape as comparing two empty strings, which this codebase has now recorded five
 * times.
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

process.exit(finalVerdict(runMutations(MUTATIONS), MUTATIONS.length))
