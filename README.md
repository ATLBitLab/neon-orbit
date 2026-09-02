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

**A hostile that has just been hit wears its hull.** Losing hull lights a bar under that
hostile's bracket, which fades out over five seconds and snaps back to full brightness on
every fresh hit. Hostiles you have not touched show nothing, so the bars that are up are the
fight you are actually in — and for a readout that stays put, lock one and read the
bottom-right panel. The fade window is `DAMAGE_BAR_FADE` in `src/game/hud.ts`.

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

Pods are offered to participants only: nothing in `EnemyPilot` steers toward one, so a hostile
collecting one would be a coin flip with no tell and no counterplay — see the note at the top of
`src/world/pickups.ts`. The argument turns on steering rather than on sides, which is why it now
reads "every seat in the roster" rather than "the player".

## How it fits together

```
src/
  core/     stage (renderer + bloom), input, audio, scores, geo, rng, step clock
  ships/    stat specs, procedural hull geometry
  world/    planet, stations, mines, power-up pods, sky, arena assembly
  game/     flight model, AI, projectiles, effects, camera, HUD, orchestration
  ui/       hangar, pause and debrief screens
scripts/
  simcheck.ts   headless simulation checks
  balance.ts    the balance contract
  mutate.mjs    mutation runs against simcheck — `npm run check:mutants`
```

`mutate.mjs` breaks the code in one named way per entry and asserts the suite *reports* it. It
exists because every "would catch this" claim in this repo's review history was a run pasted from
someone's terminal, which is the same weakness the recorded baseline in `simcheck.ts` was added to
fix. Note its third and fourth verdicts: a mutant caught only by a crash, or one that names its
assertion and then aborts, has hidden every check after it and counts as a gap rather than a pass.

A few decisions worth knowing before changing things:

**One flight model, both sides.** `Ship` serves the player and every AI. `EnemyPilot` does not
move ships — it produces the same `Controls` struct the player produces and hands it to
`Ship.step`. An enemy Wasp is fast because a Wasp is fast, so it cannot cheat, and a balance
change lands on both sides at once.

**There is no `player` — there is a roster and a seat being drawn.** `Game.start` takes a
`MatchSetup` with one hull per seat, and `Game.step` takes **one `Controls` per seat**, so a ship
is flown by whatever intent was supplied for it and the simulation never asks where that came
from. Single-player is a match of one. The dividing line is worth stating exactly, because
everything else follows from it: **a seat decides outcomes, `local` only decides what is drawn.**
The camera, HUD, alarms and gun pitch read `local`; nothing that reads it may reach a hull, a
score or a result, or two machines watching one match would disagree about what happened in it.
`simcheck` asserts that directly by flying the same seed and the same intents from both seats and
demanding the two matches be identical — which is how two real leaks were found, both invisible
with one seat.

A faction is a seat index, minted through `humanFaction` and resolved back the other way by
lookup (`seatOf`). Never `humanFaction(seats.indexOf(x))`: `indexOf` returns -1 on a miss and -1
*is* the AI faction, so that line silently puts a human on the NPC side, where friendly fire makes
them unable to shoot the filler and the filler unable to shoot back. A miss has to mean "nobody",
which is a real answer, rather than a faction picked for it.

**Intent is admitted, not trusted.** `Controls` is about to be the packet format, and every
field in a packet is a claim. `src/game/intent.ts` is the anti-cheat surface: `bound` clamps a
deflection and reads a non-number as neutral (a single `NaN` would otherwise put a hull at `NaN`
for the rest of the match), `rampThrottle` is the *only* copy of the throttle ramp — the keyboard
in `controls.ts` and `admitIntent` on the wire both call it, so a sender cannot skip the ramp and
gain acceleration the airframe does not have — and `admitIntent` turns whatever arrived into one
legal tick, holding the last deflection and throttle for a late packet but never the triggers.
Two fields never reach a seat at all: `aim`, the AI's lead solution and otherwise a
fire-direction override, and `spread`, which draws from the seat's RNG when it is not zero. Those
two are dropped in `recordControls`, and `Game.step` flies the *record* rather than the caller's
struct, so what was simulated and what was recorded are one object by construction. The ramp is
deliberately not applied inside `Game.step`: its callers are the host's own code, the headless
suite drives seats on snapped throttles, and the wire boundary that unpacks a packet is what
calls `admitIntent`.

