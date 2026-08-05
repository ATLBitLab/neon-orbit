/**
 * Power-up pods.
 *
 * The mirror image of the minefield. Mines are static punishment scattered
 * through the empty volume; pods are static reward, and they use the same
 * machinery on purpose — seeded placement so the arena stays learnable, two
 * `InstancedMesh` draw calls per kind, and collected pods scaled to zero rather
 * than removed so an instance index is stable for the whole run.
 *
 * Three kinds:
 *
 *   repair     restores a flat slab of hull on contact
 *   overdrive  halves the fire interval — twice the bolts, same bolt
 *   shield     incoming damage is refused entirely while it holds
 *
 * Every pod is a **glyph inside a ring, turned to face you**.
 *
 * The billboard is the load-bearing part. A glyph is a flat extruded plate, so
 * left to spin freely it thins to a line twice a rotation and foreshortens into
 * a bar for most of the rest — a lightning bolt seen at 60° is a blob with
 * spikes. A pickup you have to *recognise* rather than merely spot cannot
 * afford that, so the pod yaws to the camera every frame and only ever presents
 * its face. This is the same trick the shockwave rings in `game/fx.ts` use, and
 * the same one every icon pickup in every arena shooter has used since Doom.
 *
 * Motion comes from a slow rock in the icon's own plane and the bob, rather
 * than from a spin that would defeat the point. The ring is coplanar with the
 * glyph, so it billboards too and always reads as a full circle: a frame, which
 * both gives a small icon presence at range and makes the three pods read as
 * one family of objects rather than three unrelated props.
 *
 * The one place this deliberately breaks symmetry with mines is *who* they
 * apply to. A mine hurts whoever touches it, player and AI alike, because
 * `EnemyPilot` actively steers around the avoid list and so is playing the same
 * game you are. Nothing steers *toward* a pod. Making them enemy-collectible
 * would mean a hostile occasionally blundering into a buff with no tell, no
 * counterplay and no decision behind it — noise, not difficulty. So `game.ts`
 * only ever offers the player's hull to `findContact`. If the AI ever learns to
 * route through pods, this comment is the thing to delete first.
 *
 * Unlike mines, pods come back. A one-shot heal in a six-hostile run is a
 * rounding error; a pad you can return to is a place on the map worth
 * remembering, which is the same reason the mine layout is seeded rather than
 * random.
 */

import * as THREE from 'three'
import { bakeParts, disposeParts, prep } from '../core/geo'
import { makeRng, WORLD_SEED } from '../core/rng'
import type { Hazard } from './environment'

export type PickupKind = 'repair' | 'overdrive' | 'shield'

/**
 * Hull restored by a repair pod.
 *
 * Flat, for the same reason `MINE_DAMAGE` is flat: it is the same crate of
 * spares whoever collects it. That makes it worth most to the thinnest hull,
 * which is the exact counterweight to a flat mine hurting the thinnest hull
 * most — the Wasp fears mines the way it loves pods. Deliberately *under*
 * `MINE_DAMAGE`, so a pod never fully undoes a mine and the minefield stays a
 * thing you route around rather than a toll you pay.
 */
export const REPAIR_AMOUNT = 35

/** Seconds one Overdrive pod grants. Pods stack, so two are twenty seconds. */
export const OVERDRIVE_DURATION = 10

/**
 * Overdrive halves the fire interval and does **nothing to bolt damage**.
 *
 * That is the whole design: total output goes up 2x, and the way you can see it
 * is the rate of fire. An earlier version also doubled damage per bolt, which
 * multiplied out to 4x and had a nasty second-order effect — a boosted Drone's
 * volley was 80 damage into a 70-hull Wasp, so it deleted one outright between
 * frames, with no hit flash and nothing to read. Leaving the bolt alone keeps
 * every alpha strike in the game exactly where the balance harness already
 * pinned it, and the buff stays legible as "my guns got faster".
 */
export const OVERDRIVE_RATE_MULT = 2

/** Seconds one Shield pod grants. Also stacks. */
export const SHIELD_DURATION = 10

/**
 * Seconds left when the HUD starts counting down, shared by both timed
 * power-ups. One number, so "the banner is up" means the same thing whichever
 * buff it is attached to, and a pilot learns the threshold once.
 */
export const TIMED_WARN_AT = 5

