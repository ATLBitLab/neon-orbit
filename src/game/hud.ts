/**
 * In-flight HUD.
 *
 * Plain DOM over the canvas rather than sprites in the scene: crisp text at any
 * resolution, no font atlas, and the bloom pass cannot smear the numbers.
 *
 * The contact markers matter more than they look. A 3D arena with no horizon
 * gives you nothing to orient against, so without an off-screen indicator per
 * enemy the honest experience of the game is spinning in the void wondering who
 * is shooting you.
 */

import * as THREE from 'three'
import type { ShipSpec } from '../ships/specs'

const MAX_CONTACTS = 8
/** Fraction of the half-viewport where edge arrows sit. */
const EDGE_INSET = 0.92

export interface HudContact {
  position: THREE.Vector3
  hullFraction: number
  accent: number
}

export interface HudFrame {
  hullFraction: number
  quirkValue: number
  quirkAlarming: boolean
  score: number
  multiplier: number
  best: number
  enemiesTotal: number
  enemiesRemaining: number
  speed: number
  throttle: number
  /** A target is inside the firing cone. */
  locked: boolean
  /** True when the hull is low enough to warrant the red vignette. */
  critical: boolean
  /** Screen pixels where the gun line crosses the far aim plane. */
  reticleX: number
  reticleY: number
  /** Units past the patrol line, or 0 while inside it. */
  boundaryOvershoot: number
}

export interface Hud {
  root: HTMLElement
  show(): void
  hide(): void
  setShip(spec: ShipSpec): void
  update(frame: HudFrame): void
  updateContacts(contacts: HudContact[], camera: THREE.Camera): void
  /** Red edge flash when the player is hit. */
  flashDamage(): void
  callout(text: string, color: string, holdSeconds?: number): void
  feed(text: string): void
  setLockPrompt(visible: boolean): void
  tick(dt: number): void
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

const RETICLE_SVG = `
<svg viewBox="0 0 90 90" fill="none" stroke="currentColor" stroke-width="1.6">
  <circle cx="45" cy="45" r="2.4" fill="currentColor" stroke="none" opacity="0.9"/>
  <path d="M45 16 v9 M45 65 v9 M16 45 h9 M65 45 h9" opacity="0.85"/>
  <path d="M20 30 v-10 h10 M70 30 v-10 h-10 M20 60 v10 h10 M70 60 v10 h-10" opacity="0.55"/>
</svg>`

const CONTACT_SVG = `
<svg viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M13 3 L21 17 L13 13 L5 17 Z" fill="currentColor" opacity="0.9" stroke="none"/>
</svg>`

const BRACKET_SVG = `
<svg viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.8">
  <path d="M4 9 V4 H9 M17 4 H22 V9 M22 17 V22 H17 M9 22 H4 V17" opacity="0.95"/>
</svg>`

export function createHud(parent: HTMLElement): Hud {
  const root = el('div')
  root.id = 'hud'

  /* ---- Corners ---------------------------------------------------------- */

  const tl = el('div', 'hud-corner hud-tl')
  const shipName = el('div', 'hud-ship', 'ARMED')
  const hullGauge = el('div', 'gauge hull')
  const hullFill = el('i')
  hullGauge.append(hullFill)
  const hullReadout = el('div', 'readout-row')
  const quirkLabel = el('div', 'hud-label', 'SYSTEM')
  const quirkGauge = el('div', 'gauge quirk')
  const quirkFill = el('i')
  quirkGauge.append(quirkFill)
  tl.append(
    el('div', 'hud-label', 'AIRFRAME'),
    shipName,
    el('div', 'hud-label', 'HULL INTEGRITY'),
    hullGauge,
    hullReadout,
    quirkLabel,
    quirkGauge,
  )

  const tr = el('div', 'hud-corner hud-tr')
  const scoreValue = el('div', 'hud-score', '0')
  const multValue = el('div', 'hud-mult', '×1.00')
  const bestValue = el('div', 'hud-label', 'BEST 0')
  const pips = el('div', 'pips')
  tr.append(el('div', 'hud-label', 'SCORE'), scoreValue, multValue, bestValue, pips)

  const bl = el('div', 'hud-corner hud-bl')
  const speedValue = el('div', 'hud-ship', '0')
  const throttleLadder = el('div', 'throttle')
  const throttleBars: HTMLElement[] = []
  for (let i = 0; i < 12; i++) {
    const bar = el('i')
    bar.style.height = `${28 + i * 6}%`
    throttleBars.push(bar)
    throttleLadder.append(bar)
  }
  bl.append(el('div', 'hud-label', 'VELOCITY  U/S'), speedValue, el('div', 'hud-label', 'THROTTLE'), throttleLadder)

  const br = el('div', 'hud-corner hud-br')
  const contactCount = el('div', 'hud-ship', '0')
  br.append(el('div', 'hud-label', 'HOSTILES'), contactCount, el('div', 'hint', 'ESC PAUSE · M MUTE'))

  /* ---- Overlays --------------------------------------------------------- */

  const reticle = el('div', undefined, RETICLE_SVG)
  reticle.id = 'reticle'

  const flash = el('div')
  flash.id = 'flash'

  const warn = el('div')
  warn.id = 'warn'

  const callout = el('div')
  callout.id = 'callout'

  const killfeed = el('div')
  killfeed.id = 'killfeed'

  const lockPrompt = el('div', undefined, 'CLICK TO CAPTURE MOUSE &nbsp;·&nbsp; OR STEER WITH ↑ ↓ A D')
  lockPrompt.id = 'lockprompt'
  lockPrompt.hidden = true

  const bounds = el('div')
  bounds.id = 'bounds'
  bounds.hidden = true

  const contacts: { node: HTMLElement; arrow: HTMLElement; bracket: HTMLElement }[] = []
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const node = el('div', 'contact')
    const arrow = el('div', undefined, CONTACT_SVG)
    const bracket = el('div', undefined, BRACKET_SVG)
    arrow.style.width = bracket.style.width = '100%'
    arrow.style.height = bracket.style.height = '100%'
    bracket.style.display = 'none'
    node.style.display = 'none'
    node.append(arrow, bracket)
    contacts.push({ node, arrow, bracket })
    root.append(node)
  }

