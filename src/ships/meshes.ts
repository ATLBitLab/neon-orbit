/**
 * Procedural low-poly airframes.
 *
 * Each ship is a handful of coarse primitives and extruded plates merged into
 * one non-indexed geometry, so `computeVertexNormals()` yields hard facets —
 * the Star Fox 64 look — then wrapped in glowing edge lines for the neon.
 * Ships face **-Z**, matching three.js convention, so `getWorldDirection()`
 * is the nose vector with no correction.
 */

import * as THREE from 'three'
import { at, bakeParts, blister, box, disposeParts, fin, mirrored, plate, spike, tube } from '../core/geo'
import type { ShipSpec } from './specs'

export interface ShipVisual {
  group: THREE.Group
  /** Engine flare cones — scale on Z with throttle. */
  thrusters: THREE.Object3D[]
  /** Gun muzzle offsets in ship-local space. */
  muzzles: THREE.Vector3[]
  hullMat: THREE.MeshPhongMaterial
  trimMat: THREE.LineBasicMaterial
  glowMat: THREE.MeshBasicMaterial
  /** Longest dimension, used for camera framing. */
  length: number
}

interface Blueprint {
  hull: THREE.BufferGeometry[]
  /** Emissive detail — canopies, vents, warning strips. */
  accent: THREE.BufferGeometry[]
  thrusters: { x: number; y: number; z: number; radius: number; length: number }[]
  muzzles: THREE.Vector3[]
  length: number
}

/* -------------------------------------------------------------------------- */
/* Airframes                                                                   */
/* -------------------------------------------------------------------------- */

/** SK-09 — a cockpit bolted to an engine. Needle nose, deep-swept wings. */
function waspBlueprint(): Blueprint {
  const wing = plate(
    [
      [1.9, -3],
      [13, 7],
      [13, 10.5],
      [2.6, 9],
    ],
    0.7,
  )
  const canard = plate(
    [
      [1.6, -14],
      [6.6, -9.5],
      [6.6, -8],
      [1.8, -11],
    ],
    0.6,
  )
  const strake = box(0.5, 0.4, 7, 0, 1.2, 5)
  return {
    hull: [
      spike(2.3, 16, 4, -10), // needle nose
      tube(2.3, 1.6, 12, 4, 4), // spine
      tube(1.6, 2.5, 4, 5, 12), // engine bell
      wing,
      mirrored(wing),
      canard,
      mirrored(canard),
      fin(
        [
          [2, 0.9],
          [10, 7.6],
          [12, 7.6],
          [11.4, 0.9],
        ],
        0.7,
      ),
      fin(
        [
          [3, -0.9],
          [10, -5.4],
          [11.6, -5.4],
          [11.4, -0.9],
        ],
        0.7,
      ),
    ],
    accent: [blister(1.5, 1.0, 2.4, 1.5, -6), at(strake, 1.6), at(strake, -1.6)],
    thrusters: [{ x: 0, y: 0, z: 14.5, radius: 2.0, length: 11 }],
    muzzles: [new THREE.Vector3(0, -0.6, -18)],
    length: 34,
  }
}

/** BX-40 — a gun platform that happens to fly. Slab armour, forward cannons. */
function droneBlueprint(): Blueprint {
  const stub = plate(
    [
      [5, 2],
      [12.8, 8],
      [12.8, 12],
      [5.4, 11],
    ],
    1.0,
  )
  const dorsal = fin(
    [
      [6, 3.4],
      [13, 9.2],
      [15, 9.2],
      [14.2, 3.4],
    ],
    0.9,
  )
  const pod = box(4.2, 5.2, 15, 0, 0, 1)
  const cannon = tube(1.15, 1.15, 14, 6, -12)
  const engine = tube(2.5, 3.2, 5, 6, 13.5)
  return {
    hull: [
      box(10, 6.4, 22), // core
      spike(5.2, 9, 4, -15.5), // ram wedge
      at(pod, 7.6),
      at(pod, -7.6),
      at(cannon, 7.6),
      at(cannon, -7.6),
      box(7.4, 1.8, 13, 0, 4.1, 2), // dorsal armour
      box(6, 1.4, 11, 0, -3.9, 1), // ventral skid
      at(engine, 4.2),
      at(engine, -4.2),
      stub,
      mirrored(stub),
      at(dorsal, 3.4),
      at(dorsal, -3.4),
    ],
    accent: [
      box(4.4, 1.6, 3.4, 0, 3.7, -8), // armoured slit canopy
      box(9.6, 0.5, 1.2, 0, 2.7, -4),
      box(9.6, 0.5, 1.2, 0, 2.7, 6),
    ],
    thrusters: [
      { x: 4.2, y: 0, z: 16, radius: 2.7, length: 9 },
      { x: -4.2, y: 0, z: 16, radius: 2.7, length: 9 },
    ],
    muzzles: [new THREE.Vector3(7.6, 0, -19), new THREE.Vector3(-7.6, 0, -19)],
    length: 40,
  }
}

