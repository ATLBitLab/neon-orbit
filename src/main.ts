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
import { createDevHook, installDevHook } from './core/dev-hook'
import { createInput } from './core/input'
import { createStepClock } from './core/loop'
import { bestFor, lastShip, recordRun, rememberShip, type RunResult } from './core/scores'
import { createStage } from './core/stage'
import { createPilot } from './game/controls'
import { createGame, STEP } from './game/game'
import { createHud } from './game/hud'
import type { Controls } from './game/ship'
import type { ShipId } from './ships/specs'
import { joinMatch, modeFromLocation, openLobby, startHosting, type Hosting, type Joining, type Lobby } from './net/browser'
import { LINK_GRACE_MS } from './net/link'
import { createHangar } from './ui/hangar'
import { createWing } from './ui/wing'
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

  const input = createInput(canvas, () => screens.screen === 'flight')
  const pilot = createPilot()
  const audio = createAudio()
  const hud = createHud(overlay)

  let pendingResult: RunResult | null = null

  // `?host` or `?join=CODE` on the URL. Solo is the shipped game and takes none
  // of the branches below; see `net/browser.ts`. `mode` is reassigned to solo
  // when a join fails and the player chooses to fly alone, which is what makes
  // the frame loop step the simulation again.
  let mode = modeFromLocation(window.location.search)
  let hosting: Hosting | null = null
  let joining: Joining | null = null
  let lobby: Lobby | null = null
  let joinAttempt = 0

  /** The one line of network status on screen, in either mode. */
  const netPanel = document.createElement('div')
  netPanel.id = 'net'
  netPanel.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:50;display:none;' +
    'font:13px/1.5 monospace;color:#6be6ff;background:rgba(0,0,0,.6);padding:8px 12px;' +
    'border:1px solid #6be6ff66;max-width:90vw;text-align:center;pointer-events:auto'
  overlay.append(netPanel)

  function netStatus(html: string) {
    netPanel.style.display = 'block'
    netPanel.innerHTML = html
  }

  /* ---- Screens ---------------------------------------------------------- */

  const hangar = createHangar({
    parent: overlay,
    scene: stage.scene,
    camera: stage.camera,
    audio,
    onLaunch: (id) => startRun(id),
    onSelect: (id) => lobby?.wing.setShip(id),
  })

  const wing = createWing(hangar.root.querySelector('.stage')!, () => {
    joinAttempt++
    joining?.stop()
    joining = null
    mode = { kind: 'solo' }
    netPanel.style.display = 'none'
    openHangar()
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

  function prepareLobby() {
    if (mode.kind !== 'host') return
    hosting?.stop()
    hosting = null
    lobby?.close()
    lobby = openLobby(game, [hangar.selected, ...Array<ShipId>(mode.seats - 1).fill(mode.guest)],
      (state) => wing.update(state),
      (seat) => hud.callout(`PLAYER ${seat + 1} JOINED`, '#6be6ff', 1.5),
      (stage) => console.log('[neon-orbit] lobby:', stage))
    wing.show(lobby.code, true)
    wing.update(lobby.wing.state())
    console.log('[neon-orbit] join code', lobby.code)
  }

  function openHangar() {
    joinAttempt++
    joining?.stop()
    joining = null
    hosting?.stop()
    hosting = null
    lobby?.close()
    lobby = null
    game.abandon()
    netPanel.style.display = 'none'
    hangar.action(mode.kind === 'join' ? 'JOIN WING' : null)
    wing.hide()
    screens.moveTo('hangar')
    pause.hide()
    debrief.hide()
    hud.hide()
    hud.setLockPrompt(false)
    input.releasePointerLock()
    audio.setMusic('hangar')
    hangar.open(pendingResult?.ship ?? lastShip() ?? 'hornet')
    if (mode.kind === 'host') prepareLobby()
    if (mode.kind === 'join') wing.show(mode.code, false)
  }

  function startRun(id: ShipId) {
    if (mode.kind === 'join') { startJoining(mode.code); return }
    if (mode.kind === 'host' && hosting) prepareLobby()
    lobby?.wing.setShip(id)
    wing.hide()
    hangar.close()
    pause.hide()
    debrief.hide()
    rememberShip(id)
    screens.moveTo('flight')
    audio.setMusic('combat')
    // Back to launch throttle. The pilot outlives any one run, so a fresh
    // launch has to say so rather than inheriting the last run's last command.
    pilot.reset()
    if (mode.kind === 'host' && lobby) {
      hosting?.stop()
      hosting = startHosting(lobby)
      const url = `${location.origin}${location.pathname}?join=${lobby.code}`
      netStatus(`JOIN CODE <b>${lobby.code}</b> · <a href="${url}" target="_blank" rel="noopener" style="color:inherit">JOIN LINK</a>`)
    } else {
      // One seat, and elimination rather than respawn — the shipped game is a match
      // of one, and its lose condition is the run ending. `MatchSetup.respawn` in
      // `game/game.ts` says why that is a policy rather than the roster size.
      game.start({ ships: [id] })
    }
    input.requestPointerLock()
  }

  /**
   * The join is over and did not end in a seat — or the seat is gone. Say why,
   * and offer the two ways out. Whatever was flying stays on screen behind the
   * panel; RETRY starts a fresh join on the same code, and the welcome restarts
   * the match.
   */
  function offerRetry(code: string, heading: string, reason: string, note = '') {
    joinAttempt++
    joining?.stop()
    joining = null
    wing.status(reason)
    // Pointer lock would swallow the click on the button.
    document.exitPointerLock?.()
    netStatus(
      `${heading} <b>${code}</b><div style="color:#ff3b4e">${reason}</div>` +
        (note ? `<div style="opacity:.7">${note}</div>` : '') +
        `<button id="retryjoin" style="font:inherit;margin:6px 4px 0;cursor:pointer">RETRY</button>` +
        `<button id="solojoin" style="font:inherit;margin:6px 4px 0;cursor:pointer">PLAY SOLO</button>`,
    )
    document.getElementById('retryjoin')?.addEventListener('click', () => startJoining(code))
    document.getElementById('solojoin')?.addEventListener('click', () => {
      mode = { kind: 'solo' }
      netPanel.style.display = 'none'
      openHangar()
    })
  }

  function startJoining(code: string) {
    const attempt = ++joinAttempt
    joining?.stop()
    joining = null
    const current = () => attempt === joinAttempt
    const ship = hangar.selected
    rememberShip(ship)
    game.abandon()
    screens.moveTo('hangar')
    hud.hide()
    input.releasePointerLock()
    hangar.action('JOIN WING')
    hangar.open(ship)
    hangar.action('CONNECTING…', true)
    pause.hide()
    debrief.hide()
    pilot.reset()
    audio.setMusic('hangar')
    const waiting = 'connected — waiting for the host to launch'
    netPanel.style.display = 'none'
    wing.show(code, false)
    wing.status('Looking for the host…')
    joinMatch(game, code, ship, {
      active: current,
      status: (stage) => { if (current()) wing.status(stage) },
      onLobby: (state) => {
        if (!current()) return
        wing.update(state)
        hangar.action('WAITING FOR HOST', true)
      },
      onWelcome: (seat) => {
        if (!current()) return
        wing.hide()
        hangar.close()
        audio.setMusic('combat')
        netPanel.style.display = 'none'
        screens.moveTo('flight')
        hud.callout(`SEAT ${seat + 1}`, '#6be6ff', 1.5)
        input.requestPointerLock()
      },
      onRefused: (reason) => {
        if (!current()) return
        offerRetry(code, 'COULD NOT JOIN',
          reason === 'version' ? 'game versions differ — reload both pages' : 'the host has no seat free',
          reason === 'full' ? 'A disconnected seat frees when the host notices the drop.' : '')
      },
      onLink: (link) => {
        if (!current()) return
        const route = link.route ? `<div style="opacity:.7">route ${link.route}</div>` : ''
        if (link.state === 'degraded') {
          netStatus(
            `LINK LOST <b>${code}</b><div style="color:#ffb547">${link.reason} — waiting up to ${LINK_GRACE_MS / 1000} s for it to recover</div>${route}`,
          )
        } else if (link.state === 'up') {
          if ((joining?.client.seat ?? -1) >= 0) netPanel.style.display = 'none'
          else netStatus(`JOINING <b>${code}</b><div>${waiting}</div>`)
        } else {
          offerRetry(code, 'CONNECTION LOST', link.reason, link.route ? `route was ${link.route}` : '')
        }
      },
    })
      .then((j) => {
        if (current()) joining = j
        else j.stop()
      })
      .catch((error) => {
        if (!current()) return
        console.error(error)
        offerRetry(code, 'COULD NOT JOIN', error instanceof Error ? error.message : String(error))
      })
  }

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

  // Built and installed by `src/core/dev-hook.ts`, which a headless run can execute.
  // The version that lived here read a bare `screen` after the screen state moved out,
  // which compiles against the DOM global — so the hook reported the browser's `Screen`
  // object rather than any of the four values the README documents.
  if (import.meta.env.DEV) {
    installDevHook(window, createDevHook({ screens, game, input, start: startRun }))
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
      // Waiting peers still repeat HELLO to recover lost roster / launch frames.
      for (let i = 0; i < ticks; i++) joining?.tick(intents[0])
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
        if (hosting) hosting.tick(intents[0])
        else if (joining) joining.tick(intents[0])
        else if (mode.kind !== 'join') game.step(intents)
        // In join mode with no session yet, nothing steps: the host's snapshots
        // will drive the game once the welcome arrives.
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
    hosting?.stop()
    joining?.stop()
    lobby?.close()
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
