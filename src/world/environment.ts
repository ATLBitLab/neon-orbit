/**
 * Assembles the arena: sky, planet, stations, debris, lighting, boundary grid.
 *
 * The combat volume is a sphere centred on the origin. The planet sits far
 * enough below and behind that it dominates the lower sky without ever being
 * reachable, so we never need terrain collision.
 */

import * as THREE from 'three'
import { chunk } from '../core/geo'
import { makeRng, WORLD_SEED } from '../core/rng'
import { buildMinefield, type Minefield } from './mines'
import { buildPickups, type Pickups } from './pickups'
import { buildPlanet, type Planet } from './planet'
import { buildSky, type Sky } from './sky'
import { buildStations, type Station } from './stations'

/** Soft edge of the combat volume — drag starts here. */
export const ARENA_RADIUS = 3400
/** Nothing gets past this; velocity is clamped inward. */
export const ARENA_HARD_LIMIT = 4300

export const SUN_DIRECTION = new THREE.Vector3(0.52, 0.34, -0.78).normalize()

/**
 * Where the player enters the arena. Lives here rather than in the game loop so
 * the minefield can be laid out around it — nobody should spawn inside a mine.
 */
export const PLAYER_SPAWN = new THREE.Vector3(0, 120, 1400)
/** Player's initial heading target. */
export const PLAYER_SPAWN_LOOK = new THREE.Vector3(0, 0, -200)

/** How wide a berth an AI gives a station. */
const STATION_AVOID_RANGE = 520

/**
 * The star sits at a finite distance rather than infinitely far away, so that
 * "closer to the sun" is a real position in the arena and not just a lighting
 * direction. Placed so its surface clears the hard limit by 400 units: the
 * sunward wall of the arena is the closest a pilot can ever get, and the hull
 * cooks well before then.
 */
export const SUN_DISTANCE = 5600
export const SUN_RADIUS = 900
export const SUN_POSITION = SUN_DIRECTION.clone().multiplyScalar(SUN_DISTANCE)

/** Hull starts taking radiant damage inside this distance from the star. */
export const SEAR_OUTER = 3900
/** At or inside this distance the burn runs at its full rate. */
export const SEAR_INNER = 2400

/**
 * How hard the star is cooking a hull at `position`, 0..1.
 *
 * Distance to a point rather than a projection along `SUN_DIRECTION`: the burn
 * zone is then a cap around the sunward axis, so flying *at* the visible star
 * is what hurts. Skimming the boundary anywhere else is safe, which keeps the
 * whole rest of the arena usable.
 */
export function solarExposure(position: THREE.Vector3): number {
  const dist = position.distanceTo(SUN_POSITION)
  if (dist >= SEAR_OUTER) return 0
  if (dist <= SEAR_INNER) return 1
  return (SEAR_OUTER - dist) / (SEAR_OUTER - SEAR_INNER)
}

const PLANET_RADIUS = 6000
const PLANET_CENTER = new THREE.Vector3(0, -10500, -2600)

/** A sphere that hurts to touch. */
export interface Hazard {
  center: THREE.Vector3
  radius: number
  /**
   * How far out an AI starts steering around this. Per-hazard rather than one
   * global constant because the two kinds differ by an order of magnitude: a
   * station needs a wide berth, while giving two dozen mines the same 520-unit
   * bubble would shove enemies around the arena permanently.
   */
  avoidRange: number
  name: string
}

