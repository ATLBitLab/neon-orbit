/**
 * The hangar: pick your airframe.
 *
 * The cards are DOM, but the ship itself is the real in-game model rotating in
 * the real scene, lit by the real sun with the real planet behind it. Showing a
 * separate illustration here would be cheaper and would also be a promise the
 * dogfight then has to keep.
 */

import * as THREE from 'three'
import type { Audio } from '../core/audio'
import { bestFor } from '../core/scores'
import { buildShip, disposeShipVisual, type ShipVisual } from '../ships/meshes'
import { SHIP_ORDER, SHIPS, type ShipId, type ShipSpec } from '../ships/specs'

/** Where the previewed hull hangs in world space. */
const PREVIEW_POSITION = new THREE.Vector3(0, 40, 1500)
/** Camera orbit radius as a multiple of the hull's length. */
const ORBIT_RADIUS = 1.8
const ORBIT_HEIGHT = 0.62
const ORBIT_SPEED = 0.16
/**
 * The camera aims below the hull so it rides high in frame, clear of the
 * readout and the cards. Also in ship lengths.
 */
const AIM_DROP = 0.62

const _desired = new THREE.Vector3()
const _aim = new THREE.Vector3()

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
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

const STAT_LABELS: { key: keyof ShipSpec['bars']; label: string }[] = [
  { key: 'speed', label: 'Speed' },
  { key: 'agility', label: 'Agility' },
  { key: 'armor', label: 'Armour' },
  { key: 'firepower', label: 'Guns' },
]

function quirkBadge(spec: ShipSpec): string {
  switch (spec.quirk.kind) {
    case 'heat':
      return 'Quirk · guns overheat'
    case 'regen':
      return 'Quirk · hull self-repairs'
    case 'dash':
      return 'Quirk · phase dash'
  }
}

export interface Hangar {
  root: HTMLElement
  open(initial: ShipId): void
  close(): void
  update(dt: number): void
  readonly selected: ShipId
  dispose(): void
}

export interface HangarDeps {
  parent: HTMLElement
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  audio: Audio
  onLaunch: (id: ShipId) => void
}

