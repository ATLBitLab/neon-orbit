#!/usr/bin/env node
// Per-ship summary of the anonymous match stats (#64).
// Usage: node scripts/stats-summary.mjs [/var/lib/neon-orbit/match-stats.jsonl ...]
// Reads each file and its rotated `.1` sibling. Prints a table; --json for raw numbers.
import { readFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const files = args.filter(arg => arg !== '--json')
if (files.length === 0) files.push('/var/lib/neon-orbit/match-stats.jsonl')

const lines = []
for (const file of files) {
  for (const path of [`${file}.1`, file]) {
    if (!existsSync(path)) continue
    for (const text of readFileSync(path, 'utf8').split('\n')) {
      if (!text.trim()) continue
      try { lines.push(JSON.parse(text)) } catch { /* a torn last line is skipped */ }
    }
  }
}

const matches = new Map(lines.filter(line => line.type === 'match').map(line => [line.match, line]))
const players = lines.filter(line => line.type === 'player' && matches.has(line.match))
const median = values => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Repeat picks: within one browser session, does the next match keep the same hull?
const bySession = new Map()
for (const player of players) {
  if (!player.session) continue
  if (!bySession.has(player.session)) bySession.set(player.session, [])
  bySession.get(player.session).push(player)
}
const next = new Map()
for (const list of bySession.values()) {
  for (let i = 0; i + 1 < list.length; i++) next.set(list[i], list[i + 1])
}

const ships = {}
for (const player of players) {
  const s = ships[player.ship] ??= { picks: 0, followed: 0, repeated: 0, shots: 0, hits: 0,
    firstKills: [], noKill: 0, kills: 0, deaths: 0, quit: 0, rageQuit: 0, disconnect: 0, wins: 0 }
  s.picks++
  s.shots += player.shots
  s.hits += player.hits
  s.kills += player.kills
  s.deaths += player.deaths
  if (player.timeToFirstKillS === null) s.noKill++
  else s.firstKills.push(player.timeToFirstKillS)
  if (player.left === 'quit') s.quit++
  // Rage-quit: walked out mid-match after dying twice without a kill.
  if (player.left === 'quit' && player.deaths >= 2 && player.kills === 0) s.rageQuit++
  if (player.left === 'disconnect') s.disconnect++
  if (player.won) s.wins++
  const after = next.get(player)
  if (after) { s.followed++; if (after.ship === player.ship) s.repeated++ }
}

const pct = (n, d) => d > 0 ? Math.round(n / d * 1000) / 10 : null
const rows = Object.entries(ships).sort(([, a], [, b]) => b.picks - a.picks).map(([ship, s]) => ({
  ship,
  picks: s.picks,
  pickRate: pct(s.picks, players.length),
  repeatPick: pct(s.repeated, s.followed),
  repeatSample: s.followed,
  hitRate: pct(s.hits, s.shots),
  medianFirstKillS: median(s.firstKills),
  noKillRate: pct(s.noKill, s.picks),
  kd: s.deaths > 0 ? Math.round(s.kills / s.deaths * 100) / 100 : null,
  winRate: pct(s.wins, s.picks),
  quitRate: pct(s.quit, s.picks),
  rageQuitRate: pct(s.rageQuit, s.picks),
  disconnectRate: pct(s.disconnect, s.picks),
}))
const outcomes = {}
for (const match of matches.values()) outcomes[match.outcome] = (outcomes[match.outcome] ?? 0) + 1
const summary = { matches: matches.size, players: players.length, sessions: bySession.size,
  medianMatchS: median([...matches.values()].map(match => match.durationS)), outcomes, ships: rows }

if (json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`${summary.matches} matches, ${summary.players} player lines, ${summary.sessions} sessions, ` +
    `median match ${summary.medianMatchS ?? '-'} s, outcomes ${JSON.stringify(outcomes)}`)
  console.table(Object.fromEntries(rows.map(({ ship, ...rest }) => [ship, rest])))
  console.log('Rates are %. repeatPick = same hull next match in the same browser session (n = repeatSample).')
}
