import QRCode from 'qrcode'
import { potClaimInvoice, potClaimStatus, type PotClaimStatus } from '../net/server'

export function createPotClaimPanel(parent: HTMLElement) {
  const root = document.createElement('section')
  root.className = 'panel pot-claim'
  root.hidden = true
  root.style.cssText = 'position:fixed;z-index:90;top:50%;left:50%;transform:translate(-50%,-50%);' +
    'width:min(460px,calc(100vw - 24px));max-height:90vh;overflow:auto;padding:24px;background:#07111e;' +
    'border:1px solid #6be6ff;box-shadow:0 12px 60px #000c;text-align:center'
  const heading = document.createElement('h2')
  heading.className = 'glow-cyan'
  const note = document.createElement('p')
  note.setAttribute('role', 'status')
  const fee = document.createElement('p')
  fee.textContent = 'The winner or refunded player receives the funded amount minus a bounded Lightning fee allowance. No house fee. Disconnecting during a pot match forfeits the pot.'
  const qr = document.createElement('canvas')
  qr.setAttribute('aria-label', 'LNURL withdraw QR code')
  const copy = document.createElement('button')
  copy.type = 'button'; copy.className = 'btn primary'; copy.textContent = 'COPY LNURL'
  const invoice = document.createElement('textarea')
  invoice.setAttribute('aria-label', 'Paste a mainnet BOLT11 invoice for the exact amount')
  invoice.placeholder = 'Paste a BOLT11 invoice for this amount'
  invoice.rows = 3
  invoice.style.width = '100%'
  const submit = document.createElement('button')
  submit.type = 'button'; submit.className = 'btn'; submit.textContent = 'PAY THIS INVOICE'
  const close = document.createElement('button')
  close.type = 'button'; close.className = 'btn'; close.textContent = 'CLOSE'
  root.append(heading, note, fee, qr, copy, invoice, submit, close)
  parent.append(root)

  let current: { endpoint: string; code: string; seat: number; token: string } | null = null
  let lnurl = ''
  let pollTimer: number | null = null
  function stopPoll() {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
  }
  function hide() { root.hidden = true; stopPoll() }
  async function render(status: PotClaimStatus) {
    if (!status.kind || status.amountMsat === null) { hide(); return }
    root.hidden = false
    const amount = (status.amountMsat / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })
    heading.textContent = status.kind === 'winner' ? 'POT WINNER' : 'BUY-IN REFUND'
    note.textContent = status.state === 'completed'
      ? `${amount} sats paid. Payment ID: ${status.paymentId ?? 'unknown'}`
      : status.state === 'needs-reconcile'
        ? `Payout under review. Payment ID: ${status.paymentId ?? 'pending'}. Your claim remains open; please check back later.`
        : status.state === 'failed' ? 'The payment failed. You may try a fresh invoice.'
        : status.state === 'claimable' ? status.paymentId
          ? `A prior payment completed. Withdraw the remaining ${amount} sats within 24 hours.`
          : `Withdraw ${amount} sats within 24 hours.`
          : `Payment submitted, not yet settled. ID: ${status.paymentId ?? 'pending'}`
    lnurl = status.lnurl ?? ''
    qr.hidden = !lnurl
    copy.hidden = !lnurl
    invoice.hidden = !lnurl
    submit.hidden = !lnurl
    if (lnurl) {
      try { await QRCode.toCanvas(qr, lnurl, { width: 220, margin: 2 }) }
      catch { qr.hidden = true }
    }
    if (status.state !== 'completed' && status.state !== 'claimable' && status.state !== 'failed' &&
        pollTimer === null) {
      pollTimer = window.setInterval(() => { void refresh() }, 3000)
    } else if (status.state === 'completed') stopPoll()
  }
  async function refresh() {
    if (!current) return
    try { await render(await potClaimStatus(current.endpoint, current.code, current.seat, current.token)) }
    catch { if (!root.hidden) note.textContent = 'Claim status unavailable. Retry later using this room link.' }
  }
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lnurl); copy.textContent = 'COPIED' }
    catch { copy.textContent = 'SELECT LINK'; invoice.value = lnurl; invoice.focus(); invoice.select() }
  })
  submit.addEventListener('click', async () => {
    if (!current || !invoice.value.trim()) return
    submit.disabled = true
    note.textContent = 'Submitting to Voltage; this does not yet mean paid…'
    try {
      await render(await potClaimInvoice(current.endpoint, current.code, current.seat,
        current.token, invoice.value.trim()))
    } catch (error) { note.textContent = error instanceof Error ? error.message : 'Payment unavailable' }
    finally { submit.disabled = false }
  })
  close.addEventListener('click', hide)
  return {
    async show(endpoint: string, code: string, seat: number, token: string) {
      current = { endpoint, code, seat, token }
      await refresh()
    },
    hide,
    dispose() { hide(); root.remove() },
  }
}