**The world crosses the wire as a snapshot a mirror draws, not a state it continues.** Under a
host-authoritative model the client never runs the host's simulation forward, so
`src/net/snapshot.ts` carries what a client needs to *show* the match — every hull's visible
state (squadron hulls with a stable spawn id), every seat's scoreline and phase, the bolt pool by
slot, pods and mines — and nothing it would need to *continue* it: no AI brains, no RNG streams,
no spawn queue. `Game.capture()` fills one, `Game.apply()` writes one back, and a mirror is a
`Game` that `start`s the same `MatchSetup`, never calls `step`, and applies each tick's snapshot
before rendering as normal. `src/net/wire.ts` is the byte codec (little-endian, float32,
versioned; a short, long or foreign frame throws before anything is applied) and the intent
frame, whose decoder ends in `admitIntent`. `simcheck` flies a host on the autopilot and demands
that a mirror fed its snapshots re-encodes to the host's exact bytes on every tick.

**Two browsers, one arena: the wire.** `src/net/session.ts` is the protocol and it is headless:
a host hands each peer a seat and the `MatchSetup` (WELCOME), takes tick-stamped intent frames back
(a peer drives only the seat it was given — authorisation is by channel, not by claim; a tick at
or before the last one flown is a replay and dropped; a missing tick holds the last intent minus
the triggers), and sends a snapshot every tick. `simcheck` runs it over `src/net/channel.ts`'s
loopback, once perfect (the client's world equals the host's byte for byte every tick) and once
with 30% loss, jitter and duplicates (nothing throws, every drop is counted, the client's world
equals the host's at whatever tick it last applied). The browser adapters are thin and carry no
policy: `webrtc.ts` (an unordered, no-retransmit `RTCDataChannel`) and `signal.ts` (offer/answer
over Nostr ephemeral events on public relays, so there is nothing to run — SDP is plaintext there,
which is named in the file rather than solved). **Try it:** open `?host` — the join code and a
COPY LINK button are on screen from the hangar onwards — and open the link on **another device**.
`?host=drone` picks the guest's hull. The join screen reports each stage (offer sent, answer
received, ice checking, connected) and names the failing one.

**Two tabs on one machine will usually not connect, and that is WebRTC, not this code.** Chrome
hides its LAN address behind an mDNS name and the only other route is back through your own
router, which most do not allow; a plain two-tab WebRTC test with no relay in between sits in
`ice checking` until it times out on the same Mac this was written on. Use a second device (a
phone on mobile data is the cleanest test), and on macOS make sure Chrome is allowed under
System Settings → Privacy & Security → Local Network. Two browsers behind a symmetric NAT need a
TURN relay: set `VITE_TURN_URL`, `VITE_TURN_USERNAME` and `VITE_TURN_CREDENTIAL` at build time.
None is configured by default, because a relay is exactly the infrastructure this project is
trying not to run.

**Death is a per-seat state, and respawn is a match policy.** A seat is `flying`, `wrecked` or
`eliminated` — one field with three shapes, because the version that used a nullable wreck meant
"never died" and "died, cutscene over" with the same value and so restarted an eliminated seat's
explosion every 2.4 seconds. `MatchSetup.respawn` decides whether a finished cutscene returns the
seat to the arena or leaves it out; the shipped single-player game leaves it off, because a run
that cannot be lost has no debrief to reach. Either way one participant's death does not stop the
arena — the squadron keeps flying and the wreck tumbles inside the ordinary tick.

**The match waits for every explosion it started.** It resolves when every seat is `eliminated`,
not when nobody is left *flying*: a seat mid-cutscene is neither, and treating it as finished let
one wreck's resolution clear another out from under it 85 ticks into its 144. A win is gated the
same way, because the squadron can empty on the very tick somebody dies. And it resolves on the
roster's state rather than the drawn seat's, or two machines watching one match would end it at
different moments.

