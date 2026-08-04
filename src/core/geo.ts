/**
 * Shared low-poly geometry kit.
 *
 * Every model in the game — ships, stations, debris — is assembled from these
 * primitives, merged into one non-indexed geometry, then normal-recomputed so
 * the facets stay hard. Keeping the helpers in one place means ships and
 * stations cannot drift apart on conventions like "which way is forward".
 *
 * Convention: **-Z is forward**, +Y is up.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Strip to bare non-indexed positions so merges never fight over attributes. */
export function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g
  if (flat !== g) g.dispose()
  flat.deleteAttribute('uv')
  flat.deleteAttribute('normal')
  return flat
}

export type Pt = [number, number]

/**
 * A flat horizontal panel — wings, stabilisers, armour plates.
 * Points are `[x, z]`; the panel is `thickness` tall, centred on y = 0.
 * `ExtrudeGeometry` normalises contour winding, so point order is forgiving.
 */
export function plate(points: Pt[], thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)))
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
  g.rotateX(Math.PI / 2)
  g.translate(0, thickness / 2, 0)
  return prep(g)
}

/** A flat vertical panel — tail fins, rudders. Points are `[z, y]`. */
export function fin(points: Pt[], thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)))
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
  g.rotateY(-Math.PI / 2)
  g.translate(thickness / 2, 0, 0)
  return prep(g)
}

/** Mirror a panel across the centreline, restoring outward-facing winding. */
export function mirrored(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone()
  m.scale(-1, 1, 1)
  const pos = m.getAttribute('position') as THREE.BufferAttribute
  const a = pos.array as Float32Array
  for (let i = 0; i < a.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const tmp = a[i + 3 + k]
      a[i + 3 + k] = a[i + 6 + k]
      a[i + 6 + k] = tmp
    }
  }
  pos.needsUpdate = true
  return m
}

/** A copy of `g` slid sideways — the original is never mutated. */
export function at(g: THREE.BufferGeometry, x: number, y = 0, z = 0): THREE.BufferGeometry {
  return g.clone().translate(x, y, z)
}

/** A copy of `g` swung around the Y axis, keeping its offset from the origin. */
export function spun(g: THREE.BufferGeometry, angle: number): THREE.BufferGeometry {
  return g.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(angle))
}

/** A cone whose apex points forward (-Z). */
export function spike(radius: number, height: number, sides: number, z: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(radius, height, sides)
  g.rotateX(-Math.PI / 2)
  g.translate(0, 0, z)
  return prep(g)
}

/** A tube along Z. `rFront` sits nearer the nose. */
export function tube(
  rFront: number,
  rBack: number,
  length: number,
  sides: number,
  z: number,
  x = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rFront, rBack, length, sides)
  g.rotateX(-Math.PI / 2)
  g.translate(x, 0, z)
  return prep(g)
}

/** A tube standing along Y. */
export function post(
  rTop: number,
  rBottom: number,
  height: number,
  sides: number,
  y = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, sides)
  g.translate(0, y, 0)
  return prep(g)
}

export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return prep(g)
}

/** A squashed sphere — canopies, reactor cores, hub blisters. */
export function blister(rx: number, ry: number, rz: number, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 8, 5)
  g.scale(rx, ry, rz)
  g.translate(0, y, z)
  return prep(g)
}

/** A faceted rock / hull sphere. */
export function chunk(radius: number, detail = 1): THREE.BufferGeometry {
  return prep(new THREE.IcosahedronGeometry(radius, detail))
}

/**
 * A ring lying flat in the XZ plane.
 * `radius` is to the tube centre, `thickness` is the tube radius.
 */
export function ring(
  radius: number,
  thickness: number,
  tubeSegments: number,
  ringSegments: number,
): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, thickness, tubeSegments, ringSegments)
  g.rotateX(Math.PI / 2)
  return prep(g)
}

/** Merge a parts list, or throw loudly — a silent null here means a blank model. */
export function bakeParts(parts: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error(`No geometry parts supplied for "${label}"`)
  const merged = parts.length === 1 ? parts[0].clone() : mergeGeometries(parts, false)
  if (!merged) throw new Error(`Failed to merge geometry for "${label}"`)
  merged.computeVertexNormals()
  return merged
}

/** Dispose a throwaway parts list after baking. */
export function disposeParts(...lists: THREE.BufferGeometry[][]): void {
  for (const list of lists) for (const g of list) g.dispose()
}
