/**
 * Keyboard and mouse, normalised into a flight stick.
 *
 * The mouse is a **virtual stick**, not an FPS look control: movement pushes a
 * deflection value that self-centres, and the ship's own `turnRate` scales it.
 * That keeps turn rate a balance lever — a Drone cannot out-turn a Wasp just
 * because its pilot owns a faster mouse — which a direct delta-to-rotation
 * mapping would quietly throw away.
 *
 * Arrow keys drive the same stick at full deflection, so the game is fully
 * playable without a mouse (and without pointer lock).
 */

/** Pixels of mouse travel for full stick deflection. */
const MOUSE_SENSITIVITY = 1 / 300
/** How fast the stick returns to centre when the mouse stops, per second. */
const STICK_RECENTRE = 1.6

export interface InputState {
  /** -1 nose down, +1 nose up. */
  pitch: number
  /** -1 nose left, +1 nose right. */
  yaw: number
  /** -1 roll left, +1 roll right. */
  roll: number
  throttleUp: boolean
  throttleDown: boolean
  fire: boolean
  dash: boolean
}

export interface Input {
  readonly state: InputState
  readonly pointerLocked: boolean
  invertPitch: boolean
  /** Advance stick decay. Call once per frame before reading `state`. */
  update(dt: number): void
  requestPointerLock(): void
  releasePointerLock(): void
  /** Fires when the browser drops pointer lock — typically the Escape key. */
  onPointerLockLost(fn: () => void): void
  onKey(code: string, fn: () => void): void
  /** Drop held keys so a paused ship does not resume mid-manoeuvre. */
  reset(): void
  dispose(): void
}

export function createInput(canvas: HTMLCanvasElement): Input {
  const held = new Set<string>()
  const keyHandlers = new Map<string, (() => void)[]>()
  const lockLostHandlers: (() => void)[] = []

  let stickX = 0 // yaw deflection
  let stickY = 0 // pitch deflection
  let mouseFiring = false
  let locked = false
  let invertPitch = false

  const state: InputState = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttleUp: false,
    throttleDown: false,
    fire: false,
    dash: false,
  }

  /* ---- Keyboard --------------------------------------------------------- */

  function onKeyDown(e: KeyboardEvent) {
    // Let the browser keep its own shortcuts.
    if (e.metaKey || e.ctrlKey || e.altKey) return

    if (!e.repeat) {
      const handlers = keyHandlers.get(e.code)
      if (handlers) for (const h of handlers) h()
    }

    if (TRACKED.has(e.code)) {
      held.add(e.code)
      e.preventDefault()
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    held.delete(e.code)
  }

  /* ---- Mouse ------------------------------------------------------------ */

  function onMouseMove(e: MouseEvent) {
    if (!locked) return
    stickX = clamp(stickX + e.movementX * MOUSE_SENSITIVITY, -1, 1)
    stickY = clamp(stickY + e.movementY * MOUSE_SENSITIVITY, -1, 1)
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button === 0) mouseFiring = true
  }

  function onMouseUp(e: MouseEvent) {
    if (e.button === 0) mouseFiring = false
  }

  function onPointerLockChange() {
    const nowLocked = document.pointerLockElement === canvas
    if (locked && !nowLocked) {
      locked = false
      mouseFiring = false
      stickX = 0
      stickY = 0
      for (const h of lockLostHandlers) h()
    } else {
      locked = nowLocked
    }
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('blur', () => held.clear())
  document.addEventListener('pointerlockchange', onPointerLockChange)

  /* ---- Frame update ----------------------------------------------------- */

  function update(dt: number) {
    // Keys deflect fully and instantly; the mouse stick decays back to centre.
    const keyPitch = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0)
    const keyYaw =
      (held.has('ArrowRight') || held.has('KeyD') ? 1 : 0) -
      (held.has('ArrowLeft') || held.has('KeyA') ? 1 : 0)

    const decay = Math.exp(-STICK_RECENTRE * dt)
    stickX *= decay
    stickY *= decay

    const mousePitch = -stickY // screen-down should pitch the nose down
    state.pitch = clamp(keyPitch + (invertPitch ? -mousePitch : mousePitch), -1, 1)
    state.yaw = clamp(keyYaw + stickX, -1, 1)
    state.roll = (held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0)

    state.throttleUp = held.has('KeyW')
    state.throttleDown = held.has('KeyS')
    state.fire = mouseFiring || held.has('Space')
    state.dash = held.has('ShiftLeft') || held.has('ShiftRight')
  }

  return {
    state,
    get pointerLocked() {
      return locked
    },
    get invertPitch() {
      return invertPitch
    },
    set invertPitch(v: boolean) {
      invertPitch = v
    },
    update,
    requestPointerLock() {
      // Chrome rejects the promise if lock is requested too soon after an exit.
      void canvas.requestPointerLock()
    },
    releasePointerLock() {
      if (document.pointerLockElement === canvas) document.exitPointerLock()
    },
    onPointerLockLost(fn) {
      lockLostHandlers.push(fn)
    },
    onKey(code, fn) {
      const list = keyHandlers.get(code)
      if (list) list.push(fn)
      else keyHandlers.set(code, [fn])
    },
    reset() {
      held.clear()
      mouseFiring = false
      stickX = 0
      stickY = 0
      update(0)
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
    },
  }
}

/** Keys the game consumes, so everything else stays available to the browser. */
const TRACKED = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  // Tab cycles targets, so it must not move focus off the canvas mid-fight.
  'Tab',
])

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
