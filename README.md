# NEON ORBIT

A low-poly space fighter dogfight in low orbit above a lush green world. Pick one of three
airframes, then fight the other two.

Star Fox 64 silhouettes, Quake 1 grime, cyberpunk neon. Runs entirely in the browser — no
server, no accounts, no build-time assets.

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

## Controls

| Input | Action |
|---|---|
| `W` / `S` | Throttle up / down |
| Mouse | Steer (click the canvas to capture the pointer) |
| `↑` `↓` `A` `D` | Steer without a mouse |
| `Q` / `E` | Roll left / right |
| `Space` or left click | Fire |
| `F` or right click | Hold to spool the BFG, release to abort |
| `Shift` | Phase dash (Hornet only) |
| `Tab` / `T` | Switch target lock |
| `Esc` / `P` | Pause |
| `M` | Mute |
| `I` | Invert pitch |

The mouse is a **virtual stick**, not an FPS look control: movement pushes a deflection that
self-centres, and the ship's own turn rate scales it. That keeps turn rate a balance lever
instead of a property of your mouse. Sensitivity and self-centring live at the top of
`src/core/input.ts`.

**Put the nose on the lead pip, not on the hull.** The magenta circle is where to aim for the
shot to connect against a target crossing at hundreds of units per second. The bottom-right
panel shows the locked target's hull and range.

## The three airframes

| | Wasp `SK-09` | Hornet `AV-22` | Drone `BX-40` |
|---|---|---|---|
| Role | Glass cannon | Fleet standard | Gun platform |
| Hull | 70 | 120 | 200 |
| Top speed | 470 | 355 | 250 |
| Turn rate | 1.95 rad/s | 1.45 rad/s | 0.95 rad/s |
| Guns | 5 dmg @ 0.085s | 10 dmg × 2 @ 0.30s | 20 dmg × 2 @ 0.86s |
| Sustained DPS | 47 | 67 | 47 |
| Quirk | Guns overheat and lock out | Phase dash — untargetable mid-dash | Hull self-repairs after 6.5s |

Whichever you pick, three of each of the other two types make up the opposing squadron. Clear
all six to win; lose your hull and the run is recorded as a loss. High scores are per-airframe,
in `localStorage`.

**Sustained DPS is what you hold, not what you peak at.** The Wasp's trigger is the fastest in
the fleet and its heat bar is the reason it does not run away with the game: heat vents only
while the trigger is up, so the airframe fires about three quarters of the time and a pilot who
feathers it out-damages a pilot who holds it down by roughly half. Let it redline and the guns
lock out for 2.9 seconds, which costs a third of your output. The card bars in the hangar are
*derived* from these numbers rather than typed in, so they cannot drift away from the flight
model — see `sustainedDps` in `src/ships/specs.ts`.

## The BFG

Officially a Bulk Fusion Generator. Nobody calls it that.

**Two rounds a run, no refills.** Hold `F` for 1.3 seconds and a slow green ball
leaves the nose; anything within 340 units of where it stops takes up to 260
damage, falling off sharply toward the edge. That kills any airframe in the game
outright at the centre and is a hard shove and a scare at the rim.

Three things make it a decision rather than a button:

**Charging costs you everything else.** While it spools the guns are cold, the
dash is locked and the throttle is capped at 55%. You are committing to a
heading for a second and a half in an arena where everyone else is still
manoeuvring.

**The blast does not care who fired it.** The pilot takes 60% — 156 damage at
point-blank, which kills a Wasp outright and takes a bite out of a Drone. The
distance you keep is the price of the damage you get.

**Hostiles run from a live round.** Each one registers as a steering hazard the
size of its own blast, so the AI scatters as it crosses the arena. A round that
hits nothing still breaks a formation off your tail, which makes it a zoning
tool as much as a killing one: fire it where you want people to *not be*. It
also chain-detonates any mines it goes off near.

Aborting a charge keeps the round, so a mispress costs you a moment rather than
a third of your firepower. The numbers all live at the top of `src/game/bfg.ts`.

## Hazards

**Stations** are solid on their core only — rings, trusses and solar panels are fly-through, so
threading a habitat ring at full throttle stays available. Hitting a core scrapes your hull and
bounces you off.

**Mines** are the red spiky ones. Twenty-six of them, scattered on a fixed seed, and they take
45 hull off anything that touches them — you, or a hostile that gets chased into one. That is
survivable in every airframe but costs a Wasp two thirds of its hull. Enemies steer around them,
but only loosely, so pressure can still push one onto a mine. They detonate once and stay gone
for the rest of the run.

## Power-ups

Thirteen pods on a fixed seed, floating and slowly turning. Fly through one to collect it.

| | Repair pod | Overdrive pod | Shield pod |
|---|---|---|---|
| Looks like | A green heart | A violet lightning bolt | A blue shield crest |
| Count | 5 | 4 | 4 |
| Effect | +35 hull | 2× fire rate for 10s | Damage refused for 10s |
| Comes back after | 25s | 30s | 30s |

Every pod is a **glyph inside a ring**. The ring is not decoration: the glyph is a flat extruded
plate, so it thins to a line twice per rotation, and a pickup you have to *recognise* rather than
merely spot cannot afford to vanish. The ring lies horizontal while the glyph stands upright in
it, so the two are never edge-on together.

**The pods are the minefield pointed the other way** — same seeded placement, same instanced
geometry, same contact test. That is deliberate. A mine is 45 flat damage and a repair pod is 35
flat healing, so both matter most to the thinnest hull: the Wasp fears the minefield exactly as
much as it loves the pods. The repair number stays *under* the mine number on purpose, or the
minefield stops being terrain you route around and becomes a toll you pay on the way through.