export function createHangar(deps: HangarDeps): Hangar {
  const { parent, scene, camera, audio } = deps

  let selected: ShipId = 'hornet'
  let orbit = 0
  let open = false

  /* ---- Preview models --------------------------------------------------- */

  const previews = new Map<ShipId, ShipVisual>()
  for (const id of SHIP_ORDER) {
    const visual = buildShip(SHIPS[id])
    visual.group.position.copy(PREVIEW_POSITION)
    visual.group.visible = false
    // Idle on the pad: enough exhaust to look alive, not enough to look launched.
    for (const flare of visual.thrusters) flare.scale.set(0.7, 0.7, 0.45)
    scene.add(visual.group)
    previews.set(id, visual)
  }

  /* ---- Markup ----------------------------------------------------------- */

  const root = el('div', 'screen')
  root.id = 'select'
  root.hidden = true

  const header = el('header')
  const brand = el('div', 'brand')
  const title = el('h1', 'title glow-cyan', 'NEON ORBIT')
  brand.append(title, el('p', undefined, 'Low-orbit combat trials · Sector Verdant'))
  const bestBlock = el('div', 'best')
  header.append(brand, bestBlock)

  const stage = el('div', 'stage')
  const readout = el('div', 'readout')
  const readoutName = el('h2')
  const readoutTag = el('p', 'tagline')
  const readoutQuirk = el('div', 'quirk')
  readout.append(readoutName, readoutTag, readoutQuirk)
  stage.append(readout)

  const cards = el('div', 'cards')
  const cardNodes = new Map<ShipId, HTMLButtonElement>()

  for (const id of SHIP_ORDER) {
    const spec = SHIPS[id]
    const card = el('button', 'card') as HTMLButtonElement
    card.type = 'button'
    card.style.setProperty('--accent', hex(spec.accent))
    card.setAttribute('aria-pressed', 'false')

    const row = el('div', 'row')
    row.append(el('h3', undefined, spec.name), el('span', 'callsign', spec.callsign))

    const stats = el('div', 'stats')
    for (const { key, label } of STAT_LABELS) {
      const stat = el('div', 'stat')
      const track = el('div', 'track')
      const fill = el('i')
      fill.style.width = `${Math.round(spec.bars[key] * 100)}%`
      track.append(fill)
      stat.append(el('span', undefined, label), track)
      stats.append(stat)
    }

    const notes = el('div', 'notes')
    for (const s of spec.strengths) notes.append(el('div', 'up', s))
    for (const w of spec.weaknesses) notes.append(el('div', 'down', w))

    const bestTag = el('div', 'best-tag')
    const record = bestFor(id)
    bestTag.textContent = record ? `Your best · ${record.score.toLocaleString()}` : 'No record yet'

    card.append(row, stats, notes, bestTag)
    card.addEventListener('click', () => select(id, true))
    card.addEventListener('mouseenter', () => {
      if (selected !== id) select(id, true)
    })
    cards.append(card)
    cardNodes.set(id, card)
  }

  const footer = el('footer')
  const legend = el('div', 'controls-legend')
  legend.innerHTML = `
    <span><b class="key">W</b><b class="key">S</b> Throttle</span>
    <span><b class="key">Mouse</b> Steer</span>
    <span><b class="key">↑</b><b class="key">↓</b><b class="key">A</b><b class="key">D</b> Steer (keys)</span>
    <span><b class="key">Q</b><b class="key">E</b> Roll</span>
    <span><b class="key">Space</b> Fire</span>
    <span><b class="key">Shift</b> Dash</span>
  `
  const launch = el('button', 'btn-launch', 'Launch') as HTMLButtonElement
  launch.type = 'button'
  footer.append(legend, launch)

  root.append(header, stage, cards, footer)
  parent.append(root)

  /* ---- Behaviour -------------------------------------------------------- */

  function refreshBestBlock() {
    const lines = SHIP_ORDER.map((id) => {
      const record = bestFor(id)
      return `${SHIPS[id].name} <b>${record ? record.score.toLocaleString() : '—'}</b>`
    })
    bestBlock.innerHTML = `<div>Personal bests</div>${lines.map((l) => `<div>${l}</div>`).join('')}`
  }

  function select(id: ShipId, chime: boolean) {
    selected = id
    const spec = SHIPS[id]

    for (const [key, visual] of previews) visual.group.visible = key === id
    for (const [key, node] of cardNodes) node.setAttribute('aria-pressed', String(key === id))

    readoutName.textContent = spec.name.toUpperCase()
    readoutName.style.color = hex(spec.accent)
    readoutName.style.textShadow = `0 0 20px ${hex(spec.accent)}`
    readoutTag.textContent = spec.tagline
    readoutQuirk.textContent = quirkBadge(spec)
    readoutQuirk.style.color = hex(spec.accent)

    launch.style.background = hex(spec.accent)
    launch.style.boxShadow = `0 0 34px ${hex(spec.accent)}aa`
    launch.textContent = `Launch ${spec.name}`

    if (chime) {
      audio.resume()
      audio.uiSelect()
    }
  }

  function doLaunch() {
    audio.resume()
    audio.uiLaunch()
    deps.onLaunch(selected)
  }

  launch.addEventListener('click', doLaunch)

  function onKey(e: KeyboardEvent) {
    if (!open) return
    const index = SHIP_ORDER.indexOf(selected)
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault()
      doLaunch()
    } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      select(SHIP_ORDER[(index + 1) % SHIP_ORDER.length], true)
    } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      select(SHIP_ORDER[(index - 1 + SHIP_ORDER.length) % SHIP_ORDER.length], true)
    } else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
      select(SHIP_ORDER[Number(e.code.slice(5)) - 1], true)
    }
  }
  window.addEventListener('keydown', onKey)

  return {
    root,

    get selected() {
      return selected
    },

    open(initial) {
      open = true
      root.hidden = false
      orbit = 0
      refreshBestBlock()
      // Card records can change between visits, so refresh them on open too.
      for (const [id, node] of cardNodes) {
        const tag = node.querySelector('.best-tag')
        const record = bestFor(id)
        if (tag) tag.textContent = record ? `Your best · ${record.score.toLocaleString()}` : 'No record yet'
      }
      select(initial, false)
    },

    close() {
      open = false
      root.hidden = true
      for (const visual of previews.values()) visual.group.visible = false
    },

    update(dt) {
      if (!open) return
      orbit += dt * ORBIT_SPEED

      const visual = previews.get(selected)
      if (!visual) return

      // Slow yaw on the hull plus a camera orbit: two rotations at different
      // rates read as a turntable rather than as a spinning prop.
      visual.group.rotation.y += dt * 0.22

      const radius = visual.length * ORBIT_RADIUS
      _desired.set(
        PREVIEW_POSITION.x + Math.sin(orbit) * radius,
        PREVIEW_POSITION.y + visual.length * ORBIT_HEIGHT,
        PREVIEW_POSITION.z + Math.cos(orbit) * radius,
      )
      camera.position.lerp(_desired, 1 - Math.exp(-4 * dt))
      camera.up.set(0, 1, 0)
      _aim.copy(PREVIEW_POSITION).setY(PREVIEW_POSITION.y - visual.length * AIM_DROP)
      camera.lookAt(_aim)
    },

    dispose() {
      window.removeEventListener('keydown', onKey)
      for (const visual of previews.values()) {
        scene.remove(visual.group)
        disposeShipVisual(visual)
      }
      previews.clear()
      root.remove()
    },
  }
}
