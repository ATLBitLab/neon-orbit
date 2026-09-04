/**
 * The pilot of a seat nobody has taken.
 *
 * A host's match has a seat per hull, and until a person is in one it is flown
 * by this: a peer that has not arrived yet, or one that dropped, leaves a seat
 * that would otherwise fly a neutral stick in a straight line — a ghost that
 * the squadron shoots for free and that a match rule counts as a participant.
 *
 * Two rules keep it honest, and both are the same rules a person is under:
 *
 * - **It flies the seat's view, not the ship.** Its whole input is the
 *   `RunSnapshot` a scripted pilot gets — body-frame bearing and range to the
 *   locked target, hull, solar exposure — so it can see nothing a console
 *   cannot, and it produces the same `Controls` a keyboard does. `aim` is null
 *   and `spread` is zero here and dropped by seat admission anyway, so it
 *   fires down its nose like anyone else.
 * - **It draws from its own stream.** Wander comes from the `Rng` it is given,
 *   which the host seeds per seat, so a seed replays the same match whether or
 *   not anyone ever joined it.
 *
 * It is not `EnemyPilot`: that steers a hull it holds, leads its shots, and
 * has a profile per airframe. This is a proportional controller with a jink,
 * the same shape as the autopilot the headless suite flies every seat on, and
 * it is meant to hold a seat rather than to win the match for whoever takes it.
 */

import { rampThrottle } from './intent'
import type { RunSnapshot } from './game'
import type { Controls } from './ship'
import { SHIPS, type ShipId } from '../ships/specs'
import type { Rng } from '../core/rng'

/** Stick deflection per radian of bearing error. */
export const STEER_GAIN = 3
/** Fire when the lead point is inside this cone, radians. */
export const FIRE_CONE = 0.35
/** And inside this range: bolts past it are heat spent on nothing. */
export const FIRE_RANGE = 900
/** Open the throttle beyond this range to the target. */
export const CLOSE_IN = 260
/** Back it off inside this range: a ram is a bad trade for both hulls. */
export const BACK_OFF = 170
/** Wander added to the stick while still closing, so two wingmen do not fly one line. */
export const JINK = 0.35
/** Seconds between wander changes. */
export const JINK_EVERY: [number, number] = [0.7, 1.6]
/** Wander stops inside this range: the shot matters more than the line in. */
export const JINK_BEYOND = 450
/** Detour to a repair pod below this fraction of hull, if one is near. */
export const REPAIR_BELOW = 0.4
export const REPAIR_WITHIN = 1600
/** Solar exposure at which the seat stops fighting and turns hard away. */
export const SEAR_ESCAPE = 0.15

export interface SeatAutopilot {
  /**
   * Produce this tick's controls from the seat's view. `null` — the seat is
   * wrecked, eliminated, or the match is not running — holds the stick still
   * and the trigger off. The struct is reused; the game copies what it flies.
   */
  advance(view: RunSnapshot | null, dt: number): Controls
  /** What it last produced. A peer taking the seat over ramps from this throttle. */
  readonly controls: Controls
}

function clamp(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

export function createSeatAutopilot(ship: ShipId, rng: Rng): SeatAutopilot {
  const maxHull = SHIPS[ship].maxHull
  const controls: Controls = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0.6,
    fire: false,
    dash: false,
    aim: null,
    spread: 0,
  }
  let jinkPitch = 0
  let jinkYaw = 0
  let jinkTimer = 0

  function rejink(): void {
    jinkTimer = rng.range(JINK_EVERY[0], JINK_EVERY[1])
    jinkPitch = rng.range(-JINK, JINK)
    jinkYaw = rng.range(-JINK, JINK)
  }
  rejink()

  return {
    controls,
    advance(view, dt) {
      controls.fire = false
      controls.dash = false
      if (!view) {
        controls.pitch = 0
        controls.yaw = 0
        return controls
      }
      jinkTimer -= dt
      if (jinkTimer <= 0) rejink()

      // Cooking: nothing else matters until the nose is off the star. A hard
      // constant turn at full throttle is what a person does too — the view has
      // no bearing to the sun, only the heat, and any hard turn changes heading.
      if (view.solarExposure > SEAR_ESCAPE) {
        controls.pitch = 1
        controls.yaw = 0
        controls.throttle = rampThrottle(controls.throttle, 1, dt)
        return controls
      }

      // Hurt with a repair pod near: go and get it rather than trade the last of the hull.
      const repair = view.pickups.repair
      if (view.hull < maxHull * REPAIR_BELOW && repair && repair.range < REPAIR_WITHIN) {
        controls.pitch = clamp(repair.pitch * STEER_GAIN)
        controls.yaw = clamp(repair.yaw * STEER_GAIN)
        controls.throttle = rampThrottle(controls.throttle, 1, dt)
        return controls
      }

      const t = view.target
      if (!t) {
        // Nothing locked: a slow, wandering turn at cruise rather than a straight
        // line, which is the difference between circling inside the arena until
        // something arrives and flying out of it.
        controls.pitch = jinkPitch * 0.5
        controls.yaw = 0.25 + jinkYaw * 0.5
        controls.throttle = rampThrottle(controls.throttle, 0.6, dt)
        return controls
      }

      const closing = t.range > JINK_BEYOND
      controls.pitch = clamp(t.pitch * STEER_GAIN + (closing ? jinkPitch : 0))
      controls.yaw = clamp(t.yaw * STEER_GAIN + (closing ? jinkYaw : 0))
      controls.fire = t.range < FIRE_RANGE && Math.abs(t.pitch) < FIRE_CONE && Math.abs(t.yaw) < FIRE_CONE
      if (t.range > CLOSE_IN) controls.throttle = rampThrottle(controls.throttle, 1, dt)
      else if (t.range < BACK_OFF) controls.throttle = rampThrottle(controls.throttle, 0, dt)
      return controls
    },
  }
}
