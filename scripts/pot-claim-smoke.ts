import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PotLedger } from '../src/server/pot-ledger'

const temp = await mkdtemp(join(tmpdir(), 'neon-pot-claim-'))
const ledger = await PotLedger.open(join(temp, 'ledger.json'))
const org = '5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29'
const environment = '638fcc72-5f4b-4734-a2d6-8d0ef939b750'
const wallet = '5272faf9-4644-4478-bc21-9f4b57b420a0'
const paymentsPath = `/v1/organizations/${org}/environments/${environment}/payments`
const walletPath = `/v1/organizations/${org}/wallets/${wallet}`
await ledger.createRoom('REF123', 2, 100)
const { claim } = await ledger.prepareSeat('REF123', 0)
const other = await ledger.prepareSeat('REF123', 1)
await ledger.update('REF123', 0, 'completed')
await ledger.update('REF123', 1, 'completed')
await ledger.launch('REF123', [0, 1])
await ledger.createRoom('REVIEW', 2, 100)
const reviewSeat = await ledger.prepareSeat('REVIEW', 0)
await ledger.update('REVIEW', 0, 'completed')
await ledger.interrupt('REVIEW')
await ledger.ensureRefunds('REVIEW')
const reviewSend = await ledger.prepareSend('REVIEW', 0, 'lnbc980n1' + 'q'.repeat(60))
await ledger.updateSend('REVIEW', 0, reviewSend.id, 'uncertain')
await ledger.noteSendNotFound('REVIEW', 0, reviewSend.id)
ledger.getRoom('REVIEW')!.entries[0].entitlement!.expiresAt = Date.now() - 1
await ledger.noteSendNotFound('REVIEW', 0, reviewSend.id,
  reviewSend.notFoundSince! + 30 * 60_000 + 1)
await ledger.createRoom('STRAND', 2, 100)
const stranded = await ledger.prepareSeat('STRAND', 0)
await ledger.update('STRAND', 0, 'uncertain')
await ledger.interrupt('STRAND')
// The listener process starts with no in-memory room and must convert this
// persisted running match to two refunds before answering any claim request.
const grossMsat = 100_000
const reserveMsat = Math.min(Math.floor(grossMsat / 4), Math.max(2000, Math.ceil(grossMsat * 0.02)))
const amountMsat = grossMsat - reserveMsat
const invoice = `lnbc${amountMsat / 100}n1${'q'.repeat(60)}`
let postCount = 0
let paymentId = ''
let failNext = false
let failedId = ''
const mock = createServer(async (req, res) => {
  assert.equal(req.headers['x-api-key'], 'fake-only')
  if (req.url === walletPath) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: '5272faf9-4644-4478-bc21-9f4b57b420a0', network: 'mainnet',
      balances: [{ currency: 'btc', available: { amount: 100000, unit: 'msats', negative: false } }],
    }))
    return
  }
  if (req.method === 'POST') {
    assert.equal(req.url, paymentsPath, 'send POST retains the exact /v1 API path')
    postCount++
    const body = await new Promise<string>(resolve => {
      let value = ''
      req.on('data', chunk => { value += String(chunk) })
      req.on('end', () => resolve(value))
    })
    const parsed = JSON.parse(body) as { id: string; data: { amount: { amount: number } } }
    paymentId = parsed.id
    if (failNext) failedId = parsed.id
    assert.equal(parsed.data.amount.amount, amountMsat)
    res.writeHead(202).end()
    return
  }
  assert.match(req.url ?? '', /^\/v1\/organizations\/5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29\/environments\/638fcc72-5f4b-4734-a2d6-8d0ef939b750\/payments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'send/receive GET retains /v1 and the payment UUID')
  if (req.url?.endsWith(reviewSend.id) || req.url?.endsWith(stranded.entry.paymentId)) {
    res.writeHead(404).end(); return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: req.url?.split('/').at(-1) ?? paymentId,
    wallet_id: '5272faf9-4644-4478-bc21-9f4b57b420a0',
    organization_id: '5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29',
    environment_id: '638fcc72-5f4b-4734-a2d6-8d0ef939b750',
    direction: 'send', type: 'bolt11',
    status: req.url?.endsWith(failedId) && failedId ? 'failed' : 'completed',
    data: { amount: { currency: 'btc', amount: amountMsat } },
    payment_breakdown: { network_fee: { currency: 'btc', unit: 'msats', amount: 500 },
      processing_fee: { currency: 'btc', unit: 'msats', amount: 1000 } },
  }))
})

// Read the URL payload from a bech32 LNURL without needing a browser QR scanner.
function lnurlUrl(encoded: string): string {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const data = encoded.toLowerCase().split('1').at(-1)!.slice(0, -6)
  let bits = 0, acc = 0
  const bytes: number[] = []
  for (const char of data) {
    acc = (acc << 5) | alphabet.indexOf(char); bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255) }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

