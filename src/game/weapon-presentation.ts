/** Local predicted tracers and sound. Never part of a snapshot or a damage decision. */
import * as THREE from 'three'
import type { Audio } from '../core/audio'
import { createBolts, type BoltTarget, type FireRequest } from './bolts'
import type { Hazard } from '../world/environment'

export function createWeaponPresentation(audio: Audio) {
  const bolts = createBolts()
  bolts.mesh.name = 'predicted-bolts'
  let presented = 0
  let volley = 0
  let fresh = false
  let tracer = 0
  const ghostDirection = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)

  return {
    mesh: bolts.mesh,
    // An acknowledged volley may already have been presented before correction.
    confirm(shots: number) { presented = Math.max(presented, shots) },
    begin(shots: number) {
      volley = shots + 1
      fresh = volley > presented
      tracer = 0
    },
    fire(request: FireRequest) {
      if (!fresh) return
      bolts.fire({ ...request, damage: 0 })
      // One wider, non-damaging tracer beside each real Drone bolt sells the
      // barrage locally without adding a single slot to the network snapshot.
      for (let i = 0; i < (request.cosmeticTracers ?? 0); i++) {
        const angle = (tracer++ % 2 === 0 ? -1 : 1) * 0.022
        ghostDirection.copy(request.direction).applyAxisAngle(request.tracerAxis ?? up, angle)
        bolts.fire({ ...request, direction: ghostDirection, damage: 0 })
      }
    },
    laser() {
      if (!fresh) return
      presented = volley
      audio.laser(true)
    },
    overheat() { if (fresh) audio.overheat() },
    advance(dt: number, targets: readonly BoltTarget[], hazards: Hazard[]) {
      // Stop a tracer against the visible world without invoking a Ship callback.
      const visible = targets.map(t => ({
        position: t.position, radius: t.radius, alive: t.alive,
        targetable: t.targetable, faction: t.faction, takeDamage() {},
      }))
      bolts.update(dt, visible, hazards)
    },
    render: bolts.render,
    clear() { bolts.clear(); presented = 0; volley = 0; fresh = false },
    dispose: bolts.dispose,
  }
}
