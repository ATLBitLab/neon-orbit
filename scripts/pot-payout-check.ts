import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PotLedger } from '../src/server/pot-ledger'
import { VoltageSend } from '../src/server/voltage-send'
import { encodeLnurl, fixedMainnetInvoiceAmount } from '../src/server/lnurl'
import { potLaunchAction } from '../src/ui/pot-launch'

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

  // An unavailable wallet leaves the durable send in `prepared`, allowing the
  // claimant to retry the same invoice and UUID after funds become available.
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
  assert.equal(secondSend.state, 'prepared')
  assert.equal(retriedPosts, 0)
  spendable = 200_000
  assert.equal((await balanceSender.submit('PAY123', 1, secondSend.id)).state, 'submitted')
  assert.equal(retriedPosts, 1)
  assert.equal((await balanceSender.submit('PAY123', 1, secondSend.id)).state, 'submitted')
  assert.equal(retriedPosts, 1, 'an accepted send never posts twice')

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
  console.log('pot payout checks passed (mocked Voltage only)')
} finally {
  await rm(dir, { recursive: true, force: true })
}
