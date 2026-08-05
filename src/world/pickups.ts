/**
 * Power-up pods.
 *
 * The mirror image of the minefield. Mines are static punishment scattered
 * through the empty volume; pods are static reward, and they use the same
 * machinery on purpose — seeded placement so the arena stays learnable, two
 * `InstancedMesh` draw calls per kind, and collected pods scaled to zero rather
 * than removed so an instance index is stable for the whole run.
 *
 * Two kinds:
 *
 *   repair     restores a flat slab of hull on contact
 *   overdrive  halves the fire interval and doubles bolt damage, for a while
 *
 * The one place this deliberately breaks symmetry with mines is *who* they
 * apply to. A mine hurts whoever touches it, player and AI alike, because
 * `EnemyPilot` actively steers around the avoid list and so is playing the same
 * game you are. Nothing steers *toward* a pod. Making them enemy-collectible
 * would mean a hostile occasionally blundering into four-times damage with no
 * tell, no counterplay and no decision behind it — noise, not difficulty. So
 * `game.ts` only ever offers the player's hull to `findContact`. If the AI ever
 * learns to route through pods, this comment is the thing to delete first.
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

export type PickupKind = 'repair' | 'overdrive'

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

/** Seconds an Overdrive lasts. */
export const OVERDRIVE_DURATION = 18
/**
 * Seconds remaining when the HUD starts counting down. Comfortably less than
 * the duration, so the first stretch of the buff is calm and the last stretch
 * is a clock — if the countdown were up the whole time it would just be another
 * always-on gauge and would stop meaning "hurry".
 */
export const OVERDRIVE_WARN_AT = 10

export const OVERDRIVE_DAMAGE_MULT = 2
export const OVERDRIVE_RATE_MULT = 2

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

/** Seconds before a collected pad re-arms. */
const REPAIR_RESPAWN = 25
/** Longer, because Overdrive is the stronger of the two by a distance. */
const OVERDRIVE_RESPAWN = 45

/** How far a pod drifts up and down. Visual only — see `writeInstances`. */
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
  update(dt: number): void
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The heart, drawn apex-down in a roughly unit box and then scaled.
 *
 * Four segments a curve: enough to read as a heart across the arena, coarse
 * enough that `bakeParts`' recomputed normals stay hard-faceted like every
 * other model in the game. A smooth heart would be the one round object in a
 * world built entirely out of flat facets.
 */
function buildRepairGeometry(): THREE.BufferGeometry {
  // A shade larger than the Overdrive pod. The heart's read depends on a notch
  // and two lobes resolving, where a chevron survives being four pixels tall.
  const SCALE = 15
  const DEPTH = 0.62

  // The notch is cut much deeper than a drawn heart needs. Face-on that reads as
  // a heart either way; the deep V is what keeps it reading once the pod turns
  // and the lobes start foreshortening. A shallow notch disappears first and
  // leaves a green blob.
  const s = new THREE.Shape()
  s.moveTo(0, -1)
  s.bezierCurveTo(-0.6, -0.42, -1.05, 0.12, -1.05, 0.5)
  s.bezierCurveTo(-1.05, 0.94, -0.72, 1.14, -0.44, 1.14)
  s.bezierCurveTo(-0.2, 1.14, -0.06, 0.9, 0, 0.42)
  s.bezierCurveTo(0.06, 0.9, 0.2, 1.14, 0.44, 1.14)
  s.bezierCurveTo(0.72, 1.14, 1.05, 0.94, 1.05, 0.5)
  s.bezierCurveTo(1.05, 0.12, 0.6, -0.42, 0, -1)

  const g = new THREE.ExtrudeGeometry(s, { depth: DEPTH, bevelEnabled: false, curveSegments: 4 })
  g.translate(0, -0.03, -DEPTH / 2)
  g.scale(SCALE, SCALE, SCALE)

  const parts = [prep(g)]
  const merged = bakeParts(parts, 'repair pod')
  disposeParts(parts)
  return merged
}

/**
 * Two stacked chevrons — the fast-forward glyph, which is what the buff does.
 * Pointing along +Y so the silhouette survives the spin about the same axis;
 * chevrons lying in the spin plane would read as a flat bar half the time.
 */