**The simulation runs on a fixed step; rendering runs on the frame.** `Game.step()` advances
exactly 1/60s and takes no delta — there is deliberately no argument for a caller to vary.
`Game.render(alpha, frameDt)` draws whatever `step` left behind, where `alpha` is how far the
frame sits between the last two ticks. `Ship.syncVisual(alpha)`, `Bolts.render(alpha)` and the
chase camera all interpolate at that same `alpha`, so a display faster than 60 Hz looks smooth
and — just as important — everything on screen is smoothed *by the same amount*. A hull drawn
interpolated against bolts drawn on tick boundaries is worse than either drawn consistently.

`src/core/loop.ts` owns the accumulator that turns irregular frames into whole ticks. It is a
separate module for one reason: inline in the render loop it was the only load-bearing part of
the fixed step that no headless test could reach.

The split is what makes the flight model honest: with a variable delta the same stick input
covered different ground on a 30 Hz laptop and a 144 Hz desktop, so a hull's turn rate — the
lever the whole three-airframe design rests on — was not really one number. Keep the two halves
separate: nothing in `step` may read the camera or write a mesh transform, and nothing in
`render` may write simulation state.

There is exactly one exception, and it is narrow. `stepWreck` applies the wreck's
*rotation* to the mesh from inside `step`. It earns that because the tumble accumulates —
`g.quaternion.multiply(spin)` compounds whatever the mesh already holds rather than being a
function of elapsed time — so running it per frame would make the tumble rate depend on the
display, which is the exact thing the fixed step prevents. The wreck's *position* has no such
excuse and is interpolated in `render` like everything else.

The stronger statement of the rule, and the one worth keeping in mind: **everything drawn in one
frame must agree on which instant it depicts.** "Interpolate the hulls" is not enough, and has
been wrong twice — once with bolts left on tick boundaries while ships were smoothed, and once
with the camera smoothed while the wreck it was locked onto was not. Smoothing one consumer of a
shared pose relocates the mismatch rather than removing it, and a relative mismatch between two
things that should be pinned together reads worse than plain judder. `simcheck` asserts the
invariant directly by drawing one frozen simulation state at three blends and checking the middle
is the midpoint of the outer two.

**Gameplay randomness comes from the run seed, never `Math.random()`.** `Game.start` takes an
optional seed in its `MatchSetup` and reports it back through `snapshot().seed`. Everything that decides an outcome
— squadron order, arrival points, AI wander and break timing, gun spread — draws from a
substream of it (`subRng` in `src/core/rng.ts`), so a run is a function of its seed and its
inputs and nothing else. Cosmetic scatter — particles, camera shake, wreck sparks — is exempt
and still uses `Math.random()` directly.

Two viewers of one run may see different sparks; they may not see different hulls. `simcheck`
asserts this by playing the same seed twice and comparing, so a stray `Math.random()` on a path
that decides something fails the build rather than surfacing later as a desync.

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

**A loss resolves before it finishes.** Taking the fatal hit does not report the run — it seals
the scoreline and hands the next `DEATH_SEQUENCE` seconds to the wreck, which coasts and tumbles
for a beat before it goes up, then cooks off in the debris while the squadron flies on around it.
The debrief comes up after. Two consequences worth knowing: the result is banked at the moment of
death, so a hostile burning up in the star during the animation cannot post a bounty to a pilot
who is already dead; and the game refuses to pause while `game.dying`, because a paused explosion
with a debrief queued behind it is a dead end. The tumble is applied to the ship's *visual* only —
the chase camera sits in the ship's own frame, so spinning the hull's transform would spin the
shot instead. All of it is in `beginDeathSequence` / `stepDeathSequence` in `src/game/game.ts`.

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
both timed buffs stack, expire and do not survive a respawn), that clearing the roster reports
a win, and that a fatal hit plays its death animation out in full before the debrief takes the
screen.

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
