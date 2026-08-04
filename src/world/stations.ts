/**
 * Orbital infrastructure, circa 2500.
 *
 * Four archetypes — spin habitat, spine dock, fusion sphere, solar farm — each
 * baked into three draw calls: a flat-shaded hull, glowing edge seams, and an
 * additive layer for windows and running lights. Only the solid core of each
 * station collides; rings, trusses and panels are deliberately fly-through so
 * the fun move (threading a habitat ring at full throttle) stays available.
 */

import * as THREE from 'three'
import { at, bakeParts, blister, box, chunk, disposeParts, post, ring, spike, spun, tube } from '../core/geo'

export interface Station {
  group: THREE.Group
  name: string
  /** World-space centre — also the centre of the collision sphere. */
  center: THREE.Vector3
  /** Collision radius around the solid core. */
  hazardRadius: number
  update(dt: number): void
}

interface Parts {
  hull: THREE.BufferGeometry[]
  lights: THREE.BufferGeometry[]
  /** Radius of the solid core, before placement scale. */
  core: number
  /** Radians/sec about the local Y axis. */
  spin: number
}

/* -------------------------------------------------------------------------- */
/* Archetypes                                                                  */
/* -------------------------------------------------------------------------- */

/** A spin habitat: torus rim, hub, four spokes. Fly the gap if you dare. */
function ringHabitat(): Parts {
  const spoke = box(126, 7, 7, 87)
  const slit = box(2, 7, 16, 167)

  const hull: THREE.BufferGeometry[] = [
    ring(150, 16, 8, 30), // rim
    post(26, 26, 76, 8), // hub barrel
    post(0, 26, 22, 8, 49), // hub cap, up
    post(26, 0, 22, 8, -49), // hub cap, down
    post(1.6, 1.6, 70, 6, 74), // comms mast
    blister(20, 14, 20, 40),
  ]
  for (let i = 0; i < 4; i++) hull.push(spun(spoke, (i * Math.PI) / 2))

  const lights: THREE.BufferGeometry[] = [
    post(3.4, 3.4, 3.4, 6, 112), // mast beacon
    ring(150, 17.4, 4, 30),
  ]
  for (let i = 0; i < 30; i++) lights.push(spun(slit, (i * Math.PI * 2) / 30))

  spoke.dispose()
  slit.dispose()
  return { hull, lights, core: 46, spin: 0.085 }
}

/** A spine dock: 400m keel, staggered habitation modules, solar wings. */
function spineDock(): Parts {
  const hull: THREE.BufferGeometry[] = [
    tube(9, 9, 400, 8, 0), // keel
    spike(9, 26, 8, -213), // bow cap
    tube(11, 13, 16, 8, 208), // stern drive cluster
    box(120, 1.4, 70, 86, 0, 130), // solar wings
    box(120, 1.4, 70, -86, 0, 130),
    box(52, 3.4, 3.4, 52, 0, 130), // wing spars
    box(52, 3.4, 3.4, -52, 0, 130),
    box(5, 60, 92, 0, 0, -150), // radiator fin
  ]

  const lights: THREE.BufferGeometry[] = [
    box(1.8, 1.8, 380, 0, 9.8), // keel strip
    box(1.8, 1.8, 380, 0, -9.8),
  ]

  // Six modules alternating port and starboard down the keel.
  for (let i = 0; i < 6; i++) {
    const z = -140 + i * 56
    const x = i % 2 === 0 ? 26 : -26
    hull.push(box(34, 26, 40, x, 0, z))
    hull.push(box(4, 4, 34, x * 0.45, 0, z)) // umbilical to keel
    lights.push(box(30, 1.5, 2.4, x, 8, z))
    lights.push(box(30, 1.5, 2.4, x, 1, z))
    lights.push(box(30, 1.5, 2.4, x, -6, z))
  }

  // Panel grid lines, so the wings read as photovoltaic rather than as slabs.
  const gridline = box(112, 0.5, 1.4, 0, 1.0, 0)
  for (let k = 0; k < 7; k++) {
    const z = 130 - 30 + k * 10
    lights.push(at(gridline, 86, 0, z))
    lights.push(at(gridline, -86, 0, z))
  }
  gridline.dispose()

  return { hull, lights, core: 62, spin: 0.012 }
}

/** A fusion sphere: containment shell, three canted rings, glowing core. */
function fusionSphere(): Parts {
  const strut = box(84, 5, 5, 82)
  const hoop = ring(104, 6, 6, 28)

  const hull: THREE.BufferGeometry[] = [
    chunk(64, 1), // faceted containment shell
    hoop.clone(),
    hoop.clone().rotateX(Math.PI / 2.6),
    hoop.clone().rotateZ(Math.PI / 2.9),
    post(9, 9, 190, 6), // axial mast
    post(0, 22, 26, 6, 108), // upper injector
    post(22, 0, 26, 6, -108), // lower injector
  ]
  for (let i = 0; i < 4; i++) hull.push(spun(strut, Math.PI / 4 + (i * Math.PI) / 2))

  const lights: THREE.BufferGeometry[] = [
    chunk(50, 1), // the core seen through the shell gaps
    ring(104, 7.6, 4, 28),
    post(5, 5, 200, 6),
  ]

  strut.dispose()
  hoop.dispose()
  return { hull, lights, core: 78, spin: 0.05 }
}

