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

## The three airframes

| | Wasp `SK-09` | Hornet `AV-22` | Drone `BX-40` |
|---|---|---|---|
| Role | Glass cannon | Fleet standard | Gun platform |
| Hull | 70 | 120 | 200 |
| Top speed | 470 | 355 | 250 |
| Turn rate | 1.95 rad/s | 1.45 rad/s | 0.95 rad/s |
| Guns | 5 dmg @ 0.085s | 12 dmg × 2 @ 0.22s | 20 dmg × 2 @ 0.86s |
| Quirk | Guns overheat and lock out | Phase dash — untargetable mid-dash | Hull self-repairs after 6.5s |

Whichever you pick, three of each of the other two types make up the opposing squadron. Clear
all six to win; lose your hull and the run is recorded as a loss. High scores are per-airframe,
in `localStorage`.

## How it fits together

```
src/
  core/     stage (renderer + bloom), input, audio, scores, geo, rng
  ships/    stat specs, procedural hull geometry
  world/    planet, stations, sky, arena assembly
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
npm run check        # typecheck + headless simulation
npm run check:sim    # simulation only, ~1s
npm run build        # typecheck + production bundle
```

`scripts/simcheck.ts` runs the real flight model, projectiles, AI and game loop in Node — it is
all pure maths over three.js vector types, no canvas needed. It exists because in-browser
verification proved unreliable: a throttled tab stops firing `requestAnimationFrame`, which
silently freezes the loop and makes every behavioural observation meaningless. It asserts the
combat contract (hits land, kills register, friendly fire is off), the hull quirks, the
boundary, and that clearing the roster reports a win.

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