/**
 * Contact radius. Much larger than a mine's, and larger than it looks.
 *
 * A hazard should be tight — grazing a mine you thought you cleared is a bad
 * beat. A reward should be forgiving: you are collecting it at up to 470 u/s,
 * through a chase camera, usually while someone is shooting at you. This also
 * settles the tunnelling question. The loop clamps a frame to `MAX_STEP`
 * (1/20s), so the fastest airframe covers 23.5 units in the worst frame the
 * simulation will accept, against a reach of this plus the hull radius.
 */
export const PICKUP_RADIUS = 34

/** Seconds before a collected pad re-arms, per kind. */
const RESPAWN: Record<PickupKind, number> = {
  repair: 25,
  overdrive: 30,
  shield: 30,
}

/** How far a pod drifts up and down. Visual only — see `writeKind`. */
const BOB = 5

const _scratch = new THREE.Vector3()

export interface Pickup {
  readonly position: THREE.Vector3
  readonly kind: PickupKind
  live: boolean
  /** Seconds until this pad re-arms. Zero while live. */
  respawnIn: number
}

export interface Pickups {
  group: THREE.Group
  pods: Pickup[]
  /** The live pod this sphere is touching, or null. */
  findContact(position: THREE.Vector3, radius: number): Pickup | null
  /** Consume a pod and start its respawn clock. */
  collect(pod: Pickup): void
  /** Re-arm everything. Called at the start of every run. */
  reset(): void
  /** The camera is needed because pods billboard — see the note at the top. */
  update(dt: number, camera: THREE.Camera): void
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/** Glyph scale, in world units per unit of the shapes drawn below. */
const GLYPH = 14
/** Extrusion depth, as a fraction of `GLYPH`. */
const THICK = 0.6

/**
 * Ring radius and tube thickness, in world units.
 *
 * Sized so the **outer edge of the ring is exactly `PICKUP_RADIUS`**: the frame
 * you can see is the hitbox you are steering at, which is about as honest as a
 * pickup can be about where it starts.
 *
 * The inner edge then clears the furthest corner of every glyph below by a
 * wide margin, and that margin is the point. The first version had the icons
 * nearly touching the frame, and with both bloomed the gap closed entirely —
 * every pod read as a filled disc of its own colour, which told you *which*
 * pickup only by hue and threw away the silhouette work completely.
 */
const RING_RADIUS = 30
const RING_THICK = 4

/**
 * The frame every pod sits in.
 *
 * Left in the XY plane rather than laid flat, so it billboards along with the
 * glyph and always reads as a full circle instead of an ellipse that collapses
 * to a line. Three cross-section segments and fourteen around: a chunky faceted
 * hoop rather than a smooth torus, which is what `bakeParts`' recomputed
 * normals want and what everything else in the arena looks like. The first
 * version of this was thin enough (1.8 units) to disappear entirely past 200
 * units, which is exactly the range the frame exists to survive.
 */
function podRing(): THREE.BufferGeometry {
  return prep(new THREE.TorusGeometry(RING_RADIUS, RING_THICK, 3, 14))
}

/**
 * Per-glyph size trim, because "fits in the ring" is about *ink*, not bounds.
 *
 * The bolt and the crest are mostly negative space, so they read at full size
 * with the frame still clearly separate. The heart is a solid convex blob and
 * the widest of the three, so at the same scale it and its ring bloomed into a
 * single green disc — the exact failure the frame exists to prevent.
 */
const GLYPH_SCALE: Record<PickupKind, number> = {
  repair: 0.8,
  overdrive: 1,
  shield: 1,
}

/** Extrude a flat shape standing upright in XY, centred on the origin. */
function glyph(shape: THREE.Shape, scale: number, curveSegments = 4): THREE.BufferGeometry {
  const depth = THICK
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments })
  g.translate(0, 0, -depth / 2)
  g.scale(GLYPH * scale, GLYPH * scale, GLYPH * scale)
  return prep(g)
}

/**
 * The heart, drawn apex-down in a roughly unit box.
 *
 * The notch is cut much deeper than a drawn heart needs. Face-on that reads as
 * a heart either way; the deep V is what keeps it reading once the pod turns
 * and the lobes start foreshortening. A shallow notch disappears first and
 * leaves a green blob.
 */
