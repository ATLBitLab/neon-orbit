/**
 * NEON ORBIT — entry point.
 *
 * Owns the single render loop and the screen state machine. Everything
 * expensive (renderer, post-processing chain, planet, stations) is built once
 * at boot and shared between the hangar and the dogfight, so choosing a ship
 * and launching never costs a load.
 */

import './style.css'
import * as THREE from 'three'
import { createAudio } from './core/audio'
import { createInput } from './core/input'
import { bestFor, lastShip, recordRun, rememberShip, type RunResult } from './core/scores'
import { createStage } from './core/stage'
import { createGame } from './game/game'
import { createHud } from './game/hud'
import type { ShipId } from './ships/specs'
import { createHangar } from './ui/hangar'
import { createDebriefPanel, createPausePanel } from './ui/panels'
import { buildEnvironment } from './world/environment'

type Screen = 'hangar' | 'flight' | 'paused' | 'debrief'

/** Longest frame the simulation will accept, so a tab-switch cannot teleport
 *  ships through each other. */
const MAX_STEP = 1 / 20

function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null
  const overlay = document.getElementById('overlay')
  if (!canvas || !overlay) throw new Error('Missing #scene canvas or #overlay root')

  /* ---- Boot splash ------------------------------------------------------- */

  const splash = document.createElement('div')
  splash.id = 'boot'
  splash.innerHTML = `
    <div class="stack">
      <h1 class="title glow-cyan">NEON ORBIT</h1>
      <div class="bar"><i></i></div>
      <div class="hint">Building the arena</div>
    </div>`
  overlay.append(splash)

  /* ---- Core systems ----------------------------------------------------- */

  const stage = createStage(canvas)
  const environment = buildEnvironment()
  stage.scene.add(environment.group)

  const input = createInput(canvas)
  const audio = createAudio()
  const hud = createHud(overlay)

  let screen: Screen = 'hangar'
  let pendingResult: RunResult | null = null

  /* ---- Screens ---------------------------------------------------------- */

  const hangar = createHangar({
    parent: overlay,
    scene: stage.scene,
    camera: stage.camera,
    audio,
    onLaunch: (id) => startRun(id),
  })

  const pause = createPausePanel({
    parent: overlay,
    onResume: () => resumeRun(),
    onAbort: () => {
      game.abandon()
      openHangar()
    },
    onToggleInvert: () => {
      input.invertPitch = !input.invertPitch
      return input.invertPitch
    },
    onToggleMute: () => audio.toggleMute(),
  })

  const debrief = createDebriefPanel({
    parent: overlay,
    onReplay: () => {
      const id = pendingResult?.ship ?? hangar.selected
      debrief.hide()
      startRun(id)
    },
    onHangar: () => {
      debrief.hide()
      openHangar()
    },
  })

  const game = createGame({
    scene: stage.scene,
    camera: stage.camera,
    environment,
    input,
    audio,
    hud,
    bestScoreFor: (id) => bestFor(id)?.score ?? 0,
    onEnd: (result) => finishRun(result),
  })

  /* ---- Transitions ------------------------------------------------------ */

  function openHangar() {
    screen = 'hangar'
    pause.hide()
    debrief.hide()
    hud.hide()
    hud.setLockPrompt(false)
    input.releasePointerLock()
    audio.setEngine(0)
    hangar.open(pendingResult?.ship ?? lastShip() ?? 'hornet')
  }

  function startRun(id: ShipId) {
    hangar.close()
    pause.hide()
    debrief.hide()
    rememberShip(id)
    screen = 'flight'
    game.start(id)
    input.requestPointerLock()
  }

  function pauseRun() {
    if (screen !== 'flight') return
    screen = 'paused'
    game.pause()
    pause.show(input.invertPitch, audio.muted)
  }

  function resumeRun() {
    if (screen !== 'paused') return
    pause.hide()
    screen = 'flight'
    game.resume()
    input.requestPointerLock()
  }

  function finishRun(result: RunResult) {
    pendingResult = result
    const previous = bestFor(result.ship)?.score ?? 0
    const isRecord = recordRun(result)
    screen = 'debrief'
    hud.setLockPrompt(false)
    debrief.show(result, isRecord, Math.max(previous, result.score))
  }

  /* ---- Global keys and pointer lock ------------------------------------- */

  input.onKey('Escape', () => {
    if (screen === 'flight') pauseRun()
    else if (screen === 'paused') resumeRun()
  })
  input.onKey('KeyP', () => {
    if (screen === 'flight') pauseRun()
    else if (screen === 'paused') resumeRun()
  })
  input.onKey('KeyM', () => audio.toggleMute())
  input.onKey('Tab', () => {
    if (screen === 'flight') game.cycleTarget()
  })
  input.onKey('KeyT', () => {
    if (screen === 'flight') game.cycleTarget()
  })
  input.onKey('KeyI', () => {
    input.invertPitch = !input.invertPitch
  })

  // Losing pointer lock mid-fight (usually Escape) should pause, not silently
  // strand the player with a dead mouse.
  input.onPointerLockLost(() => {
    if (screen === 'flight') pauseRun()
  })

  canvas.addEventListener('click', () => {
    audio.resume()
    if (screen === 'flight' && !input.pointerLocked) input.requestPointerLock()
  })

  /* ---- Dev console hook -------------------------------------------------- */

  if (import.meta.env.DEV) {
    Object.defineProperty(window, '__neon', {
      value: {
        get screen() {
          return screen
        },
        get run() {
          return game.snapshot()
        },
        get input() {
          return { ...input.state, pointerLocked: input.pointerLocked }
        },
        start: startRun,
      },
      configurable: true,
    })
  }

  /* ---- Loop ------------------------------------------------------------- */

  const clock = new THREE.Clock()
  let splashCleared = false

  function frame() {
    const dt = Math.min(clock.getDelta(), MAX_STEP)

    if (screen === 'hangar') {
      environment.update(dt)
      hangar.update(dt)
    } else {
      input.update(dt)
      game.update(dt)
    }

    stage.render()

    // Only drop the splash once a real frame is on screen, so the reveal never
    // shows a black canvas mid-shader-compile.
    if (!splashCleared) {
      splashCleared = true
      splash.classList.add('done')
      window.setTimeout(() => splash.remove(), 600)
      openHangar()
    }

    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)

  window.addEventListener('beforeunload', () => {
    game.dispose()
    hangar.dispose()
    pause.dispose()
    debrief.dispose()
    hud.dispose()
    input.dispose()
    audio.dispose()
    environment.dispose()
    stage.dispose()
  })
}

try {
  boot()
} catch (error) {
  console.error(error)
  const overlay = document.getElementById('overlay')
  if (overlay) {
    overlay.innerHTML = `
      <div id="boot"><div class="stack">
        <h1 class="title glow-magenta">WEBGL UNAVAILABLE</h1>
        <div class="hint">${error instanceof Error ? error.message : 'Unknown error'}</div>
      </div></div>`
  }
}
