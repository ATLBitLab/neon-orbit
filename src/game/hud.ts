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

/** The locked hostile, plus where to aim to actually hit it. */
export interface HudTarget {
  name: string
  accent: number
  hullFraction: number
  range: number
  leadNdcX: number
  leadNdcY: number
  leadVisible: boolean
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
  /**
   * Gun line projected to normalised device coordinates (-1..1). The HUD owns
   * the conversion to pixels, so the game loop never has to know about the
   * viewport — which also keeps it runnable outside a browser.
   */
  reticleNdcX: number
  reticleNdcY: number
  /** Units past the patrol line, or 0 while inside it. */
  boundaryOvershoot: number
  /** How hard the star is cooking the hull, 0..1. */
  solarExposure: number
  /**
   * Timed power-up state, or null when that buff is not up. A fraction *and* a
   * raw second count rather than the seconds plus a duration constant, so the
   * HUD never has to import a balance number to draw a bar — same reason the
   * hull arrives here as `hullFraction` instead of hull and max. Because pods
   * stack, the fraction is already clamped by the caller and the seconds are
   * the honest figure.
   */
  overdrive: HudBuff | null
  shield: HudBuff | null
  target: HudTarget | null
}

export interface HudBuff {
  remaining: number
  fraction: number
  expiring: boolean
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

const LEAD_SVG = `
<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="20" cy="20" r="10" opacity="0.95"/>
  <circle cx="20" cy="20" r="2.2" fill="currentColor" stroke="none"/>
  <path d="M20 4 v5 M20 31 v5 M4 20 h5 M31 20 h5" opacity="0.8"/>
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

  /**
   * A timed power-up's readout. These live in the airframe panel rather than
   * with the warnings, because they are system readouts: they belong next to
   * hull and gun heat, not next to "you are leaving the patrol zone". Each
   * block collapses entirely when its buff is down, so a stock run pays nothing
   * for them.
   *
   * The seconds sit beside the label and are shown the whole time rather than
   * only during the countdown. Pods stack, so the bar saturates at one pod's
   * worth and the number is the only thing that can tell you whether you are
   * holding ten seconds or twenty-five.
   */
  function buffBlock(label: string, cls: string) {
    const block = el('div', 'hud-buff')
    const head = el('div', 'buff-head')
    const secs = el('div', 'hud-label buff-secs')
    head.append(el('div', 'hud-label', label), secs)
    const gauge = el('div', `gauge ${cls}`)
    const fill = el('i')
    gauge.append(fill)
    block.append(head, gauge)
    block.hidden = true
    return { block, gauge, fill, secs }
  }

  const odUi = buffBlock('OVERDRIVE', 'overdrive')
  const shUi = buffBlock('SHIELD', 'shield')

  tl.append(
    el('div', 'hud-label', 'AIRFRAME'),
    shipName,
    el('div', 'hud-label', 'HULL INTEGRITY'),
    hullGauge,
    hullReadout,
    quirkLabel,
    quirkGauge,
    odUi.block,
    shUi.block,
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
  const targetName = el('div', 'target-name', 'NO LOCK')
  const targetRange = el('div', 'hud-label', '—')
  const targetGauge = el('div', 'gauge target')
  const targetFill = el('i')
  targetGauge.append(targetFill)
  br.append(
    el('div', 'hud-label', 'HOSTILES'),
    contactCount,
    el('div', 'hud-label', 'LOCK  ·  TAB TO SWITCH'),
    targetName,
    targetGauge,
    targetRange,
    el('div', 'hint', 'ESC PAUSE · M MUTE'),
  )

  /* ---- Overlays --------------------------------------------------------- */

  const reticle = el('div', undefined, RETICLE_SVG)
  reticle.id = 'reticle'

  // The lead pip is the difference between "shooting at" and "hitting" a target
  // that crosses at 400 units a second. Put the nose on the pip, not the hull.
  const leadPip = el('div', undefined, LEAD_SVG)
  leadPip.id = 'lead'
  leadPip.hidden = true

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

  const sear = el('div')
  sear.id = 'sear'
  sear.hidden = true

  // The last-five-seconds countdowns, centred just under the callout line.
  // Both buffs can be up at once, so they share a grid container and stack
  // without leaving a hole when only one is running. They read as violet and
  // blue against the warnings' amber, which is what keeps "your buff is ending"
  // from being mistaken for "you are being hurt".
  const buffBanners = el('div')
  buffBanners.id = 'buffbanners'
  const odBanner = el('div', 'buff-banner overdrive')
  const shBanner = el('div', 'buff-banner shield')
  odBanner.hidden = true
  shBanner.hidden = true
  buffBanners.append(odBanner, shBanner)

  const searGlare = el('div')
  searGlare.id = 'searglare'

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

  root.append(
    warn,
    searGlare,
    flash,
    tl,
    tr,
    bl,
    br,
    reticle,
    leadPip,
    callout,
    bounds,
    sear,
    buffBanners,
    killfeed,
    lockPrompt,
  )
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
      const rx = (frame.reticleNdcX * 0.5 + 0.5) * window.innerWidth
      const ry = (-frame.reticleNdcY * 0.5 + 0.5) * window.innerHeight
      reticle.style.transform = `translate(${rx.toFixed(1)}px, ${ry.toFixed(1)}px) scale(${frame.locked ? 1.12 : 1})`
      warn.classList.toggle('on', frame.critical)

      const straying = frame.boundaryOvershoot > 0
      bounds.hidden = !straying
      if (straying) {
        bounds.textContent = `▲ Leaving patrol zone — turn back · ${Math.round(frame.boundaryOvershoot)} u`
      }

      // The banner names the danger; the glare is the peripheral cue you can
      // read without looking away from the reticle. Opacity is driven straight
      // off exposure so the screen brightening *is* the warning.
      const burning = frame.solarExposure > 0
      sear.hidden = !burning
      if (burning) {
        sear.textContent = `☀ Solar proximity — hull searing · ${Math.round(frame.solarExposure * 100)}%`
        sear.classList.toggle('critical', frame.solarExposure > 0.6)
      }
      // The star's own corona already fills most of the frame this close, so
      // the overlay only has to push the edges — much past this and the
      // reticle stops being readable exactly when you need to fly out.
      searGlare.style.opacity = (frame.solarExposure * 0.55).toFixed(3)

      // The gauge is up for the whole buff so you always know you have it; the
      // banner only appears for the last stretch, so the countdown itself is
      // the signal that it is running out. One decimal on both: a whole-second
      // counter looks stalled at 60fps, and two decimals is noise nobody can
      // read while flying.
      function drawBuff(
        ui: { block: HTMLElement; gauge: HTMLElement; fill: HTMLElement; secs: HTMLElement },
        banner: HTMLElement,
        glyph: string,
        label: string,
        data: HudBuff | null,
      ): void {
        ui.block.hidden = !data
        banner.hidden = !data?.expiring
        if (!data) return
        ui.fill.style.width = `${data.fraction * 100}%`
        ui.gauge.classList.toggle('expiring', data.expiring)
        ui.secs.textContent = `${data.remaining.toFixed(1)}s`
        if (data.expiring) banner.textContent = `${glyph} ${label}  ${data.remaining.toFixed(1)}`
      }

      drawBuff(odUi, odBanner, '⏱', 'OVERDRIVE', frame.overdrive)
      drawBuff(shUi, shBanner, '⛊', 'SHIELD', frame.shield)

      const target = frame.target
      if (target) {
        const colour = `#${target.accent.toString(16).padStart(6, '0')}`
        targetName.textContent = target.name
        targetName.style.color = colour
        targetRange.textContent = `${Math.round(target.range)} u`
        targetFill.style.width = `${target.hullFraction * 100}%`
        targetFill.style.background = colour
        targetFill.style.boxShadow = `0 0 10px ${colour}`
        targetGauge.style.visibility = 'visible'

        leadPip.hidden = !target.leadVisible
        if (target.leadVisible) {
          const lx = (target.leadNdcX * 0.5 + 0.5) * window.innerWidth
          const ly = (-target.leadNdcY * 0.5 + 0.5) * window.innerHeight
          leadPip.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`
          leadPip.style.color = colour
        }
      } else {
        targetName.textContent = 'NO LOCK'
        targetName.style.color = 'rgba(223, 246, 255, 0.35)'
        targetRange.textContent = '—'
        targetGauge.style.visibility = 'hidden'
        leadPip.hidden = true
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
