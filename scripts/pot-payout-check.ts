import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PotLedger } from '../src/server/pot-ledger'
import { VoltageSend } from '../src/server/voltage-send'
import { encodeLnurl, fixedMainnetInvoiceAmount } from '../src/server/lnurl'
import { potLaunchAction } from '../src/ui/pot-launch'
import { createDedicatedMatch } from '../src/server/match'
import { choosePotWinner } from '../src/server/pot-winner'
import type { SeatLine } from '../src/core/scores'

const potLines = (): SeatLine[] => [
  { seat: 0, ship: 'hornet', score: 900, kills: 0, deaths: 0, hits: 0,
    shots: 0, alive: true, place: 1, won: true },
  { seat: 1, ship: 'wasp', score: 10, kills: 0, deaths: 1, hits: 0,
    shots: 0, alive: false, place: 2, won: false },
]
assert.equal(choosePotWinner(potLines(), [0, 1], [1], new Map([[0, 5]]), new Set()), 1,
  'a vacant AI survivor cannot win when the connected human dies')
assert.equal(choosePotWinner(potLines(), [0, 1], [1], new Map([[0, 5]]), new Set([0])), 1,
  'an expired seat is eliminated and cannot win')
assert.equal(choosePotWinner(potLines(), [0, 1], [0, 1], new Map(), new Set()), 0,
  'a reclaimed seat is eligible again while the resume window is open')
assert.equal(choosePotWinner(potLines(), [0, 1], [], new Map([[0, 5], [1, 10]]), new Set()), 1,
  'the last connected score decides when nobody is online')
assert.equal(choosePotWinner(potLines(), [0, 1], [], new Map([[0, 10], [1, 10]]), new Set()), null,
  'an ambiguous all-disconnected result requires refunds')

const forfeit = createDedicatedMatch({ setup: { ships: ['hornet', 'wasp'], seed: 17,
  respawn: false, potHumans: [0, 1] } })
assert.equal(forfeit.view(0)?.phase, 'flying', 'a resumable vacant seat is still alive during grace')
forfeit.forfeitPotSeat(0)
assert.equal(forfeit.view(0)?.phase, 'eliminated', 'expiry permanently eliminates that seat')
forfeit.step()
assert.equal(forfeit.result?.lines.find(line => line.seat === 1)?.won, true,
  'the remaining human wins after the other paid seat forfeits')
forfeit.close()

assert.deepEqual(potLaunchAction(true, [0, 1], [0, 1]), { label: 'LAUNCH', disabled: false },
  'the paid host can launch after both seats settle')
assert.equal(potLaunchAction(true, [0, 1], [0]).disabled, true,
  'an unpaid seat prevents launch')
assert.equal(potLaunchAction(false, [0, 1], [0, 1]).disabled, true,
  'a guest cannot launch a paid room')
assert.equal(potLaunchAction(true, [0], [0]).disabled, true,
  'a single paid human cannot launch')