**Overdrive halves the fire interval and leaves bolt damage alone.** Total output goes up 2×, and
the way you see it is the rate of fire. That matters more than it sounds: because `spec.damage` is
untouched, alpha strike stays exactly where the balance harness pinned it, so no boosted volley
can one-shot a hull it could not one-shot before. It also does not discount gun heat, so a boosted
Wasp banks heat twice as fast and redlines in half the time — 1.6× sustained where the Hornet and
the Drone get the full 2×. The airframe that already fires fastest gains least from firing faster
still, which is the argument the heat quirk makes everywhere else. `scripts/balance.ts` measures
it and prints the table.

**A Shield refuses damage outright** — bolts, mines, station scrapes, the star. Three things
deliberately do not happen while it holds: the damage clock does not reset, so a shielded Drone
keeps repairing; the refused hit is not credited to the shooter, so it cannot inflate the accuracy
stat; and the ship stays targetable, so bolts still arrive and splash. A shield you cannot see
working is a shield nobody believes in.

Both timed pods **stack** — two Overdrives back to back buy twenty seconds, not ten. Stacking
duration is safe in a way stacking magnitude is not: the effect is a fixed 2× whether you hold one
pod or four, so the ceiling never moves and there is only one number to check. The HUD carries a
gauge and a live second count for each buff, and a centre countdown for the last five seconds.

Pods are player-only: nothing in `EnemyPilot` steers toward one, so a hostile collecting one would
be a coin flip with no tell and no counterplay — see the note at the top of `src/world/pickups.ts`.

## How it fits together

```
src/
  core/     stage (renderer + bloom), input, audio, scores, geo, rng
  ships/    stat specs, procedural hull geometry
  world/    planet, stations, mines, power-up pods, sky, arena assembly
  game/     flight model, AI, projectiles, effects, camera, HUD, orchestration
  ui/       hangar, pause and debrief screens
scripts/
  simcheck.ts   headless simulation checks
```

A few decisions worth knowing before changing things:

**One flight model, both sides.** `Ship` serves the player and every AI. `EnemyPilot` does not
move ships — it produces the same `Controls` struct the player produces and hands it to
`Ship.step`. An enemy Wasp is fast because a Wasp is fast, so it cannot cheat, and a balance
change lands on both sides at once.

**Everything is procedural.** No textures, no models, no audio files. Hulls and stations are
coarse primitives merged into non-indexed geometry so recomputed normals stay hard-faceted;
`src/core/geo.ts` is the single source of the *-Z is forward* convention. The planet is one
draw call — a faceted icosphere displaced and coloured per-facet from a sum-of-sine-bands
elevation field. Sound is oscillators and filtered noise built on demand.

**Additive glow stacks fast under bloom.** Ship accent materials sit around 0.45 opacity. Near
1.0 a 30-unit fighter becomes a white plasma ball. The arena boundary grid needs a *dim colour*
as well as low opacity, or bloom rediscovers it and paints a cage over the sky.

**The patrol boundary vetoes outward thrust rather than pushing back.** `velocity` chases
nose × maxSpeed at rate `grip`, so the engine asserts the most acceleration exactly when
velocity is zero — which means any additive counter-force has a depth where the two cancel and
the ship hangs motionless against the wall. Raising the force only relocates the stall. See the
comment in `Ship.integrate`.

## Checks

```bash
npm run check          # typecheck + headless simulation + balance
npm run check:sim      # simulation only, ~1s
npm run check:balance  # the balance matrix and its contract, ~4s
npm run build          # typecheck + production bundle
```

`scripts/simcheck.ts` runs the real flight model, projectiles, AI and game loop in Node — it is
all pure maths over three.js vector types, no canvas needed. It exists because in-browser
verification proved unreliable: a throttled tab stops firing `requestAnimationFrame`, which
silently freezes the loop and makes every behavioural observation meaningless. It asserts the
combat contract (hits land, kills register, friendly fire is off), the hull quirks, the
boundary, the power-up pods (placement, collection, respawn, that a boosted bolt still does
exactly its spec damage, that a Shield refuses damage without crediting the shooter, and that
both timed buffs stack, expire and do not survive a respawn), the BFG (spool, abort, ammo,
falloff, self-damage, mine chaining, and that charging really does silence the guns), and that
clearing the roster reports a win.

`scripts/balance.ts` is the same idea pointed at fairness instead of correctness. It flies pinned
duels — every airframe against every other, every bolt on target — and prints alpha strike,
burst and sustained DPS, a time-to-kill matrix, and what each hazard costs each hull. Those are
*ceilings* with the flying removed, which is the only way to compare guns; the Wasp's actual
defence is that nobody gets to shoot it under laboratory conditions. It then asserts the design
contract: trigger discipline must out-damage mashing, the spec sheet must match what the guns
measure, no airframe may run away with the firepower ranking, no matchup may end in under 0.6s,
and no hazard may one-shot a hull.

In `npm run dev`, `window.__neon` exposes the current screen, a read-only run snapshot
(including the bearing to the locked target's lead point) and `start(shipId)`. Dev builds only.

## Deploying to Vercel

Static output, framework auto-detected, `vercel.json` already committed:

```bash
npx vercel          # preview
npx vercel --prod   # production
```

Or import the repo in the Vercel dashboard and accept the defaults — build `npm run build`,
output `dist`. There is nothing server-side to configure.
