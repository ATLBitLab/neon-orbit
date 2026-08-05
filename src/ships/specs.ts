/**
 * The three airframes of the Neon Orbit patrol.
 *
 * Every number here is tuned against an arena radius of ~3400 units and ships
 * roughly 30 units long, so speeds read as "fast" without the planet whipping
 * past. Balance intent: Wasp wins by never being where you aimed, Drone wins by
 * absorbing a mistake you cannot, Hornet wins by making fewer compromises.
 */

export type ShipId = 'wasp' | 'drone' | 'hornet'

/** Ship-defining gimmick. Exactly one per airframe. */
export type Quirk =
  | {
      kind: 'heat'
      /** Heat units before the guns lock out. */
      max: number
      perShot: number
      /** Units bled per second while not firing. */
      coolRate: number
      /** Seconds of forced silence after a full overheat. */
      lockout: number
    }
  | {
      kind: 'regen'
      /** Seconds of not being hit before nanite repair kicks in. */
      delay: number
      /** Hull points restored per second. */
      rate: number
    }
  | {
      kind: 'dash'
      cooldown: number
      duration: number
      /** Velocity added along current facing, in units/sec. */
      impulse: number
    }

export interface ShipStats {
  id: ShipId
  name: string
  callsign: string
  tagline: string
  /** Neon trim / laser colour. */
  accent: number
  /** Flat-shaded hull plate colour. */
  hullColor: number

  maxHull: number
  /** Top speed at full throttle, units/sec. */
  maxSpeed: number
  /** Throttle response, units/sec². */
  accel: number
  /** Pitch + yaw authority, radians/sec. */
  turnRate: number
  rollRate: number
  /**
   * How eagerly velocity snaps to the nose, per second. Low values leave the
   * ship sliding through turns — heavy hulls drift, light hulls skate.
   */
  grip: number

  fireInterval: number
  damage: number
  boltSpeed: number
  /** 1 = centreline gun, 2 = wing pair. */
  barrels: number
  /** Half-distance between wing barrels. */
  barrelSpread: number

  /** Collision sphere, units. */
  radius: number
  /** Points for shooting one of these down. */
  bounty: number

  quirk: Quirk

  strengths: string[]
  weaknesses: string[]
}

/** A stat block plus the card bars derived from it. */
export interface ShipSpec extends ShipStats {
  /** 0..1 bars for the hangar cards, each stat as a fraction of the fleet best. */
  bars: { speed: number; agility: number; armor: number; firepower: number }
}

const STATS: Record<ShipId, ShipStats> = {
  wasp: {
    id: 'wasp',
    name: 'Wasp',
    callsign: 'SK-09 Interceptor',
    tagline: 'A cockpit bolted to an engine. Hits like a hornet, folds like foil.',
    accent: 0xff2d95,
    hullColor: 0x3b2b46,
    maxHull: 70,
    maxSpeed: 470,
    accel: 330,
    turnRate: 1.95,
    rollRate: 3.1,
    grip: 3.4,
    fireInterval: 0.085,
    damage: 5,
    boltSpeed: 1450,
    barrels: 1,
    barrelSpread: 0,
    radius: 9,
    bounty: 150,
    /**
     * Tuned so that *releasing* the trigger is the strong play. The old numbers
     * inverted that: heat climbed at 88/s against a 36/s vent that only ran
     * while not firing, so the bar filled in 1.1s and the 2.2s lockout vented it
     * faster than pulsing could. Mashing beat discipline, and the fleet's
     * fastest gun averaged 21 DPS — the lowest in the game, on the airframe
     * whose card sells sustained fire.
     *
     * Now: 2.4s of held fire before lockout, and a vent quick enough that a
     * pilot who feathers the trigger holds ~75% uptime. Mashing still works,
     * it just costs about a third of your damage.
     */
    quirk: { kind: 'heat', max: 100, perShot: 3.6, coolRate: 125, lockout: 2.9 },
    strengths: ['Highest top speed and turn rate', 'Machine-gun laser that rewards trigger control'],
    weaknesses: ['Thinnest hull in the fleet', 'Guns overheat and lock out if you hold the trigger'],
  },

  drone: {
    id: 'drone',
    name: 'Drone',
    callsign: 'BX-40 Bulwark',
    tagline: 'A gun platform that happens to fly. Nothing here is in a hurry.',
    accent: 0xffb020,
    hullColor: 0x453521,
    maxHull: 200,
    maxSpeed: 250,
    accel: 135,
    turnRate: 0.95,
    rollRate: 1.35,
    grip: 1.5,
    fireInterval: 0.86,
    damage: 20,
    boltSpeed: 980,
    barrels: 2,
    barrelSpread: 7.5,
    radius: 14,
    bounty: 200,
    quirk: { kind: 'regen', delay: 6.5, rate: 9 },
    strengths: ['Triple the Wasp hull', 'Twin siege cannons — two volleys end a Wasp'],
    weaknesses: ['Slowest airframe, wallows through turns', 'Long reload punishes every miss'],
  },

  hornet: {
    id: 'hornet',
    name: 'Hornet',
    callsign: 'AV-22 Lancer',
    tagline: 'The fleet standard. No glaring hole, no free lunch either.',
    accent: 0x35f5ff,
    hullColor: 0x28384e,
    maxHull: 120,
    maxSpeed: 355,
    accel: 225,
    turnRate: 1.45,
    rollRate: 2.25,
    grip: 2.6,
    /**
     * The fleet standard is not supposed to also be the best gun in the fleet.
     * At 12 x 2 per 0.22s it did 109 DPS — 2.3x the Drone's siege cannons and
     * 5x the Wasp's, with no heat, no reload tell and a dash on top. A steadier
     * 10 x 2 per 0.30s keeps the twin-laser rhythm and puts it 1.4x over the
     * Drone instead: better than both, dominant over neither.
     */
    fireInterval: 0.3,
    damage: 10,
    boltSpeed: 1180,
    barrels: 2,
    barrelSpread: 5.4,
    radius: 11,
    bounty: 120,
    quirk: { kind: 'dash', cooldown: 5, duration: 0.55, impulse: 900 },
    strengths: ['Balanced hull, speed and twin lasers', 'Phase dash slips punches and closes gaps'],
    weaknesses: ['Loses a straight race to a Wasp', 'Loses a slugging match to a Drone'],
  },
}

