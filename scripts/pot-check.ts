import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PotLedger } from '../src/server/pot-ledger'
import { VoltageReceive } from '../src/server/voltage-receive'

const org = '5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29'
const environment = '638fcc72-5f4b-4734-a2d6-8d0ef939b750'
const wallet = '5272faf9-4644-4478-bc21-9f4b57b420a0'
const dir = await mkdtemp(join(tmpdir(), 'neon-pot-'))
const path = join(dir, 'ledger.json')
let postCount = 0
let paymentStatus = 'generating'
let amount = 100000
let firstId = ''
let dropPost = false
const mock = createServer(async (req, res) => {
  assert.equal(req.headers['x-api-key'], 'mock-key')
  if (req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const disk = JSON.parse(await readFile(path, 'utf8'))
    const [code, seat] = body.metadata.external_id.split(':')
    assert.equal(disk.rooms.find((room: { code: string }) => room.code === code).entries[Number(seat)].paymentId,
      body.id, 'UUID fsynced before POST')
    assert.equal(body.payment_kind, 'bolt11')
    assert.equal(body.wallet_id, wallet)
    assert.deepEqual(body.amount, { currency: 'btc', amount: 100000 })
    assert.equal(body.expiration, 600)
    postCount++
    firstId = body.id
    if (dropPost) { req.socket.destroy(); return }
    res.writeHead(202).end()
    return
  }
  const id = req.url?.split('/').at(-1)
  assert.equal(id, firstId)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id, wallet_id: wallet, organization_id: org, environment_id: environment,
    direction: 'receive', type: 'bolt11', status: paymentStatus,
    requested_amount: { currency: 'btc', amount },
    data: { amount: { currency: 'btc', amount }, payment_request: 'lnbc1mockinvoice' },
  }))
})
try {
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  const address = mock.address()
  if (!address || typeof address === 'string') throw new Error('mock did not listen')
  const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, organizationId: org,
    environmentId: environment, walletId: wallet, apiKey: 'mock-key' }
  const ledger = await PotLedger.open(path)
  await ledger.createRoom('TEST42', 2, 100)
  const { entry, claim } = await ledger.prepareSeat('TEST42', 0)
  assert.match(entry.paymentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert(ledger.ownsSeat('TEST42', 0, claim))
  assert(!ledger.ownsSeat('TEST42', 1, claim))
  assert(!JSON.stringify(await readFile(path, 'utf8')).includes(claim), 'claim stored only as hash')
  const client = new VoltageReceive(ledger, config)
  const [accepted, duplicate] = await Promise.all([
    client.submit('TEST42', 0), client.submit('TEST42', 0),
  ])
  assert.equal(accepted.state, 'submitted')
  assert.equal(duplicate.state, 'submitted')
  assert.equal(postCount, 1)
  assert.equal((await client.poll('TEST42', 0)).state, 'submitted', '202 and generating are not paid')
  amount = 99999
  paymentStatus = 'completed'
  assert.equal((await client.poll('TEST42', 0)).state, 'submitted', 'wrong amount cannot settle')
  amount = 100000
  paymentStatus = 'receiving'
  assert.equal((await client.poll('TEST42', 0)).invoice, 'lnbc1mockinvoice')
  assert.equal((await client.poll('TEST42', 0)).state, 'receiving', 'invoice is not paid')
  const reopened = await PotLedger.open(path)
  assert(reopened.ownsSeat('TEST42', 0, claim), 'claim survives restart')
  paymentStatus = 'completed'
  assert.equal((await new VoltageReceive(reopened, config).poll('TEST42', 0)).state, 'completed')
  assert.equal(postCount, 1, 'recovery reads same ID without repost')

  // An ambiguous POST stays uncertain and is reconciled through GET by ID.
  await reopened.createRoom('TEST43', 2, 100)
  await reopened.prepareSeat('TEST43', 0)
  dropPost = true
  const second = new VoltageReceive(reopened, config)
  await second.submit('TEST43', 0)
  assert.equal(reopened.getRoom('TEST43')!.entries[0].state, 'uncertain')
  assert.equal(postCount, 2)
  dropPost = false
  const afterRestart = await PotLedger.open(path)
  assert.equal(afterRestart.getRoom('TEST43')!.entries[0].state, 'uncertain')
  assert.equal((await new VoltageReceive(afterRestart, config).poll('TEST43', 0)).state, 'completed')
  assert.equal(postCount, 2, 'uncertain write reconciled without a second POST')
  console.log('pot ledger + mocked Voltage receive checks pass')
} finally {
  mock.close()
  await rm(dir, { recursive: true, force: true })
}
