import type { LobbyState } from '../net/session'
import { SHIPS } from '../ships/specs'

/** One roster in the hangar, drawn from the host's reservations on either side. */
export function createWing(parent: HTMLElement, onLeave: () => void) {
  const root = document.createElement('section')
  root.className = 'wing'
  root.hidden = true
  root.setAttribute('aria-label', 'Wing lobby')
  root.innerHTML = `<div class="wing-heading"><h2>WING</h2><span class="wing-code"></span></div>
    <ol class="wing-seats" aria-label="Seats"></ol>
    <p class="wing-status" role="status"></p>
    <div class="wing-actions"><button type="button" class="btn wing-copy">COPY LINK</button>
    <button type="button" class="btn wing-leave">LEAVE WING</button></div>`
  const code = root.querySelector<HTMLElement>('.wing-code')!
  const seats = root.querySelector<HTMLOListElement>('.wing-seats')!
  const status = root.querySelector<HTMLElement>('.wing-status')!
  const copy = root.querySelector<HTMLButtonElement>('.wing-copy')!
  const leave = root.querySelector<HTMLButtonElement>('.wing-leave')!
  let url = ''
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url)
      copy.textContent = 'COPIED'
    } catch {
      status.textContent = `Copy this link: ${url}`
      status.style.userSelect = 'text'
    }
  })
  leave.addEventListener('click', onLeave)
  parent.append(root)
  return {
    show(joinCode: string, host: boolean) {
      root.hidden = false
      code.textContent = `JOIN CODE ${joinCode}`
      url = `${location.origin}${location.pathname}?join=${joinCode}`
      copy.textContent = 'COPY LINK'
      copy.hidden = !host
      leave.hidden = host
      seats.replaceChildren()
      status.textContent = host ? 'Launch when ready. Open seats fly on AI.' : 'Choose your hull, then join the wing.'
    },
    update(state: LobbyState) {
      seats.replaceChildren(...state.seats.map((seat, i) => {
        const row = document.createElement('li')
        row.className = i === state.seat ? 'you' : ''
        const name = document.createElement('span')
        name.textContent = `P${i + 1}${i === state.seat ? ' · YOU' : ''}`
        const hull = document.createElement('strong')
        hull.textContent = SHIPS[seat.ship].name
        const pilot = document.createElement('span')
        pilot.textContent = i === 0 ? 'HOST' : seat.pilot === 'human' ? 'JOINED' : seat.pilot.toUpperCase()
        row.append(name, hull, pilot)
        return row
      }))
      status.textContent = state.seat === 0
        ? 'Launch when ready. Open seats fly on AI.'
        : 'Seat reserved. Waiting for the host to launch.'
    },
    status(message: string) { status.textContent = message },
    hide() { root.hidden = true },
  }
}