function repairShape(): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(0, -1)
  s.bezierCurveTo(-0.6, -0.42, -1.05, 0.12, -1.05, 0.5)
  s.bezierCurveTo(-1.05, 0.94, -0.72, 1.14, -0.44, 1.14)
  s.bezierCurveTo(-0.2, 1.14, -0.06, 0.9, 0, 0.42)
  s.bezierCurveTo(0.06, 0.9, 0.2, 1.14, 0.44, 1.14)
  s.bezierCurveTo(0.72, 1.14, 1.05, 0.94, 1.05, 0.5)
  s.bezierCurveTo(1.05, 0.12, 0.6, -0.42, 0, -1)
  return s
}

/**
 * A lightning bolt, for Overdrive.
 *
 * This replaced a pair of stacked chevrons. The chevrons were a fast-forward
 * glyph, which was accurate — the buff is a rate increase — but they were two
 * small shapes with a gap between them, and at any distance the gap closed and
 * they read as one blocky arrow. A bolt is a single silhouette with a hard
 * zig-zag no other object in the arena has, which is what makes it legible at
 * the range you actually decide whether to turn for it.
 */
function overdriveShape(): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(0.1, 1.0)
  s.lineTo(-0.9, -0.2)
  s.lineTo(0.0, -0.2)
  s.lineTo(-0.1, -1.0)
  s.lineTo(0.9, 0.2)
  s.lineTo(0.0, 0.2)
  s.closePath()
  return s
}

/** A heater-shield crest: square shoulders, sides sweeping to a point. */
function shieldShape(): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(-0.72, 1.0)
  s.lineTo(0.72, 1.0)
  s.lineTo(0.72, 0.05)
  s.bezierCurveTo(0.72, -0.55, 0.4, -0.86, 0, -1.06)
  s.bezierCurveTo(-0.4, -0.86, -0.72, -0.55, -0.72, 0.05)
  s.closePath()
  return s
}

const SHAPES: Record<PickupKind, () => THREE.Shape> = {
  repair: repairShape,
  overdrive: overdriveShape,
  shield: shieldShape,
}

function buildPodGeometry(kind: PickupKind): THREE.BufferGeometry {
  // Straight-edged glyphs need no curve subdivision at all; the two with
  // beziers get four segments, enough to read and coarse enough to stay
  // hard-faceted like every other model in the game.
  const parts = [
    glyph(SHAPES[kind](), GLYPH_SCALE[kind], kind === 'overdrive' ? 1 : 4),
    podRing(),
  ]
  const merged = bakeParts(parts, `${kind} pod`)
  disposeParts(parts)
  return merged
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Colours are chosen against what is already on screen, not for their own sake.
 *
 * Repair is lime because lime is the hull gauge — the pod is the same colour as
 * the bar it refills. It is emphatically *not* red: red in this arena means a
 * mine, and a heal that shares a colour with the one object that takes 45 hull
 * off you is a trap rather than a pickup.
 *
 * Overdrive is violet and Shield is a deep electric blue, because every other
 * slot is taken. Cyan, magenta and amber are the three airframe accents, so a
 * pod wearing one would read as a contact at range, and the contact markers are
 * the only thing keeping a pilot oriented in an arena with no horizon. The
 * Shield blue is pushed well off the Hornet's cyan for the same reason.
 */
const PALETTE: Record<
  PickupKind,
  { body: number; emissive: number; specular: number; halo: number }
> = {
  repair: { body: 0x123d0a, emissive: 0x4a9410, specular: 0xd8ffa0, halo: 0xb6ff3d },
  overdrive: { body: 0x2a0d3f, emissive: 0x7420c4, specular: 0xe0b0ff, halo: 0xc94fff },
  shield: { body: 0x0d1c4a, emissive: 0x1f4fc8, specular: 0xa8c4ff, halo: 0x4d8cff },
}

/** Public, so the HUD and callouts can match a pod without re-deriving it. */
export const PICKUP_COLOR: Record<PickupKind, string> = {
  repair: '#b6ff3d',
  overdrive: '#c94fff',
  shield: '#4d8cff',
}

export const PICKUP_KINDS: PickupKind[] = ['repair', 'overdrive', 'shield']

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

export interface PickupsOptions {
  /** How many pads of each kind to lay out. */
  counts: Record<PickupKind, number>
  arenaRadius: number
  /** Station cores to keep clear of. */
  hazards: Hazard[]
  /** Live mine positions, so a pod is never hidden inside the minefield. */
  mines: THREE.Vector3[]
  /** Where the player starts. Nothing should be free on the first second. */
  spawn: THREE.Vector3
}

function placePods(opts: PickupsOptions): THREE.Vector3[] {
  const total = PICKUP_KINDS.reduce((sum, k) => sum + opts.counts[k], 0)
  const rng = makeRng(WORLD_SEED ^ 0x2f7a)
  const placed: THREE.Vector3[] = []

  let attempts = 0
  while (placed.length < total && attempts < total * 200) {
    attempts++

    const u = rng.range(-1, 1)
    const theta = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(Math.max(0, 1 - u * u))
    const dist = rng.range(600, opts.arenaRadius * 0.86)
    const p = new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta)).multiplyScalar(dist)

    if (p.distanceTo(opts.spawn) < 700) continue
    if (opts.hazards.some((h) => p.distanceTo(h.center) < h.radius + 260)) continue
    // Clear of mines by more than both contact radii combined, so collecting a
    // pod is never a coin flip against a 45-damage hazard you cannot see behind
    // the glow.
    if (opts.mines.some((m) => p.distanceTo(m) < 240)) continue
    // Well spread: two pods in the same neighbourhood is one pod as far as a
    // pilot deciding where to fly is concerned.
    if (placed.some((q) => p.distanceTo(q) < 700)) continue

    placed.push(p)
  }

  return placed
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

