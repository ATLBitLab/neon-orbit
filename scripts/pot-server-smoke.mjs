import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const dir = await mkdtemp(join(tmpdir(), 'neon-pot-server-'))
let postCount = 0
const settled = new Set()
const mock = createServer(async (req, res) => {
  assert.equal(req.headers['x-api-key'], 'mock-key')
  if (req.method === 'POST') {
    postCount++
    const body = JSON.parse(await new Promise(resolve => {
      let value = ''
      req.on('data', chunk => { value += chunk })
      req.on('end', () => resolve(value))
    }))
    assert.equal(body.amount.amount, 100000)
    res.writeHead(202).end()
    return
  }
  const id = req.url.split('/').at(-1)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id, wallet_id: '5272faf9-4644-4478-bc21-9f4b57b420a0',
    organization_id: '5ad1ad8d-5f47-4c9f-82f1-ee63ea1f2c29',
    environment_id: '638fcc72-5f4b-4734-a2d6-8d0ef939b750',
    direction: 'receive', type: 'bolt11', status: settled.has(id) ? 'completed' : 'receiving',
    requested_amount: { currency: 'btc', amount: 100000 },
    data: { payment_request: 'lnbc1mockinvoice' },
  }))
})
let child
const sockets = []
try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  const port = 18178
  child = spawn('node', ['dist-server/listener.mjs'], { env: {
    ...process.env, PORT: String(port), POT_ENABLED: '1', POT_PROCESSING_FEE_BPS: '0',
    POT_LEDGER_PATH: join(dir, 'ledger.json'), VOLTAGE_API_KEY: 'mock-key',
    VOLTAGE_API_URL: `http://127.0.0.1:${mockPort}/v1`,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const url = `http://127.0.0.1:${port}`
  async function wait(check) {
    const deadline = Date.now() + 6000
    while (!await check()) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out: ${stderr}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await wait(async () => fetch(`${url}/health`).then(r => r.ok).catch(() => false))
  const free = await fetch(`${url}/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: 2 }) })
  assert.equal(free.status, 201, 'free rooms still work with flag on')
  const badAmount = await fetch(`${url}/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: 2, pot: { buyInSats: 1001 } }) })
  assert.equal(badAmount.status, 400)
  const missingAmount = await fetch(`${url}/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: 2, pot: {} }) })
  assert.equal(missingAmount.status, 400, 'malformed pot request cannot create a free room')
  const made = await fetch(`${url}/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: 2, pot: { buyInSats: 100 } }) })
  assert.equal(made.status, 201)
  const { code } = await made.json()
  async function connectPlayer() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`)
    const controls = []
    const frames = []
    socket.on('message', (data, binary) => {
      if (!binary) controls.push(JSON.parse(String(data)))
      else frames.push(Buffer.from(data))
    })
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    sockets.push(socket)
    socket.send(Buffer.from([1, 3, 0]))
    await wait(() => controls.some(item => item.type === 'pot'))
    return { socket, controls, frames, pot: controls.find(item => item.type === 'pot') }
  }
  const first = await connectPlayer()
  const second = await connectPlayer()
  assert.equal(first.pot.seat, 0)
  assert.equal(second.pot.seat, 1)
  assert.notEqual(first.pot.claim, second.pot.claim)
  const unauthorized = await fetch(`${url}/pot`, { method: 'POST', headers: {
    authorization: `Bearer ${first.pot.claim}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ code, seat: 1 }) })
  assert.equal(unauthorized.status, 403, 'claim cannot pay another seat')
  const invoice = await fetch(`${url}/pot`, { method: 'POST', headers: {
    authorization: `Bearer ${first.pot.claim}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ code, seat: 0 }) })
  assert.equal(invoice.status, 200)
  assert.deepEqual(await invoice.json(), { paymentId: first.pot.paymentId,
    state: 'receiving', invoice: 'lnbc1mockinvoice' })
  const repeated = await fetch(`${url}/pot`, { method: 'POST', headers: {
    authorization: `Bearer ${first.pot.claim}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ code, seat: 0 }) })
  assert.equal(repeated.status, 200, 'invoice fetch is idempotent')
  assert.equal(postCount, 1, 'one payment ID is submitted only once')
  first.socket.send(JSON.stringify({ type: 'start' }))
  await wait(() => first.controls.some(item => item.type === 'error'))
  assert.equal(first.controls.find(item => item.type === 'error').message,
    'every player must pay before launch')
  settled.add(first.pot.paymentId)
  const paid = await fetch(`${url}/pot?room=${code}&seat=0`, { headers: {
    authorization: `Bearer ${first.pot.claim}`,
  } })
  assert.equal((await paid.json()).state, 'completed')
  await wait(() => second.controls.some(item => item.type === 'room' && item.pot?.paidSeats?.includes(0)))
  const secondInvoice = await fetch(`${url}/pot`, { method: 'POST', headers: {
    authorization: `Bearer ${second.pot.claim}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ code, seat: 1 }) })
  assert.equal(secondInvoice.status, 200)
  settled.add(second.pot.paymentId)
  const secondPaid = await fetch(`${url}/pot?room=${code}&seat=1`, { headers: {
    authorization: `Bearer ${second.pot.claim}`,
  } })
  assert.equal((await secondPaid.json()).state, 'completed')
  first.socket.close()
  await new Promise(resolve => first.socket.once('close', resolve))
  // Paid seat 0 stays locked to the claim, not merely the room code.
  const codeOnly = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`)
  const rejected = await new Promise((resolve, reject) => {
    codeOnly.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    codeOnly.once('open', () => reject(new Error('paid seat taken by room code')))
    codeOnly.once('error', reject)
  })
  assert.equal(rejected, 429)
  const badClaim = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&potSeat=0`)
  await new Promise((resolve, reject) => { badClaim.once('open', resolve); badClaim.once('error', reject) })
  sockets.push(badClaim)
  const badClose = new Promise(resolve => badClaim.once('close', resolve))
  badClaim.send(Buffer.concat([Buffer.from([9, 0]), Buffer.from(second.pot.claim, 'ascii')]))
  assert.equal(await badClose, 1008, 'another seat claim cannot take the paid seat')
  const replacement = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&potSeat=0`)
  const frames = []
  replacement.on('message', (data, binary) => { if (binary) frames.push(Buffer.from(data)) })
  await new Promise((resolve, reject) => { replacement.once('open', resolve); replacement.once('error', reject) })
  sockets.push(replacement)
  replacement.send(Buffer.concat([Buffer.from([9, 0]), Buffer.from(first.pot.claim, 'ascii')]))
  replacement.send(Buffer.from([1, 3, 0]))
  await wait(() => frames.some(frame => frame[0] === 7 && frame[6] === 0))
  // The earliest still-connected HELLO is the launcher after seat 0 is reclaimed.
  second.socket.send(JSON.stringify({ type: 'start' }))
  await wait(() => second.frames.some(frame => frame[0] === 2) &&
    frames.some(frame => frame[0] === 2))
  assert.equal((await fetch(`${url}/health`).then(r => r.json())).rooms, 2,
    'the fully paid pot and separate free room remain isolated')
  const disk = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'))
  assert.equal(disk.rooms.find(room => room.code === code).entries[0].state, 'completed')
  assert.equal(disk.rooms.find(room => room.code === code).phase, 'running')
  assert(!JSON.stringify(disk).includes(first.pot.claim))
  console.log('pot listener + mocked Voltage smoke passes')
} finally {
  for (const socket of sockets) socket.terminate()
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  mock.close()
  await rm(dir, { recursive: true, force: true })
}
