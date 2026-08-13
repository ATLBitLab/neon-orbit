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
import { createStepClock } from './core/loop'
import { bestFor, lastShip, recordRun, rememberShip, type RunResult } from './core/scores'
import { createStage } from './core/stage'
import { createPilot } from './game/controls'
import { createGame, STEP } from './game/game'
import { createHud } from './game/hud'
import type { Controls } from './game/ship'
import type { ShipId } from './ships/specs'
import { createHangar } from './ui/hangar'
import { createDebriefPanel, createPausePanel } from './ui/panels'
import { createScreens } from './ui/screens'
import { buildEnvironment } from './world/environment'

/**
 * Longest frame the simulation will accept, so a tab-switch cannot teleport
 * ships through each other.
 *
 * With a fixed step this also bounds catch-up work: at most `MAX_FRAME / STEP`
 * ticks run for any one frame. Without the clamp, a frame that arrives late
 * enough queues more simulation than the next frame has time to run, which
 * makes the next frame later still — the loop never catches up and the game
 * grinds to a halt instead of simply dropping the lost time.
 */
const MAX_FRAME = 1 / 5

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
  const pilot = createPilot()
  const audio = createAudio()
  const hud = createHud(overlay)

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
    onResume: () => screens.exitPause(),
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
    screens.moveTo('hangar')
    pause.hide()
    debrief.hide()
    hud.hide()
    hud.setLockPrompt(false)
    input.releasePointerLock()
    audio.setMusic('hangar')
    hangar.open(pendingResult?.ship ?? lastShip() ?? 'hornet')
  }

  function startRun(id: ShipId) {
    hangar.close()
    pause.hide()
    debrief.hide()
    rememberShip(id)
    screens.moveTo('flight')
    audio.setMusic('combat')
    // Back to launch throttle. The pilot outlives any one run, so a fresh
    // launch has to say so rather than inheriting the last run's last command.
    pilot.reset()
    // One seat, and elimination rather than respawn — the shipped game is a match
    // of one, and its lose condition is the run ending. `MatchSetup.respawn` in
    // `game/game.ts` says why that is a policy rather than the roster size.
    game.start({ ships: [id] })
    input.requestPointerLock()
  }

  /*
   * `src/ui/screens.ts` owns the screen and every transition's precondition. There is no
   * state to hand it and no answer to assign back — the fourth attempt at removing the
   * part of this decision that no test could reach, and the first with nothing left for
   * a caller to finish. What remains here is five one-line adapters and no branches.
   */
  const screens = createScreens({
    pause: () => game.pause(),
    resume: () => game.resume(),
    showPanel: () => pause.show(input.invertPitch, audio.muted),
    hidePanel: () => pause.hide(),
    grabPointer: () => input.requestPointerLock(),
  })

  function finishRun(result: RunResult) {
    pendingResult = result
    const previous = bestFor(result.ship)?.score ?? 0
    const isRecord = recordRun(result)
    screens.moveTo('debrief')
    hud.setLockPrompt(false)
    // These are full-length tracks rather than stings, so they loop like any
    // other screen music. Nobody reads a debrief for a minute and a quarter.
    audio.setMusic(result.won ? 'victory' : 'defeat')
    debrief.show(result, isRecord, Math.max(previous, result.score))
  }

  /* ---- Global keys and pointer lock ------------------------------------- */

  // Straight to the flow: it knows which screen it is allowed to act from, so there is
  // no screen test to duplicate here and get out of step with it.
  input.onKey('Escape', () => screens.togglePause())
  input.onKey('KeyP', () => screens.togglePause())
  input.onKey('KeyM', () => audio.toggleMute())
  input.onKey('Tab', () => {
    if (screens.screen === 'flight') game.cycleTarget()
  })
  input.onKey('KeyT', () => {
    if (screens.screen === 'flight') game.cycleTarget()
  })
  input.onKey('KeyI', () => {
    input.invertPitch = !input.invertPitch
  })

  // Losing pointer lock mid-fight (usually Escape) should pause, not silently
  // strand the player with a dead mouse.
  input.onPointerLockLost(() => screens.enterPause())

  canvas.addEventListener('click', () => {
    audio.resume()
    if (screens.screen === 'flight' && !input.pointerLocked) input.requestPointerLock()
  })

  /* ---- Dev console hook -------------------------------------------------- */

  if (import.meta.env.DEV) {
    Object.defineProperty(window, '__neon', {
      value: {
        get screen() {
          // `screens.screen`, not a bare `screen`: the refactor that moved this state
          // out left `return screen` compiling against the DOM global, so the dev hook
          // started reporting the browser's `Screen` object instead of 'hangar' |
          // 'flight' | 'paused' | 'debrief' as the README promises.
          return screens.screen
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
  const stepClock = createStepClock(STEP, MAX_FRAME)
  let splashCleared = false

  /**
   * The intent handed to the simulation each tick, one slot per seat.
   *
   * Reused rather than rebuilt, because this runs sixty times a second and the
   * simulation copies what it is handed rather than retaining it. One slot today:
   * this machine drives one seat, and the remaining slots are what a host fills
   * from arriving packets and a client leaves to the host.
   */
  const intents: Controls[] = [pilot.advance(input.state, STEP)]

  function frame() {
    const { ticks, frameSeconds, alpha } = stepClock.advance(clock.getDelta())

    if (screens.screen === 'hangar') {
      // The hangar has no simulation to keep honest — it is a turntable and a
      // set of cards — so it runs straight off the frame.
      environment.update(frameSeconds, stage.camera)
      hangar.update(frameSeconds)
    } else {
      for (let i = 0; i < ticks; i++) {
        // Sampled per tick, not per frame: the virtual stick self-centres over
        // time, so decaying it once per frame would make it recentre faster on
        // a faster display.
        input.update(STEP)
        // Reading the device and running the simulation are two steps now, and
        // this is the seam multiplayer opens: a host would send these controls
        // as well as flying on them, and a client would fly on controls that
        // arrived rather than ones it produced. The simulation is handed one
        // intent per seat and never asks which of those a device produced.
        intents[0] = pilot.advance(input.state, STEP)
        game.step(intents)
      }
      game.render(alpha, frameSeconds)
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