interface PodMeshes {
  body: THREE.InstancedMesh
  halo: THREE.InstancedMesh
  haloMat: THREE.MeshBasicMaterial
  dispose(): void
}

function buildPodMeshes(kind: PickupKind, count: number): PodMeshes {
  const geometry = buildPodGeometry(kind)
  const palette = PALETTE[kind]

  const bodyMat = new THREE.MeshPhongMaterial({
    color: palette.body,
    flatShading: true,
    shininess: 44,
    specular: palette.specular,
    // Over the bloom threshold, so a pod is visible from across the arena.
    emissive: palette.emissive,
  })

  // Low opacity *and* backside-only, exactly like the mine halo. Tuned down
  // from where it started: a pod is a shape you have to *recognise*, not just
  // spot, and a mine's halo settings turned the heart into a lime blob the
  // moment bloom got hold of it. The silhouette has to survive the glow, so the
  // halo stays a rim rather than a second solid body — hence 1.14x rather than
  // the mine's 1.25x, and roughly half its opacity.
  const haloMat = new THREE.MeshBasicMaterial({
    color: palette.halo,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  })

  const body = new THREE.InstancedMesh(geometry, bodyMat, Math.max(1, count))
  const halo = new THREE.InstancedMesh(geometry, haloMat, Math.max(1, count))
  for (const mesh of [body, halo]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
  }

  return {
    body,
    halo,
    haloMat,
    dispose() {
      geometry.dispose()
      bodyMat.dispose()
      haloMat.dispose()
      body.dispose()
      halo.dispose()
    },
  }
}

