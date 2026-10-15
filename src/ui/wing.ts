import type { LobbyState } from '../net/session'
import { SHIPS } from '../ships/specs'
import * as QRCode from 'qrcode'

/** One roster in the hangar, drawn from the host's reservations on either side. */
export function createWing(parent: HTMLElement, onLeave: () => void) {
  const root = document.createElement('section')
  root.className = 'wing'
  root.hidden = true
  root.setAttribute('aria-label', 'Wing lobby')
  root.innerHTML = `<div class="wing-heading"><h2>WING</h2><span class="wing-code"></span></div>
    <ol class="wing-seats" aria-label="Seats"></ol>
    <div class="wing-pot" hidden>
      <h3>POT MATCH</h3>
      <p class="wing-pot-fee">Winner receives the pot minus a bounded allowance for Lightning routing and processing fees. No house fee.</p>
      <p class="wing-pot-state" role="status"></p>
      <canvas class="wing-pot-qr" aria-label="Lightning invoice QR code" hidden></canvas>
      <textarea class="wing-pot-invoice" readonly aria-label="Lightning invoice" hidden></textarea>
      <button type="button" class="btn wing-pot-copy" hidden>COPY INVOICE</button>
    </div>
    <p class="wing-status" role="status"></p>
    <p class="wing-note" hidden>We record anonymous match stats to tune balance.</p>
    <div class="wing-actions"><button type="button" class="btn wing-copy">COPY LINK</button>
    <button type="button" class="btn wing-leave">LEAVE WING</button></div>`
  const code = root.querySelector<HTMLElement>('.wing-code')!
  const seats = root.querySelector<HTMLOListElement>('.wing-seats')!
  const status = root.querySelector<HTMLElement>('.wing-status')!
  const pot = root.querySelector<HTMLElement>('.wing-pot')!
  const potState = root.querySelector<HTMLElement>('.wing-pot-state')!
  const potQr = root.querySelector<HTMLCanvasElement>('.wing-pot-qr')!
  const potInvoice = root.querySelector<HTMLTextAreaElement>('.wing-pot-invoice')!
  const potCopy = root.querySelector<HTMLButtonElement>('.wing-pot-copy')!
  const note = root.querySelector<HTMLElement>('.wing-note')!
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
  potCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(potInvoice.value)
      potCopy.textContent = 'COPIED'
    } catch {
      potInvoice.hidden = false
      potInvoice.focus()
      potInvoice.select()
      potCopy.textContent = 'SELECT INVOICE'
    }
  })
  parent.append(root)
  return {
    /** `recorded`: a dedicated-server room, whose matches feed the anonymous stats. */
    show(joinCode: string, host: boolean, joinUrl?: string, recorded = false) {
      root.hidden = false
      note.hidden = !recorded
      code.textContent = `JOIN CODE ${joinCode}`
      url = joinUrl ?? `${location.origin}${location.pathname}?join=${joinCode}`
      copy.textContent = 'COPY LINK'
      copy.hidden = !host
      leave.hidden = host
      seats.replaceChildren()
      pot.hidden = true
      potInvoice.value = ''
      potQr.hidden = true
      potInvoice.hidden = true
      potCopy.hidden = true
      status.textContent = host ? 'Launch when ready. Open seats fly on AI.' : 'Choose your hull, then join the wing.'
    },
    update(state: LobbyState, canLaunch = state.seat === 0,
      lead = state.seats.findIndex(seat => seat.pilot === 'human')) {
      seats.replaceChildren(...state.seats.map((seat, i) => {
        const row = document.createElement('li')
        row.className = i === state.seat ? 'you' : ''
        const name = document.createElement('span')
        name.textContent = `P${i + 1}${i === state.seat ? ' · YOU' : ''}`
        const hull = document.createElement('strong')
        hull.textContent = SHIPS[seat.ship].name
        const pilot = document.createElement('span')
        pilot.textContent = i === lead ? 'HOST' : seat.pilot === 'human' ? 'JOINED' : seat.pilot.toUpperCase()
        row.append(name, hull, pilot)
        return row
      }))
      status.textContent = canLaunch
        ? 'Launch when ready. Open seats fly on AI.'
        : 'Seat reserved. Waiting for the host to launch.'
    },
    status(message: string) { status.textContent = message },
    async potStatus(buyInSats: number, paidSeats: number[], ownSeat: number,
      payment?: { state: string; invoice: string | null }) {
      pot.hidden = false
      const ownPaid = paidSeats.includes(ownSeat) || payment?.state === 'completed'
      const paidCount = paidSeats.length
      potState.textContent = ownPaid
        ? `PAID · ${paidCount} seat${paidCount === 1 ? '' : 's'} settled. Waiting for the pot match to open.`
        : payment?.state === 'storage-unavailable'
          ? 'Payment unavailable: this browser cannot save your seat claim. Enable storage and rejoin.'
        : payment?.state === 'failed' || payment?.state === 'expired'
          ? 'This invoice is no longer payable. Ask the host for a new room.'
          : payment?.invoice
            ? `PAY ${buyInSats} SATS · ${paidCount} seat${paidCount === 1 ? '' : 's'} settled`
            : `Preparing ${buyInSats}-sat invoice…`
      const invoice = !ownPaid && payment?.invoice ? payment.invoice : ''
      potQr.hidden = !invoice
      potInvoice.hidden = !invoice
      potCopy.hidden = !invoice
      if (invoice && potInvoice.value !== invoice) {
        potInvoice.value = invoice
        potCopy.textContent = 'COPY INVOICE'
        try { await QRCode.toCanvas(potQr, invoice.toUpperCase(), { width: 240, margin: 2,
          color: { dark: '#061019', light: '#ffffff' } }) }
        catch { potQr.hidden = true }
      }
    },
    hide() { root.hidden = true },
  }
}
