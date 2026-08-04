import './style.css'
import * as THREE from 'three'
import { createStage } from './core/stage'
import { buildEnvironment } from './world/environment'
import { SHIPS } from './ships/specs'
import { buildShip } from './ships/meshes'

const canvas = document.getElementById('scene') as HTMLCanvasElement
const stage = createStage(canvas)
const env = buildEnvironment()
stage.scene.add(env.group)

// Temporary art-direction harness: park the three ships in front of the camera
// and drift past the arena so the planet, stations and neon trim can be judged.
const ships = Object.values(SHIPS).map((spec, i) => {
  const v = buildShip(spec)
  v.group.position.set((i - 1) * 62, 0, -900)
  v.group.rotation.y = 0.7
  stage.scene.add(v.group)
  return v
})

const clock = new THREE.Clock()
let t = 0

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  t += dt
  env.update(dt)

  for (const s of ships) s.group.rotation.y += dt * 0.35

  const orbit = 95
  stage.camera.position.set(Math.sin(t * 0.12) * orbit, 22, -900 + Math.cos(t * 0.12) * orbit)
  stage.camera.lookAt(0, 0, -900)

  stage.render()
  requestAnimationFrame(frame)
}

frame()