  root.append(warn, flash, tl, tr, bl, br, reticle, callout, bounds, killfeed, lockPrompt)
  parent.append(root)

  /* ---- State ------------------------------------------------------------ */

  let calloutTimer = 0
  let flashTimer = 0
  const feedNodes: { node: HTMLElement; life: number }[] = []

  // Scratch for the per-frame projection of every contact.
  const ndc = new THREE.Vector3()
  const view = new THREE.Vector3()

  let lastPipCount = -1

  return {
    root,

    show() {
      root.classList.add('live')
    },

    hide() {
      root.classList.remove('live')
    },

    setShip(spec) {
      shipName.textContent = spec.name.toUpperCase()
      shipName.style.color = `#${spec.accent.toString(16).padStart(6, '0')}`
      quirkLabel.textContent =
        spec.quirk.kind === 'heat'
          ? 'GUN HEAT'
          : spec.quirk.kind === 'regen'
            ? 'NANITE REPAIR'
            : 'PHASE DASH'
      lastPipCount = -1
    },

    update(frame) {
      const hullPct = Math.round(frame.hullFraction * 100)
      hullFill.style.width = `${frame.hullFraction * 100}%`
      hullGauge.classList.toggle('warn', frame.hullFraction <= 0.5 && frame.hullFraction > 0.25)
      hullGauge.classList.toggle('crit', frame.hullFraction <= 0.25)
      hullReadout.textContent = `${hullPct}%`

      quirkFill.style.width = `${frame.quirkValue * 100}%`
      quirkGauge.classList.toggle('hot', frame.quirkAlarming)

      scoreValue.textContent = frame.score.toLocaleString()
      multValue.textContent = `×${frame.multiplier.toFixed(2)}`
      bestValue.textContent = `BEST ${frame.best.toLocaleString()}`

      // Pips only get rebuilt when the count changes; this runs every frame.
      if (frame.enemiesTotal !== lastPipCount) {
        pips.textContent = ''
        for (let i = 0; i < frame.enemiesTotal; i++) pips.append(el('i'))
        lastPipCount = frame.enemiesTotal
      }
      const alive = frame.enemiesRemaining
      Array.from(pips.children).forEach((pip, i) => {
        pip.classList.toggle('dead', i >= alive)
      })

      speedValue.textContent = Math.round(frame.speed).toString()
      const lit = Math.round(frame.throttle * throttleBars.length)
      throttleBars.forEach((bar, i) => bar.classList.toggle('on', i < lit))

      contactCount.textContent = frame.enemiesRemaining.toString()
      reticle.classList.toggle('locked', frame.locked)
      reticle.style.transform = `translate(${frame.reticleX.toFixed(1)}px, ${frame.reticleY.toFixed(1)}px) scale(${frame.locked ? 1.12 : 1})`
      warn.classList.toggle('on', frame.critical)

      const straying = frame.boundaryOvershoot > 0
      bounds.hidden = !straying
      if (straying) {
        bounds.textContent = `▲ Leaving patrol zone — turn back · ${Math.round(frame.boundaryOvershoot)} u`
      }
    },

    updateContacts(list, camera) {
      const halfW = window.innerWidth / 2
      const halfH = window.innerHeight / 2

      for (let i = 0; i < MAX_CONTACTS; i++) {
        const slot = contacts[i]
        const contact = list[i]
        if (!contact) {
          slot.node.style.display = 'none'
          continue
        }

        // View space first: -Z is in front, so a positive z means behind us and
        // the projection would fold the marker to the wrong side of the screen.
        view.copy(contact.position).applyMatrix4(camera.matrixWorldInverse)
        const behind = view.z > 0

        ndc.copy(contact.position).project(camera)
        let x = ndc.x
        let y = ndc.y
        if (behind) {
          x = -x
          y = -y
        }

        const offscreen = behind || Math.abs(x) > 0.94 || Math.abs(y) > 0.94
        slot.node.style.display = 'block'
        slot.node.style.color = `#${contact.accent.toString(16).padStart(6, '0')}`
        // Weakened targets read brighter, so you can pick the finishable one.
        slot.node.style.opacity = (0.68 + (1 - contact.hullFraction) * 0.32).toFixed(2)

        if (offscreen) {
          const len = Math.hypot(x, y) || 1
          const px = halfW + (x / len) * halfW * EDGE_INSET
          const py = halfH - (y / len) * halfH * EDGE_INSET
          // The arrow art points up, so rotate from +Y to the contact bearing.
          const angle = Math.atan2(x / len, y / len) * (180 / Math.PI)
          slot.node.style.transform = `translate(${px}px, ${py}px) rotate(${angle}deg)`
          slot.arrow.style.display = 'block'
          slot.bracket.style.display = 'none'
        } else {
          const px = halfW + x * halfW
          const py = halfH - y * halfH
          // Brackets tighten as the contact gets closer, so range reads at a glance.
          const scale = 0.7 + (1 - Math.min(1, -view.z / 900)) * 0.8
          slot.node.style.transform = `translate(${px}px, ${py}px) scale(${scale})`
          slot.arrow.style.display = 'none'
          slot.bracket.style.display = 'block'
        }
      }
    },

    flashDamage() {
      flash.style.opacity = '0.85'
      flashTimer = 0.22
    },

    callout(text, color, holdSeconds = 1.5) {
      callout.textContent = text
      callout.style.color = color
      callout.style.textShadow = `0 0 18px ${color}`
      callout.classList.remove('show')
      // Force a reflow so the entry animation replays on a repeat callout.
      void callout.offsetWidth
      callout.classList.add('show')
      calloutTimer = holdSeconds
    },

    feed(text) {
      const node = el('div', undefined, text)
      killfeed.prepend(node)
      feedNodes.push({ node, life: 3.2 })
      while (feedNodes.length > 5) {
        const oldest = feedNodes.shift()
        oldest?.node.remove()
      }
    },

    setLockPrompt(visible) {
      lockPrompt.hidden = !visible
    },

    tick(dt) {
      if (flashTimer > 0) {
        flashTimer -= dt
        if (flashTimer <= 0) flash.style.opacity = '0'
      }
      if (calloutTimer > 0) {
        calloutTimer -= dt
        if (calloutTimer <= 0) callout.classList.remove('show')
      }
      for (let i = feedNodes.length - 1; i >= 0; i--) {
        feedNodes[i].life -= dt
        if (feedNodes[i].life <= 0) {
          feedNodes[i].node.remove()
          feedNodes.splice(i, 1)
        }
      }
    },

    dispose() {
      root.remove()
    },
  }
}