/* -------------------------------------------------------------------------- */
/* Derived firepower                                                          */
/* -------------------------------------------------------------------------- */

/** Damage landed by a single trigger pull, every barrel connecting. */
export function alphaStrike(spec: ShipStats): number {
  return spec.damage * spec.barrels
}

/** Damage per second while the trigger is down and the guns still answer. */
export function burstDps(spec: ShipStats): number {
  return alphaStrike(spec) / spec.fireInterval
}

/**
 * Damage per second a pilot can actually hold indefinitely.
 *
 * Only the heat quirk limits this. Heat vents only while the trigger is up, so
 * a heat gun has to spend part of every second cooling no matter how fast it
 * vents, and the share left for firing is the equilibrium of the two rates —
 * fire for `f`, vent for `1 - f`, with `f * heatRate == (1 - f) * coolRate`.
 * That is the ceiling a pilot with perfect trigger discipline approaches;
 * overheating into the lockout lands well below it, which is the whole point of
 * the quirk. Slightly conservative in practice: a real pilot swings past the
 * redline and back, and the gun is always ready the instant they re-trigger.
 * `scripts/balance.ts` measures the real figure and checks it against this one.
 */
export function sustainedDps(spec: ShipStats): number {
  const burst = burstDps(spec)
  const q = spec.quirk
  if (q.kind !== 'heat') return burst

  const heatRate = q.perShot / spec.fireInterval
  return burst * (q.coolRate / (heatRate + q.coolRate))
}

/**
 * Card bars are derived, never hand-authored.
 *
 * A typed-in bar is a claim that goes stale the moment someone edits the stat
 * above it, and this is not hypothetical: the Wasp shipped advertising 0.78
 * firepower against the Hornet's 0.66 while actually doing a fifth of its
 * damage. Deriving them means the hangar cannot lie about the flight model,
 * only render it.
 */
function deriveBars(spec: ShipStats, fleet: ShipStats[]): ShipSpec['bars'] {
  const best = (stat: (s: ShipStats) => number): number => Math.max(...fleet.map(stat))
  return {
    speed: spec.maxSpeed / best((s) => s.maxSpeed),
    agility: spec.turnRate / best((s) => s.turnRate),
    armor: spec.maxHull / best((s) => s.maxHull),
    firepower: sustainedDps(spec) / best(sustainedDps),
  }
}

const FLEET = Object.values(STATS)

export const SHIPS: Record<ShipId, ShipSpec> = Object.fromEntries(
  Object.entries(STATS).map(([id, spec]) => [id, { ...spec, bars: deriveBars(spec, FLEET) }]),
) as Record<ShipId, ShipSpec>

export const SHIP_ORDER: ShipId[] = ['wasp', 'hornet', 'drone']

export function otherShips(id: ShipId): ShipId[] {
  return SHIP_ORDER.filter((s) => s !== id)
}