const dir = await mkdtemp(join(tmpdir(), 'neon-pot-payout-'))
try {
  const path = join(dir, 'ledger.json')
  const ledger = await PotLedger.open(path)
  await ledger.createRoom('PAY123', 2, 100)
  const a = await ledger.prepareSeat('PAY123', 0)
  const b = await ledger.prepareSeat('PAY123', 1)
  assert.equal(ledger.ownsSeat('PAY123', 0, a.claim), true)
  assert.equal(ledger.ownsSeat('PAY123', 1, a.claim), false)
  assert.equal(ledger.ownsSeat('PAY123', 1, b.claim), true)
  await ledger.update('PAY123', 0, 'completed')
  await ledger.update('PAY123', 1, 'completed')
  await ledger.launch('PAY123', [0, 1])
  await ledger.resolve('PAY123', 1)
  assert.equal(ledger.getRoom('PAY123')?.winnerSeat, 1)
  assert.equal(ledger.getRoom('PAY123')?.entries[0].entitlement, undefined)
  const claim = ledger.getRoom('PAY123')!.entries[1].entitlement!
  assert.equal(claim.kind, 'winner')
  assert.equal(claim.expiresAt > Date.now(), true)
  assert.equal(claim.amountMsat + claim.maxFeeMsat <= 200_000, true)
  assert.equal(claim.maxFeeMsat, 4000,
    'the fixed 200-sat pot reserves four sats for actual routing cost')

  const invoice = `lnbc${claim.amountMsat / 100}n1${'q'.repeat(60)}`
  assert.equal(fixedMainnetInvoiceAmount(invoice), claim.amountMsat)
  assert.equal(fixedMainnetInvoiceAmount(invoice.replace('lnbc', 'lntb')), null)
  assert.match(encodeLnurl('https://example.com/lnurlw?k1=abc'), /^LNURL1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]+$/)

  let posts = 0
  let reads = 0
  const config = { baseUrl: 'http://127.0.0.1:9999/v1', organizationId: 'org',
    environmentId: 'env', walletId: 'wallet', apiKey: 'fake-only' }
  const mock = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url)
    if (target.endsWith('/wallets/wallet')) {
      return Response.json({ id: 'wallet', network: 'mainnet', balances: [{ currency: 'btc',
        available: { amount: 200_000, unit: 'msats', negative: false } }] })
    }
    if (init?.method === 'POST') { posts++; throw new Error('connection lost after accepted write') }
    reads++
    return Response.json({ id: ledger.getRoom('PAY123')!.entries[1].entitlement!.sends[0].id,
      wallet_id: 'wallet', organization_id: 'org', environment_id: 'env',
      direction: 'send', type: 'bolt11', status: reads === 1 ? 'sending' : 'completed',
      data: { amount: { currency: 'btc', amount: claim.amountMsat } },
      payment_breakdown: { network_fee: { currency: 'btc', unit: 'msats', amount: 700 },
        processing_fee: { currency: 'btc', unit: 'msats', amount: 1000 } },
    })
  }) as typeof fetch
  const prepared = await ledger.prepareSend('PAY123', 1, invoice)
  const sender = new VoltageSend(ledger, config, mock)
  assert.equal((await sender.submit('PAY123', 1, prepared.id)).state, 'uncertain')
  assert.equal(posts, 1)
  const reopened = await PotLedger.open(path)
  const recovering = new VoltageSend(reopened, config, mock)
  assert.equal((await recovering.submit('PAY123', 1, prepared.id)).state, 'uncertain')
  assert.equal(posts, 1, 'ambiguous POST was not repeated after restart')
  assert.equal((await recovering.poll('PAY123', 1, prepared.id)).state, 'sending')
  assert.equal((await recovering.poll('PAY123', 1, prepared.id)).state, 'completed')
  const residual = reopened.nextPayout('PAY123', 1)
  assert.equal(residual !== null && residual.amountMsat < claim.amountMsat, true,
    'unused fee allowance is offered as a second, smaller claim')
  const residualInvoice = `lnbc${residual!.amountMsat / 100}n1${'q'.repeat(60)}`
  const secondSend = await reopened.prepareSend('PAY123', 1, residualInvoice)
  assert.notEqual(secondSend.id, prepared.id, 'each separate payout has a fresh durable UUID')
  await assert.rejects(() => reopened.prepareSend('PAY123', 1, residualInvoice), /claim unavailable/)
  assert.equal(reopened.getRoom('PAY123')?.entries[1].entitlement?.sends[0].networkFeeMsat, 700)

  // A pre-POST balance failure has no external side effect. It must reopen
  // LNURL so a wallet can provide a fresh invoice, not strand `prepared`.
  let spendable = 0
  let retriedPosts = 0
  const balanceMock = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/wallets/wallet')) return Response.json({ id: 'wallet', network: 'mainnet',
      balances: [{ currency: 'btc', available: { amount: spendable, unit: 'msats', negative: false } }] })
    if (init?.method === 'POST') { retriedPosts++; return new Response(null, { status: 202 }) }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const balanceSender = new VoltageSend(reopened, config, balanceMock)
  await assert.rejects(() => balanceSender.submit('PAY123', 1, secondSend.id), /confirmed spendable/)
  assert.equal(secondSend.state, 'failed')
  assert(reopened.nextPayout('PAY123', 1), 'claim reopens after pre-POST failure')
  assert.equal(retriedPosts, 0)
  spendable = 200_000
  const retry = await reopened.prepareSend('PAY123', 1, residualInvoice)
  assert.notEqual(retry.id, secondSend.id)
  assert.equal((await balanceSender.submit('PAY123', 1, retry.id)).state, 'submitted')
  assert.equal(retriedPosts, 1)
  assert.equal((await balanceSender.submit('PAY123', 1, retry.id)).state, 'submitted')
  assert.equal(retriedPosts, 1, 'an accepted send never posts twice')
  assert.equal((await balanceSender.poll('PAY123', 1, retry.id)).state, 'submitted',
    'a 202-accepted UUID cannot be failed by a later transient 404')

  await reopened.createRoom('NFD123', 2, 100)
  await reopened.prepareSeat('NFD123', 0)
  await reopened.update('NFD123', 0, 'completed')
  await reopened.interrupt('NFD123')
  await reopened.ensureRefunds('NFD123')
  const uncertain = await reopened.prepareSend('NFD123', 0, 'lnbc980n1' + 'q'.repeat(60))
  let uncertainPosts = 0
  const absentMock = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/wallets/wallet')) return Response.json({ id: 'wallet', network: 'mainnet',
      balances: [{ currency: 'btc', available: { amount: 200_000, unit: 'msats', negative: false } }] })
    if (init?.method === 'POST') { uncertainPosts++; throw new Error('no response') }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const absentSender = new VoltageSend(reopened, config, absentMock)
  assert.equal((await absentSender.submit('NFD123', 0, uncertain.id)).state, 'uncertain')
  assert.equal((await absentSender.poll('NFD123', 0, uncertain.id)).state, 'uncertain')
  assert.equal(reopened.nextPayout('NFD123', 0), null, 'a fresh 404 cannot authorize a second send')
  const recoveredLedger = await PotLedger.open(path)
  const recoveredSend = recoveredLedger.getRoom('NFD123')!.entries[0].entitlement!.sends[0]
  assert.equal(typeof recoveredSend.notFoundSince, 'number', 'first 404 is durable across restart')
  recoveredSend.notFoundSince = Date.now() - 30 * 60_000 - 1
  const recoveredSender = new VoltageSend(recoveredLedger, config, absentMock)
  assert.equal((await recoveredSender.poll('NFD123', 0, uncertain.id)).state, 'failed')
  assert((await PotLedger.open(path)).nextPayout('NFD123', 0),
    'persistent 404 durably reopens the claim after 30 minutes')
  assert.equal(uncertainPosts, 1, 'uncertain UUID was never reposted')

  await reopened.createRoom('REF123', 2, 100)
  await reopened.prepareSeat('REF123', 0)
  await reopened.update('REF123', 0, 'completed')
  await reopened.interrupt('REF123')
  await reopened.ensureRefunds('REF123')
  assert.equal(reopened.getRoom('REF123')?.entries[0].entitlement?.kind, 'refund')
  await reopened.prepareSeat('REF123', 1)
  await reopened.update('REF123', 1, 'submitted')
  await reopened.update('REF123', 1, 'completed')
  await reopened.ensureRefunds('REF123')
  assert.equal(reopened.getRoom('REF123')?.entries[1].entitlement?.kind, 'refund',
    'a late settlement after room closure still creates a refund')
  assert.equal(await reopened.collect(Date.now() + 8 * 24 * 60 * 60_000), 0,
    'unpaid refund and unused fee allowance retain the ledger')

  await reopened.createRoom('CXL123', 3, 100)
  await reopened.prepareSeat('CXL123', 0)
  await reopened.update('CXL123', 0, 'receiving')
  await reopened.cancelSeat('CXL123', 0)
  assert.equal(reopened.getRoom('CXL123')?.entries[0].entitlement, undefined)
  await reopened.update('CXL123', 0, 'completed')
  await reopened.ensureRefunds('CXL123')
  assert.equal(reopened.getRoom('CXL123')?.entries[0].entitlement?.kind, 'refund',
    'an abandoned seat paid late is still owed its buy-in')
  await reopened.prepareSeat('CXL123', 1)
  await reopened.update('CXL123', 1, 'completed')
  await assert.rejects(() => reopened.launch('CXL123', [0, 1]), /not ready/)

  await reopened.createRoom('EMPTY1', 2, 100)
  const contenders = await Promise.allSettled([
    reopened.prepareSeat('EMPTY1', 0), reopened.prepareSeat('EMPTY1', 0),
  ])
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1,
    'simultaneous claims cannot mint two credentials for one seat')
  await reopened.interrupt('EMPTY1')
  assert.equal(await reopened.collect(Date.now() + 8 * 24 * 60 * 60_000), 1)

  await reopened.createRoom('DUST12', 2, 100)
  await reopened.prepareSeat('DUST12', 0)
  await reopened.prepareSeat('DUST12', 1)
  await reopened.update('DUST12', 0, 'completed')
  await reopened.update('DUST12', 1, 'completed')
  await reopened.launch('DUST12', [0, 1])
  await reopened.resolve('DUST12', 0)
  const dustSend = await reopened.prepareSend('DUST12', 0, 'lnbc1960n1' + 'q'.repeat(60))
  await reopened.updateSend('DUST12', 0, dustSend.id, 'completed', { totalFeeMsat: 2500 })
  assert.equal(await reopened.collect(Date.now() + 8 * 24 * 60 * 60_000), 1,
    'a sub-minimum residual no longer retains the full room forever')
  assert.equal(reopened.getRoom('DUST12'), undefined)
  assert.equal(reopened.listDust().find(item => item.code === 'DUST12')?.amountMsat, 1500,
    'dust remains a durable, claim-bound player liability')
  console.log('pot payout checks passed (mocked Voltage only)')
} finally {
  await rm(dir, { recursive: true, force: true })
}
