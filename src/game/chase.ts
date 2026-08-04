/**
 * Third-person chase camera.
 *
 * Sits behind and above the ship in the ship's own frame, so rolling rolls the
 * world — which is the whole reason a space fighter feels like flying rather
 * than steering a cursor. The follow is exponentially smoothed and deliberately
 * lags in position more than in rotation: the lag is where the sense of speed
 * and mass comes from.
 */

import * as THREE from 'three'
import type { Ship } from './ship'

/** Camera distance and height as multiples of the ship's own length. */
const DISTANCE = 1.85
const HEIGHT = 0.62
/** Look-at point ahead of the nose, also in ship lengths. */
const LEAD = 3.8

const POSITION_FOLLOW = 7.5
const ROTATION_FOLLOW = 11
const BASE_FOV = 74
/** Extra degrees of FOV at full throttle. */
const FOV_KICK = 9

const _back = new THREE.Vector3()
const _up = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _desired = new THREE.Vector3()
const _look = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _shake = new THREE.Vector3()

export interface ChaseCamera {
  /** Snap straight to the ideal pose — use on spawn to avoid a fly-in. */
  reset(ship: Ship): void
  update(ship: Ship, dt: number): void
  /** Add a knock, in world units of camera displacement. */
  shake(amount: number): void
}

export function createChaseCamera(camera: THREE.PerspectiveCamera): ChaseCamera {
  let shakeAmount = 0
  let fov = BASE_FOV

  function pose(ship: Ship, out: THREE.Vector3) {
    const scale = ship.visual.length
    _back.set(0, 0, 1).applyQuaternion(ship.quaternion)
    _up.set(0, 1, 0).applyQuaternion(ship.quaternion)
    out
      .copy(ship.position)
      .addScaledVector(_back, scale * DISTANCE)
      .addScaledVector(_up, scale * HEIGHT)
  }

  function aim(ship: Ship) {
    ship.forward(_forward)
    _look.copy(ship.position).addScaledVector(_forward, ship.visual.length * LEAD)
    _up.set(0, 1, 0).applyQuaternion(ship.quaternion)
    _matrix.lookAt(camera.position, _look, _up)
    _quat.setFromRotationMatrix(_matrix)
  }

  return {
    reset(ship) {
      pose(ship, _desired)
      camera.position.copy(_desired)
      aim(ship)
      camera.quaternion.copy(_quat)
      shakeAmount = 0
      fov = BASE_FOV
      camera.fov = fov
      camera.updateProjectionMatrix()
    },

    update(ship, dt) {
      pose(ship, _desired)
      camera.position.lerp(_desired, 1 - Math.exp(-POSITION_FOLLOW * dt))

      if (shakeAmount > 0.01) {
        _shake.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        camera.position.addScaledVector(_shake, shakeAmount * 2)
        shakeAmount *= Math.exp(-6 * dt)
      } else {
        shakeAmount = 0
      }

      aim(ship)
      camera.quaternion.slerp(_quat, 1 - Math.exp(-ROTATION_FOLLOW * dt))

      // FOV widens with speed. Only push a new projection matrix when the
      // change is visible, since that invalidates the frustum every call.
      const target = BASE_FOV + ship.speedFraction * FOV_KICK
      fov += (target - fov) * (1 - Math.exp(-3 * dt))
      if (Math.abs(camera.fov - fov) > 0.05) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
    },

    shake(amount) {
      shakeAmount = Math.min(6, shakeAmount + amount)
    },
  }
}
