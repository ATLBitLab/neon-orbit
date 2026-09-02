/**
 * Pause and debrief panels.
 *
 * Both are the same shape: a clipped panel over a blurred arena, one headline,
 * a few readouts, two or three buttons. Kept in one module because they share
 * the layout and neither is big enough to earn its own file.
 */

import type { RunResult } from '../core/scores'
import { SHIPS } from '../ships/specs'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, primary: boolean): HTMLButtonElement {
  const b = el('button', primary ? 'btn primary' : 'btn', label) as HTMLButtonElement
  b.type = 'button'
  return b
}

/* -------------------------------------------------------------------------- */
/* Pause                                                                      */
/* -------------------------------------------------------------------------- */

export interface PausePanel {
  /** Current settings are passed in, since both are also toggleable in flight. */
  show(inverted: boolean, muted: boolean): void
  hide(): void
  readonly visible: boolean
  dispose(): void
}

export interface PauseDeps {
  parent: HTMLElement
  onResume: () => void
  onAbort: () => void
  /** Both toggles return the resulting state. */
  onToggleInvert: () => boolean
  onToggleMute: () => boolean
}

export function createPausePanel(deps: PauseDeps): PausePanel {
  const root = el('div', 'screen')
  root.id = 'pause'
  root.hidden = true

  const panel = el('div', 'panel')
  panel.append(el('h2', 'glow-cyan', 'Paused'))

  const lines = el('div', 'lines')
  const invertLine = el('div')
  const muteLine = el('div')
  lines.append(
    invertLine,
    muteLine,
    el('div', undefined, 'W / S throttle · mouse or arrows steer · Q / E roll'),
    el('div', undefined, 'Space or click to fire · Shift to dash'),
  )

  const actions = el('div', 'actions')
  const resume = button('Resume', true)
  const invert = button('Invert pitch', false)
  const mute = button('Mute', false)
  const abort = button('Abort run', false)
  actions.append(resume, invert, mute, abort)

  panel.append(lines, actions)
  root.append(panel)
  deps.parent.append(root)

  let inverted = false
  let muted = false

  function refresh() {
    invertLine.innerHTML = `Pitch <b>${inverted ? 'inverted' : 'normal'}</b>`
    muteLine.innerHTML = `Audio <b>${muted ? 'muted' : 'on'}</b>`
    invert.textContent = inverted ? 'Pitch: inverted' : 'Pitch: normal'
    mute.textContent = muted ? 'Unmute' : 'Mute'
  }

  resume.addEventListener('click', () => deps.onResume())
  abort.addEventListener('click', () => deps.onAbort())
  invert.addEventListener('click', () => {
    inverted = deps.onToggleInvert()
    refresh()
  })
  mute.addEventListener('click', () => {
    muted = deps.onToggleMute()
    refresh()
  })

  refresh()

  return {
    show(nextInverted, nextMuted) {
      inverted = nextInverted
      muted = nextMuted
      refresh()
      root.hidden = false
    },
    hide() {
      root.hidden = true
    },
    get visible() {
      return !root.hidden
    },
    dispose() {
      root.remove()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Debrief                                                                    */
/* -------------------------------------------------------------------------- */

export interface DebriefPanel {
  show(result: RunResult, isRecord: boolean, best: number): void
  hide(): void
  readonly visible: boolean
  dispose(): void
}

export interface DebriefDeps {
  parent: HTMLElement
  onReplay: () => void
  onHangar: () => void
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function createDebriefPanel(deps: DebriefDeps): DebriefPanel {
  const root = el('div', 'screen')
  root.id = 'end'
  root.hidden = true

  const panel = el('div', 'panel')
  const heading = el('h2')
  const placing = el('div', 'placing')
  placing.hidden = true
  const scoreBig = el('div', 'score-big', '0')
  const board = el('div', 'board')
  board.hidden = true
  const lines = el('div', 'lines')
  const record = el('div', 'record', 'New personal best')
  record.hidden = true

  const actions = el('div', 'actions')
  const replay = button('Fly again', true)
  const hangar = button('Change ship', false)
  actions.append(replay, hangar)

  panel.append(heading, placing, scoreBig, record, board, lines, actions)
  root.append(panel)
  deps.parent.append(root)

  replay.addEventListener('click', () => deps.onReplay())
  hangar.addEventListener('click', () => deps.onHangar())

  return {
    show(result, isRecord, best) {
      const spec = SHIPS[result.ship]
      const match = result.match
      const mine = match?.lines.find((l) => l.ship === result.ship && l.won === result.won && l.score === result.score)
      // Three ways for a match to end for you: you cleared it, you were shot
      // down, or somebody cleared it and outscored you.
      const outscored = !result.won && match !== undefined && match.cleared && mine?.alive === true
      heading.textContent = result.won ? 'Sector clear' : outscored ? 'Outscored' : 'Hull breach'
      heading.className = result.won ? 'glow-cyan' : 'glow-magenta'
      scoreBig.textContent = result.score.toLocaleString()

      // The scoreboard, when there was more than one seat to place.
      board.innerHTML = ''
      board.hidden = !match || match.lines.length < 2
      placing.hidden = board.hidden
      if (match && match.lines.length > 1) {
        const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor((n % 100) / 10) === 1 ? 0 : n % 10]}`
        placing.textContent = mine ? `${ordinal(mine.place)} of ${match.lines.length}` : ''
        const ordered = match.lines.slice().sort((a, b) => a.place - b.place || a.seat - b.seat)
        for (const line of ordered) {
          const row = el('div', line === mine ? 'row you' : 'row')
          const who = line === mine ? 'YOU' : `P${line.seat + 1}`
          const acc = line.shots > 0 ? Math.round(Math.min(1, line.hits / line.shots) * 100) : 0
          row.innerHTML =
            `<span>${ordinal(line.place)}</span><b>${who}</b><span>${SHIPS[line.ship].name}</span>` +
            `<b>${line.score.toLocaleString()}</b><span>${line.kills} kills · ${line.deaths} deaths · ${acc}%</span>` +
            (line.alive ? '' : '<span class="out">eliminated</span>')
          board.append(row)
        }
      }

      lines.innerHTML = ''
      const rows: [string, string][] = [
        ['Airframe', spec.name],
        ['Kills', `${result.kills} / 6`],
        ['Flight time', formatClock(result.time)],
        ['Accuracy', `${Math.round(result.accuracy * 100)}%`],
        ['Best on this hull', best.toLocaleString()],
      ]
      for (const [label, value] of rows) {
        const row = el('div')
        row.innerHTML = `${label} <b>${value}</b>`
        lines.append(row)
      }

      // A zero is not an achievement, even on a fresh save file.
      record.hidden = !isRecord || result.score <= 0
      replay.textContent = `Fly ${spec.name} again`
      root.hidden = false
    },
    hide() {
      root.hidden = true
    },
    get visible() {
      return !root.hidden
    },
    dispose() {
      root.remove()
    },
  }
}