/** A solar farm: central truss, eight tracking panels, radiator stack. */
function solarFarm(): Parts {
  const hull: THREE.BufferGeometry[] = [
    tube(14, 14, 300, 6, 0), // truss
    chunk(28, 1), // hub
    box(6, 62, 96, 0, 0, 166), // radiator stack
    tube(16, 20, 14, 6, -158), // bus module
  ]
  const lights: THREE.BufferGeometry[] = [blister(19, 13, 19, 22), box(2, 2, 290, 0, 15)]

  const panel = box(118, 1.2, 60)
  const armR = box(58, 4, 4, 42) // spans x 13..71, hub out to panel
  const armL = box(58, 4, 4, -42)
  const gridline = box(110, 0.5, 1.3, 0, 0.9)

  for (const z of [-104, -32, 38, 108]) {
    for (const side of [1, -1]) {
      hull.push(at(panel, side * 78, 0, z))
      hull.push(at(side === 1 ? armR : armL, 0, 0, z))
      for (let k = 0; k < 5; k++) lights.push(at(gridline, side * 78, 0, z - 24 + k * 12))
    }
  }

  panel.dispose()
  armR.dispose()
  armL.dispose()
  gridline.dispose()
  return { hull, lights, core: 40, spin: 0.03 }
}

const ARCHETYPES = {
  ring: ringHabitat,
  spine: spineDock,
  fusion: fusionSphere,
  solar: solarFarm,
} as const

type ArchetypeId = keyof typeof ARCHETYPES

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

interface Placement {
  kind: ArchetypeId
  name: string
  pos: [number, number, number]
  rot: [number, number, number]
  scale: number
  accent: number
}

/**
 * Hand-placed rather than scattered. The arena is the same every run, so it is
 * worth composing: something big low and forward to give the planet scale,
 * something to fight around at mid distance, nothing directly on spawn.
 */
const PLACEMENTS: Placement[] = [
  { kind: 'ring', name: 'VERDANT STATION', pos: [980, 240, -1560], rot: [0.22, 0.5, 0.12], scale: 1.0, accent: 0x35f5ff },
  { kind: 'spine', name: 'DOCK KESTREL', pos: [-1720, -300, 760], rot: [0.1, -1.15, 0.06], scale: 1.0, accent: 0xff2d95 },
  { kind: 'fusion', name: 'CORE HELIOS', pos: [420, 820, 1880], rot: [0.4, 0.3, 0.0], scale: 1.0, accent: 0xffb020 },
  { kind: 'solar', name: 'ARRAY MERIDIAN', pos: [-1180, 620, -2120], rot: [-0.2, 0.85, 0.15], scale: 1.1, accent: 0xb6ff3d },
  { kind: 'ring', name: 'RELAY SIX', pos: [2320, -540, 880], rot: [-0.3, 2.1, -0.1], scale: 0.72, accent: 0x9a6cff },
]

const HULL_MATERIAL = new THREE.MeshPhongMaterial({
  color: 0x2b3140,
  flatShading: true,
  shininess: 30,
  specular: 0x5d7285,
  emissive: 0x080d16,
})

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

const bakedCache = new Map<ArchetypeId, { hull: THREE.BufferGeometry; edges: THREE.BufferGeometry; lights: THREE.BufferGeometry; core: number; spin: number }>()

function bake(kind: ArchetypeId) {
  const hit = bakedCache.get(kind)
  if (hit) return hit

  const parts = ARCHETYPES[kind]()
  const hull = bakeParts(parts.hull, `station:${kind}:hull`)
  const lights = bakeParts(parts.lights, `station:${kind}:lights`)
  // 34° keeps structural seams and drops the facet chatter inside tori.
  const edges = new THREE.EdgesGeometry(hull, 34)
  disposeParts(parts.hull, parts.lights)

  const baked = { hull, edges, lights, core: parts.core, spin: parts.spin }
  bakedCache.set(kind, baked)
  return baked
}

export function buildStations(): Station[] {
  return PLACEMENTS.map((p) => {
    const baked = bake(p.kind)
    const accent = new THREE.Color(p.accent)

    const lightMat = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const edgeMat = new THREE.LineBasicMaterial({
      color: accent.clone().lerp(new THREE.Color(0xffffff), 0.25),
      transparent: true,
      opacity: 0.45,
    })

    // The spinning parts live one level down so placement rotation is stable.
    const body = new THREE.Group()
    body.add(new THREE.Mesh(baked.hull, HULL_MATERIAL))
    body.add(new THREE.LineSegments(baked.edges, edgeMat))
    body.add(new THREE.Mesh(baked.lights, lightMat))

    const group = new THREE.Group()
    group.position.set(...p.pos)
    group.rotation.set(...p.rot)
    group.scale.setScalar(p.scale)
    group.add(body)

    const spin = baked.spin
    return {
      group,
      name: p.name,
      center: new THREE.Vector3(...p.pos),
      hazardRadius: baked.core * p.scale,
      update(dt: number) {
        body.rotation.y += spin * dt
      },
    }
  })
}