/** AV-22 — the fleet standard. Delta wings, twin engines, upturned tips. */
function hornetBlueprint(): Blueprint {
  const wing = plate(
    [
      [2.4, -5],
      [12.6, 5],
      [12.6, 9.5],
      [2.9, 10],
    ],
    0.8,
  )
  const tip = fin(
    [
      [4, 0],
      [8.5, 6.2],
      [10, 6.2],
      [9.6, 0],
    ],
    0.7,
  )
  const engine = tube(1.9, 2.4, 6, 6, 12)
  const strake = box(0.6, 0.4, 8, 0, 0.9, 1)
  return {
    hull: [
      spike(2.9, 13, 6, -9.5),
      tube(2.9, 2.4, 12, 6, 3),
      box(7.6, 1.7, 6, 0, 0, 9.6),
      wing,
      mirrored(wing),
      at(tip, 11.6),
      at(tip, -11.6),
      at(engine, 3.6),
      at(engine, -3.6),
      fin(
        [
          [5, 1.6],
          [11, 6.6],
          [13, 6.6],
          [12.2, 1.6],
        ],
        0.7,
      ),
    ],
    accent: [blister(1.8, 1.2, 2.6, 1.7, -5.5), at(strake, 4.4), at(strake, -4.4)],
    thrusters: [
      { x: 3.6, y: 0, z: 15, radius: 2.1, length: 10 },
      { x: -3.6, y: 0, z: 15, radius: 2.1, length: 10 },
    ],
    muzzles: [new THREE.Vector3(5.4, -0.4, -11), new THREE.Vector3(-5.4, -0.4, -11)],
    length: 32,
  }
}

const BLUEPRINTS: Record<string, () => Blueprint> = {
  wasp: waspBlueprint,
  drone: droneBlueprint,
  hornet: hornetBlueprint,
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

interface Baked {
  hull: THREE.BufferGeometry
  edges: THREE.BufferGeometry
  accent: THREE.BufferGeometry
  thrusters: Blueprint['thrusters']
  muzzles: THREE.Vector3[]
  length: number
}

/**
 * Merged geometry is identical for every ship of a type, so it is baked once
 * and shared. Materials stay per-instance: one ship flashing red on a hit must
 * not light up its whole squadron.
 */
const bakedCache = new Map<string, Baked>()

function bake(spec: ShipSpec): Baked {
  const hit = bakedCache.get(spec.id)
  if (hit) return hit

  const bp = BLUEPRINTS[spec.id]()
  const hull = bakeParts(bp.hull, `${spec.id}:hull`)
  const accent = bakeParts(bp.accent, `${spec.id}:accent`)
  // 22° threshold keeps panel seams while dropping facet noise inside cones.
  const edges = new THREE.EdgesGeometry(hull, 22)
  disposeParts(bp.hull, bp.accent)

  const baked: Baked = {
    hull,
    edges,
    accent,
    thrusters: bp.thrusters,
    muzzles: bp.muzzles,
    length: bp.length,
  }
  bakedCache.set(spec.id, baked)
  return baked
}

/** Cheap additive flare cone pointing aft. */
function thrusterMesh(radius: number, length: number, mat: THREE.MeshBasicMaterial): THREE.Mesh {
  const g = new THREE.ConeGeometry(radius, length, 7, 1, true)
  g.rotateX(Math.PI / 2) // apex points aft (+Z)
  g.translate(0, 0, length / 2)
  return new THREE.Mesh(g, mat)
}

export function buildShip(spec: ShipSpec): ShipVisual {
  const baked = bake(spec)
  const accentColor = new THREE.Color(spec.accent)

  const hullMat = new THREE.MeshPhongMaterial({
    color: spec.hullColor,
    flatShading: true,
    shininess: 24,
    specular: accentColor.clone().multiplyScalar(0.35),
    emissive: accentColor.clone().multiplyScalar(0.06),
  })

  const trimMat = new THREE.LineBasicMaterial({
    color: accentColor.clone().lerp(new THREE.Color(0xffffff), 0.35),
    transparent: true,
    opacity: 0.95,
  })

  const glowMat = new THREE.MeshBasicMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const group = new THREE.Group()
  group.add(new THREE.Mesh(baked.hull, hullMat))
  group.add(new THREE.LineSegments(baked.edges, trimMat))
  group.add(new THREE.Mesh(baked.accent, glowMat))

  const thrusters: THREE.Object3D[] = baked.thrusters.map((t) => {
    const flare = thrusterMesh(t.radius, t.length, glowMat)
    flare.position.set(t.x, t.y, t.z)
    group.add(flare)
    return flare
  })

  return {
    group,
    thrusters,
    muzzles: baked.muzzles.map((m) => m.clone()),
    hullMat,
    trimMat,
    glowMat,
    length: baked.length,
  }
}

/** Release the per-instance materials of a ship that has left the scene. */
export function disposeShipVisual(v: ShipVisual): void {
  v.hullMat.dispose()
  v.trimMat.dispose()
  v.glowMat.dispose()
  for (const t of v.thrusters) {
    if (t instanceof THREE.Mesh) t.geometry.dispose()
  }
}