export interface Environment {
  group: THREE.Group
  stations: Station[]
  /** Solid obstacles: ships bounce off these and bolts stop on them. */
  hazards: Hazard[]
  /** Mines detonate on contact instead, so they are tracked separately. */
  minefield: Minefield
  /** Power-up pods. Harmless, so they are not hazards and the AI ignores them. */
  pickups: Pickups
  planet: Planet
  /**
   * Advance the parts of the world that decide outcomes. Today that is only
   * power-up respawn clocks — stations, mines, debris and sky all animate
   * without ever changing what the arena *is*. Runs on the simulation's fixed
   * tick, and is the only half a headless run needs.
   */
  step(dt: number): void
  /**
   * Advance the parts of the world that only have to look right: spin, drift,
   * pulse and billboarding. Runs once per rendered frame at the frame's own
   * delta, so it stays smooth on a display faster than the tick rate.
   *
   * The camera is needed because power-up pods billboard — see `pickups.ts`.
   */
  update(dt: number, camera: THREE.Camera): void
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* Debris                                                                      */
/* -------------------------------------------------------------------------- */

interface Debris {
  mesh: THREE.InstancedMesh
  update(dt: number): void
  dispose(): void
}

/**
 * Tumbling rock, purely for parallax. In an empty volume it is impossible to
 * judge your own speed; a few dozen nearby objects fix that for free.
 */
function buildDebris(count: number): Debris {
  const rng = makeRng(WORLD_SEED ^ 0x5eed)
  const geometry = chunk(1, 0)
  const material = new THREE.MeshPhongMaterial({
    color: 0x3a3a48,
    flatShading: true,
    shininess: 6,
    specular: 0x4a5566,
    emissive: 0x070810,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false

  const basis = new THREE.Object3D()
  const spins: THREE.Vector3[] = []
  const rots: THREE.Euler[] = []
  const positions: THREE.Vector3[] = []
  const scales: number[] = []

  for (let i = 0; i < count; i++) {
    // Uniform direction, biased radius so debris clusters mid-arena.
    const u = rng.range(-1, 1)
    const theta = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(Math.max(0, 1 - u * u))
    const dist = rng.range(500, ARENA_RADIUS * 0.94)
    positions.push(
      new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta)).multiplyScalar(dist),
    )
    scales.push(rng.range(4, 26))
    rots.push(new THREE.Euler(rng.range(0, 7), rng.range(0, 7), rng.range(0, 7)))
    spins.push(new THREE.Vector3(rng.spread(0.25), rng.spread(0.25), rng.spread(0.25)))
  }

  function write() {
    for (let i = 0; i < count; i++) {
      basis.position.copy(positions[i])
      basis.rotation.copy(rots[i])
      basis.scale.setScalar(scales[i])
      basis.updateMatrix()
      mesh.setMatrixAt(i, basis.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }
  write()

  return {
    mesh,
    update(dt: number) {
      for (let i = 0; i < count; i++) {
        rots[i].x += spins[i].x * dt
        rots[i].y += spins[i].y * dt
        rots[i].z += spins[i].z * dt
      }
      write()
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      mesh.dispose()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Boundary                                                                    */
/* -------------------------------------------------------------------------- */

/** A barely-there containment grid. Orientation cue, not a wall you can read. */
function buildBoundary(): { mesh: THREE.LineSegments; dispose(): void } {
  const source = new THREE.IcosahedronGeometry(ARENA_RADIUS, 2)
  const geometry = new THREE.WireframeGeometry(source)
  source.dispose()
  // Dim colour as well as low opacity: at full neon cyan the bloom pass
  // rediscovers these lines and paints a cage over the whole sky.
  const material = new THREE.LineBasicMaterial({
    color: 0x14454e,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  })
  const mesh = new THREE.LineSegments(geometry, material)
  return {
    mesh,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export function buildEnvironment(): Environment {
  const group = new THREE.Group()
  const rng = makeRng(WORLD_SEED)

  const sky: Sky = buildSky(rng, { position: SUN_POSITION, radius: SUN_RADIUS })
  const planet: Planet = buildPlanet(rng, {
    radius: PLANET_RADIUS,
    center: PLANET_CENTER,
    sunDirection: SUN_DIRECTION,
    detail: 26,
  })
  const stations = buildStations()
  const debris = buildDebris(90)
  const boundary = buildBoundary()

  group.add(sky.group, planet.group, debris.mesh, boundary.mesh)
  for (const s of stations) group.add(s.group)

  /* ---- Lighting --------------------------------------------------------- */
  // One hard sun for the facets, plus a cold/warm hemisphere bounce so hulls
  // never go fully black on the shadow side. No shadow maps — the look wants
  // crisp flat facets, not soft occlusion.

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6)
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20000)

  const bounce = new THREE.HemisphereLight(0x2b4cff, 0x4a0f52, 0.65)
  const fill = new THREE.AmbientLight(0x0f1836, 0.85)

  // A weak magenta rim light opposite the sun sells the cyberpunk palette.
  const rim = new THREE.DirectionalLight(0xff2d95, 0.55)
  rim.position.copy(SUN_DIRECTION).multiplyScalar(-14000).add(new THREE.Vector3(0, 4000, 0))

  group.add(sun, bounce, fill, rim)

  const hazards: Hazard[] = stations.map((s) => ({
    center: s.center,
    radius: s.hazardRadius,
    avoidRange: STATION_AVOID_RANGE,
    name: s.name,
  }))

  // Mines are placed after the stations so they can be kept out of them.
  const minefield = buildMinefield({
    count: 26,
    arenaRadius: ARENA_RADIUS,
    hazards,
    spawn: PLAYER_SPAWN,
  })
  group.add(minefield.group)

  // Pods are placed last, so they can be kept out of the stations *and* out of
  // the minefield. Repair is the most common because it is the routine resource
  // you plan a run around; the two timed buffs are the ones worth breaking off
  // a fight for, and are rarer for it.
  const pickups = buildPickups({
    counts: { repair: 5, overdrive: 4, shield: 4 },
    arenaRadius: ARENA_RADIUS,
    hazards,
    mines: minefield.mines.map((m) => m.position),
    spawn: PLAYER_SPAWN,
  })
  group.add(pickups.group)

  return {
    group,
    stations,
    hazards,
    minefield,
    pickups,
    planet,
    step(dt: number) {
      pickups.step(dt)
    },

    update(dt: number, camera: THREE.Camera) {
      sky.update(dt)
      planet.update(dt)
      debris.update(dt)
      minefield.update(dt)
      pickups.update(dt, camera)
      for (const s of stations) s.update(dt)
    },
    dispose() {
      sky.dispose()
      planet.dispose()
      debris.dispose()
      boundary.dispose()
      minefield.dispose()
      pickups.dispose()
    },
  }
}
