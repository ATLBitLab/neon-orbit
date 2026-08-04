/**
 * Renderer, camera and post-processing chain.
 *
 * One stage is created at boot and shared by the hangar and the dogfight, so
 * shader compilation and the bloom render targets are paid for exactly once.
 *
 * Tone mapping deliberately lives in `OutputPass`, not in the materials:
 * three.js skips in-material tone mapping when drawing into a render target,
 * which is what `EffectComposer` does, so the composited HDR buffer gets
 * mapped and colour-converted in one place at the end of the chain.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

export interface Stage {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  composer: EffectComposer
  bloom: UnrealBloomPass
  render(): void
  resize(): void
  dispose(): void
}

const FOV = 74 // wide enough that speed reads without fisheye
const NEAR = 1
const FAR = 150000

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 1)

  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, NEAR, FAR)

  const scene = new THREE.Scene()

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.72, // strength
    0.62, // radius
    0.62, // luminance threshold — dark hulls stay matte, neon trim blooms
  )
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h, false)
    composer.setSize(w, h)
    bloom.setSize(w, h)
  }

  window.addEventListener('resize', resize)

  return {
    renderer,
    camera,
    scene,
    composer,
    bloom,
    render() {
      composer.render()
    },
    resize,
    dispose() {
      window.removeEventListener('resize', resize)
      composer.dispose()
      renderer.dispose()
    },
  }
}
