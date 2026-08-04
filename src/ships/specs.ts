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

export interface ShipSpec {
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

  /** 0..1 bars for the hangar cards. */
  bars: { speed: number; agility: number; armor: number; firepower: number }
}

export const SHIPS: Record<ShipId, ShipSpec> = {
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
    quirk: { kind: 'heat', max: 100, perShot: 7.5, coolRate: 36, lockout: 2.2 },
    strengths: ['Highest top speed and turn rate', 'Machine-gun laser, huge sustained DPS'],
    weaknesses: ['Thinnest hull in the fleet', 'Guns overheat and lock out if you hold the trigger'],
    bars: { speed: 1.0, agility: 1.0, armor: 0.22, firepower: 0.78 },
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
    quirk: { kind: 'regen', delay: 4, rate: 9 },
    strengths: ['Triple the Wasp hull', 'Twin siege cannons — two volleys end a Wasp'],
    weaknesses: ['Slowest airframe, wallows through turns', 'Long reload punishes every miss'],
    bars: { speed: 0.34, agility: 0.26, armor: 1.0, firepower: 0.92 },
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
    fireInterval: 0.22,
    damage: 12,
    boltSpeed: 1180,
    barrels: 2,
    barrelSpread: 5.4,
    radius: 11,
    bounty: 120,
    quirk: { kind: 'dash', cooldown: 5, duration: 0.55, impulse: 900 },
    strengths: ['Balanced hull, speed and twin lasers', 'Phase dash slips punches and closes gaps'],
    weaknesses: ['Loses a straight race to a Wasp', 'Loses a slugging match to a Drone'],
    bars: { speed: 0.62, agility: 0.62, armor: 0.58, firepower: 0.66 },
  },
}

export const SHIP_ORDER: ShipId[] = ['wasp', 'hornet', 'drone']

export function otherShips(id: ShipId): ShipId[] {
  return SHIP_ORDER.filter((s) => s !== id)
}