function buildOverdriveGeometry(): THREE.BufferGeometry {
  const SCALE = 12
  const DEPTH = 0.58

  function chevron(): THREE.Shape {
    const s = new THREE.Shape()
    s.moveTo(-1, 0)
    s.lineTo(0, 0.86)
    s.lineTo(1, 0)
    s.lineTo(1, -0.42)
    s.lineTo(0, 0.44)
    s.lineTo(-1, -0.42)
    s.closePath()
    return s
  }

  const parts: THREE.BufferGeometry[] = []
  for (const offset of [-0.62, 0.28]) {
    const g = new THREE.ExtrudeGeometry(chevron(), { depth: DEPTH, bevelEnabled: false })
    g.translate(0, offset, -DEPTH / 2)
    g.scale(SCALE, SCALE, SCALE)
    parts.push(prep(g))
  }

  const merged = bakeParts(parts, 'overdrive pod')
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
 * Overdrive is violet because every other slot is taken. Cyan, magenta and
 * amber are the three airframe accents, so a pod wearing one would read as a
 * contact at range, and the contact markers are the only thing keeping a pilot
 * oriented in an arena with no horizon.
 */
const PALETTE: Record<
  PickupKind,
  { body: number; emissive: number; specular: number; halo: number }
> = {
  repair: { body: 0x123d0a, emissive: 0x4a9410, specular: 0xd8ffa0, halo: 0xb6ff3d },
  overdrive: { body: 0x2a0d3f, emissive: 0x7420c4, specular: 0xe0b0ff, halo: 0xc94fff },
}

/** Public, so the HUD and callouts can match a pod without re-deriving it. */
export const PICKUP_COLOR: Record<PickupKind, string> = {
  repair: '#b6ff3d',
  overdrive: '#c94fff',
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

export interface PickupsOptions {
  repairCount: number
  overdriveCount: number
  arenaRadius: number
  /** Station cores to keep clear of. */
  hazards: Hazard[]
  /** Live mine positions, so a pod is never hidden inside the minefield. */
  mines: THREE.Vector3[]
  /** Where the player starts. Nothing should be free on the first second. */
  spawn: THREE.Vector3
}

function placePods(opts: PickupsOptions): THREE.Vector3[] {
  const total = opts.repairCount + opts.overdriveCount
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
  const geometry = kind === 'repair' ? buildRepairGeometry() : buildOverdriveGeometry()
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

  // One placement pass for both kinds, split by index: repair pads take the
  // first `repairCount` sites and overdrive takes the rest. Placing them
  // together is what guarantees the 700-unit spacing holds *across* kinds and
  // not just within one, so you never find a heal and a gun buff on the same
  // corner. If the sampler came up short, the shortfall lands on overdrive,
  // which is the right way round — the heals are the routine resource.
  const pods: Pickup[] = positions.map((position, i) => ({
    position,
    kind: i < opts.repairCount ? 'repair' : 'overdrive',
    live: true,
    respawnIn: 0,
  }))

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

  const slots: Record<PickupKind, { pod: Pickup; phase: number }[]> = {
    repair: slotsFor('repair'),
    overdrive: slotsFor('overdrive'),
  }

  const meshes: Record<PickupKind, PodMeshes> = {
    repair: buildPodMeshes('repair', slots.repair.length),
    overdrive: buildPodMeshes('overdrive', slots.overdrive.length),
  }

  const group = new THREE.Group()
  group.add(meshes.repair.body, meshes.repair.halo, meshes.overdrive.body, meshes.overdrive.halo)

  const basis = new THREE.Object3D()
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  let clock = 0

  function writeKind(kind: PickupKind): void {
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
      // Slow, and tilted off the vertical. The spin has to be lazy enough that a
      // pilot gets a face-on read before they are past it, and the tilt means
      // the pod is never perfectly edge-on for long — a flat plate spinning
      // about a true vertical axis vanishes to a line twice a turn.
      basis.rotation.set(0.26, clock * 0.8 + phase, 0.12)

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

  function writeInstances(): void {
    writeKind('repair')
    writeKind('overdrive')
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
      pod.respawnIn = pod.kind === 'repair' ? REPAIR_RESPAWN : OVERDRIVE_RESPAWN
      writeInstances()
    },

    reset() {
      for (const pod of pods) {
        pod.live = true
        pod.respawnIn = 0
      }
      writeInstances()
    },

    update(dt) {
      clock += dt
      for (const pod of pods) {
        if (pod.live) continue
        pod.respawnIn -= dt
        if (pod.respawnIn <= 0) {
          pod.respawnIn = 0
          pod.live = true
        }
      }
      meshes.repair.haloMat.opacity = 0.07 + (Math.sin(clock * 2.4) * 0.5 + 0.5) * 0.08
      meshes.overdrive.haloMat.opacity = 0.08 + (Math.sin(clock * 3.1) * 0.5 + 0.5) * 0.1
      writeInstances()
    },

    dispose() {
      meshes.repair.dispose()
      meshes.overdrive.dispose()
    },
  }

  writeInstances()
  return field
}