let child: ReturnType<typeof spawn> | null = null
try {
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = (mock.address() as { port: number }).port
  const port = 18179
  child = spawn(process.execPath, ['dist-server/listener.mjs'], { env: {
    ...process.env, PORT: String(port), POT_ENABLED: '1', POT_PROCESSING_FEE_BPS: '0',
    POT_PUBLIC_URL: 'https://example.com', POT_LEDGER_PATH: join(temp, 'ledger.json'),
    VOLTAGE_API_KEY: 'fake-only', VOLTAGE_API_URL: `http://127.0.0.1:${mockPort}/v1`,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/health`).then(response => response.ok).catch(() => false)) break
    if (i === 99) throw new Error(`listener did not start: ${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  for (const path of ['/rooms', '/pot', '/pot/claim', '/pot/cancel']) {
    const malformed = await fetch(`${base}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: 'null' })
    assert.equal(malformed.status, 400, `${path} rejects a non-object JSON body`)
  }
  assert.equal((await fetch(`${base}/health`)).status, 200, 'bad HTTP bodies do not crash the server')
  const headers = { Authorization: `Bearer ${claim}` }
  const strandedStatus = await fetch(`${base}/pot?room=STRAND&seat=0`, {
    headers: { Authorization: `Bearer ${stranded.claim}` },
  }).then(response => response.json()) as { state: string; invoice: string | null }
  assert.deepEqual(strandedStatus, { paymentId: stranded.entry.paymentId,
    state: 'uncertain', invoice: null }, 'restart leaves an unpaid receive inert')
  const strandedDisk = JSON.parse(await readFile(join(temp, 'ledger.json'), 'utf8')) as {
    rooms: { code: string; phase: string; entries: { entitlement?: unknown }[] }[]
  }
  const strandedRoom = strandedDisk.rooms.find(room => room.code === 'STRAND')!
  assert.equal(strandedRoom.phase, 'refunding')
  assert.equal(strandedRoom.entries[0].entitlement, undefined,
    'an uncreated receive creates no refund liability after restart')
  assert(!stderr.includes('pot reconciliation failed'),
    'an uncreated receive does not error during startup reconciliation')
  const reviewStatus = await fetch(`${base}/pot/claim?room=REVIEW&seat=0`, {
    headers: { Authorization: `Bearer ${reviewSeat.claim}` },
  }).then(response => response.json()) as { state: string; expiresAt: number | null; lnurl?: string }
  assert.equal(reviewStatus.state, 'needs-reconcile', 'persistent 404 is player-visible as under review')
  assert.equal(reviewStatus.expiresAt, null, 'ambiguous payout cannot expire after 24 hours')
  assert.equal(reviewStatus.lnurl, undefined, 'an unresolved payout never offers a second invoice')
  const status = await fetch(`${base}/pot/claim?room=REF123&seat=0`, { headers })
  assert.equal(status.status, 200)
  const body = await status.json() as { kind: string; state: string; lnurl: string }
  assert.equal(body.kind, 'refund')
  assert.equal(body.state, 'claimable')
  const disk = JSON.parse(await readFile(join(temp, 'ledger.json'), 'utf8')) as {
    rooms: { phase: string; entries: { entitlement?: { kind: string } }[] }[]
  }
  assert.equal(disk.rooms[0].phase, 'refunding', 'restart interrupted the match')
  assert.equal(disk.rooms[0].entries[1].entitlement?.kind, 'refund',
    'the other paid seat received its own refund')
  const url = new URL(lnurlUrl(body.lnurl))
  assert.equal(url.origin, 'https://example.com')
  const k1 = url.searchParams.get('k1')!
  const offer = await fetch(`${base}${url.pathname}${url.search}`).then(response => response.json()) as {
    tag: string; minWithdrawable: number; maxWithdrawable: number; callback: string
  }
  assert.equal(offer.tag, 'withdrawRequest')
  assert.equal(offer.minWithdrawable, amountMsat)
  assert.equal(offer.maxWithdrawable, amountMsat)
  const callback = new URL(offer.callback)
  callback.searchParams.set('k1', k1)
  callback.searchParams.set('pr', invoice)
  const paid = await fetch(`${base}${callback.pathname}${callback.search}`).then(response => response.json()) as {
    status: string
  }
  assert.equal(paid.status, 'OK')
  assert.equal(postCount, 1)
  const replay = await fetch(`${base}${callback.pathname}${callback.search}`)
  assert.equal(replay.status, 404, 'LNURL k1 is single-use')
  const complete = await fetch(`${base}/pot/claim?room=REF123&seat=0`, { headers }).then(response => response.json()) as {
    state: string; paymentId: string; lnurl?: string
  }
  assert.equal(complete.state, 'completed')
  assert.equal(complete.paymentId, paymentId)
  assert.equal(complete.lnurl, undefined)
  const changed = await fetch(`${base}/pot/claim`, { method: 'POST', headers: {
    ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'REF123', seat: 0, invoice: invoice + 'q' }) })
  assert.equal(changed.status, 409)
  assert.equal(postCount, 1, 'a completed claim never pays twice')

  failNext = true
  const otherHeaders = { Authorization: `Bearer ${other.claim}` }
  const otherStatus = await fetch(`${base}/pot/claim?room=REF123&seat=1`, {
    headers: otherHeaders }).then(response => response.json()) as { lnurl: string }
  const otherUrl = new URL(lnurlUrl(otherStatus.lnurl))
  const otherOffer = await fetch(`${base}${otherUrl.pathname}${otherUrl.search}`)
    .then(response => response.json()) as { callback: string }
  const failedCallback = new URL(otherOffer.callback)
  failedCallback.searchParams.set('k1', otherUrl.searchParams.get('k1')!)
  failedCallback.searchParams.set('pr', invoice)
  const failed = await fetch(`${base}${failedCallback.pathname}${failedCallback.search}`)
    .then(response => response.json()) as { status: string }
  assert.equal(failed.status, 'ERROR', 'LNURL reports a terminal send failure to the wallet')
  const reopened = await fetch(`${base}/pot/claim?room=REF123&seat=1`, {
    headers: otherHeaders }).then(response => response.json()) as { state: string; lnurl: string }
  assert.equal(reopened.state, 'claimable')
  assert(reopened.lnurl, 'failed LNURL send leaves the refund claim open')
  console.log('pot LNURL withdraw + mocked Voltage send smoke passed')
} finally {
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child!.once('exit', resolve)) }
  mock.close()
  await rm(temp, { recursive: true, force: true })
}