export function buildPickups(opts: PickupsOptions): Pickups {
  const positions = placePods(opts)

  // One placement pass for every kind, split by index. Placing them together is
  // what guarantees the 700-unit spacing holds *across* kinds and not just
  // within one, so you never find a heal and a gun buff on the same corner. If
  // the sampler came up short the shortfall lands on the last kind in
  // `PICKUP_KINDS`, which is why repair — the routine resource — is first.
  const pods: Pickup[] = positions.map((position, i) => {
    let index = i
    let kind: PickupKind = PICKUP_KINDS[PICKUP_KINDS.length - 1]
    for (const k of PICKUP_KINDS) {
      if (index < opts.counts[k]) {
        kind = k
        break
      }
      index -= opts.counts[k]
    }
    return { position, kind, live: true, respawnIn: 0 }
  })

  // Per-pod spin phase, so a row of pods never turns in lockstep. Mines pulse in
  // unison deliberately — a field blinking together is creepier — but a set of
  // rewards wants to look like scattered objects rather than one installation.
  const phaseRng = makeRng(WORLD_SEED ^ 0xa10c)
  const phases = pods.map(() => phaseRng.range(0, Math.PI * 2))

  /** Each kind's pods paired with their phases, in InstancedMesh slot order. */
  function slotsFor(kind: PickupKind): { pod: Pickup; phase: number }[] {
    return pods
      .map((pod, i) => ({ pod, phase: phases[i] }))
      .filter((slot) => slot.pod.kind === kind)
  }

  const slots = Object.fromEntries(
    PICKUP_KINDS.map((k) => [k, slotsFor(k)]),
  ) as Record<PickupKind, { pod: Pickup; phase: number }[]>

  const meshes = Object.fromEntries(
    PICKUP_KINDS.map((k) => [k, buildPodMeshes(k, slots[k].length)]),
  ) as Record<PickupKind, PodMeshes>

  const group = new THREE.Group()
  for (const k of PICKUP_KINDS) group.add(meshes[k].body, meshes[k].halo)

  const basis = new THREE.Object3D()
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  const _eye = new THREE.Vector3()
  let clock = 0

  function writeKind(kind: PickupKind, camera: THREE.Camera | null): void {
    const { body, halo } = meshes[kind]
    const list = slots[kind]
    for (let i = 0; i < list.length; i++) {
      const { pod, phase } = list[i]
      if (!pod.live) {
        body.setMatrixAt(i, hidden)
        halo.setMatrixAt(i, hidden)
        continue
      }

      // The bob is applied to the rendered matrix only; `pod.position` stays the
      // anchor `findContact` tests against. A 5-unit drift inside a 34-unit
      // contact sphere is well under the slack a pilot could feel, and keeping
      // the hitbox still means a pod cannot bob out from under a hull that is
      // already touching it.
      basis.position.copy(pod.position)
      basis.position.y += Math.sin(clock * 1.6 + phase) * BOB

      if (camera) {
        // Face the camera, then rock gently in the icon's own plane. `lookAt`
        // keeps world up as up, so the pod never rolls with the player's
        // horizon — the glyph stays the right way up however you approach it.
        camera.getWorldPosition(_eye)
        basis.lookAt(_eye)
        basis.rotateZ(Math.sin(clock * 1.1 + phase) * 0.2)
      } else {
        // No camera yet — the first write happens at build time, before any
        // frame. Any orientation will do; the next update fixes it.
        basis.rotation.set(0, 0, 0)
      }

      basis.scale.setScalar(1)
      basis.updateMatrix()
      body.setMatrixAt(i, basis.matrix)

      basis.scale.setScalar(1.14 + Math.sin(clock * 2.4 + phase) * 0.07)
      basis.updateMatrix()
      halo.setMatrixAt(i, basis.matrix)
    }
    body.instanceMatrix.needsUpdate = true
    halo.instanceMatrix.needsUpdate = true
  }

  /**
   * Rewrite every instance. `camera` is null only for the build-time write and
   * for the state changes (`collect`, `reset`) that happen between frames —
   * those just need the collected pod scaled away, and `update` re-aims
   * everything a moment later.
   */
  function writeInstances(camera: THREE.Camera | null = null): void {
    for (const k of PICKUP_KINDS) writeKind(k, camera)
  }

  const field: Pickups = {
    group,
    pods,

    findContact(position, radius) {
      const reach = PICKUP_RADIUS + radius
      const reachSq = reach * reach
      for (const pod of pods) {
        if (!pod.live) continue
        if (_scratch.subVectors(position, pod.position).lengthSq() <= reachSq) return pod
      }
      return null
    },

    collect(pod) {
      if (!pod.live) return
      pod.live = false
      pod.respawnIn = RESPAWN[pod.kind]
      writeInstances()
    },

    reset() {
      for (const pod of pods) {
        pod.live = true
        pod.respawnIn = 0
      }
      writeInstances()
    },

    update(dt, camera) {
      clock += dt
      for (const pod of pods) {
        if (pod.live) continue
        pod.respawnIn -= dt
        if (pod.respawnIn <= 0) {
          pod.respawnIn = 0
          pod.live = true
        }
      }
      // Each kind breathes at its own rate, so a cluster of mixed pods never
      // pulses in unison and reads as one installation.
      meshes.repair.haloMat.opacity = 0.07 + (Math.sin(clock * 2.4) * 0.5 + 0.5) * 0.08
      meshes.overdrive.haloMat.opacity = 0.08 + (Math.sin(clock * 3.1) * 0.5 + 0.5) * 0.1
      meshes.shield.haloMat.opacity = 0.08 + (Math.sin(clock * 2.0) * 0.5 + 0.5) * 0.1
      writeInstances(camera)
    },

    dispose() {
      for (const k of PICKUP_KINDS) meshes[k].dispose()
    },
  }

  writeInstances()
  return field
}
