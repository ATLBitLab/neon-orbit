import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import WebSocket from 'ws'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:8080'
const response = await fetch(`${endpoint}/rooms`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 2 }) })
assert.equal(response.status, 201)
const { code } = await response.json()
const sockets = []

function connect() {
  const url = new URL('/ws', endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', code)
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const frames = []
    const controls = []
    socket.on('message', (data, binary) => {
      if (binary) frames.push(Buffer.from(data))
      else controls.push(JSON.parse(String(data)))
    })
    socket.once('open', () => { sockets.push(socket); socket.send(Buffer.from([1, 3, 0])); resolve({ socket, frames, controls }) })
    socket.once('error', reject)
  })
}

try {
  const first = await connect()
  const until = async predicate => {
    const deadline = Date.now() + 15_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for game frames')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  await until(() => first.frames.some(frame => frame[0] === 7))
  first.socket.send(JSON.stringify({ type: 'start' }))
  await until(() => first.controls.some(control => control.type === 'error'))
  assert.equal((await fetch(`${endpoint}/health`).then(res => res.json())).rooms, 1,
    'early launch refusal kept the lobby open')
  const second = await connect()
  await until(() => second.frames.some(frame => frame[0] === 7))
  first.socket.send(JSON.stringify({ type: 'ship', ship: 'drone' }))
  second.socket.send(JSON.stringify({ type: 'ship', ship: 'wasp' }))
  await until(() => first.frames.some(frame => frame[0] === 7 && frame[8] === 2 && frame[10] === 0))
  first.socket.send(JSON.stringify({ type: 'start' }))
  await until(() => first.frames.some(frame => frame[0] === 2) && second.frames.some(frame => frame[0] === 2))
  const firstWelcome = first.frames.find(frame => frame[0] === 2)
  const secondWelcome = second.frames.find(frame => frame[0] === 2)
  assert.equal(firstWelcome[2], 0)
  assert.equal(secondWelcome[2], 1)
  assert.equal(firstWelcome[9], 2, 'host selected Drone reached the match')
  assert.equal(firstWelcome[10], 0, 'guest selected Wasp reached the match')
  await until(() => first.frames.some(frame => frame[0] === 4) && second.frames.some(frame => frame[0] === 4))
  await until(() => second.frames.filter(frame => frame[0] === 4).length >= 5)
  const snapshotTicks = second.frames.filter(frame => frame[0] === 4).map(frame => frame.readUInt32LE(2))
  assert.ok(snapshotTicks.every((tick, i) => i === 0 || tick - snapshotTicks[i - 1] === 2),
    'server sends a full snapshot every second match tick')
  assert.equal(first.frames.filter(frame => frame[0] === 2).length, 1, 'host welcomed exactly once')
  assert.equal(second.frames.filter(frame => frame[0] === 2).length, 1, 'guest welcomed exactly once')
  const health = await fetch(`${endpoint}/health`).then(res => res.json())
  assert.equal(health.players, 2)
  const guestFrames = second.frames.length
  first.socket.send(Buffer.from([3, 1, 0, 255, 255, 255, 255]))
  const futureClose = await new Promise(resolve => first.socket.once('close', resolve))
  assert.equal(futureClose, 1008, 'future intent closed only its sender')
  await until(() => second.frames.length > guestFrames)
  assert.equal(second.socket.readyState, WebSocket.OPEN, 'other seat kept receiving snapshots')
  console.log(`room ${code}: both clients received lobby, assigned hulls, welcome, and snapshots`)
} finally {
  for (const socket of sockets) socket.close()
}
const deadline = Date.now() + 3000
while (Date.now() < deadline) {
  const health = await fetch(`${endpoint}/health`).then(res => res.json())
  if (health.rooms === 0 && health.players === 0) break
  await new Promise(resolve => setTimeout(resolve, 50))
}
const health = await fetch(`${endpoint}/health`).then(res => res.json())
assert.equal(health.rooms, 0, 'empty match was removed')
assert.equal(health.players, 0, 'disconnected players were removed')

const guardRoom = await fetch(`${endpoint}/rooms`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 2 }) }).then(res => res.json())
const guardUrl = new URL('/ws', endpoint)
guardUrl.protocol = guardUrl.protocol === 'https:' ? 'wss:' : 'ws:'
guardUrl.searchParams.set('room', guardRoom.code)
const idle = new WebSocket(guardUrl)
await new Promise((resolve, reject) => { idle.once('open', resolve); idle.once('error', reject) })
const blocked = new WebSocket(guardUrl)
const rejectedStatus = await new Promise((resolve, reject) => {
  blocked.once('unexpected-response', (_request, response) => resolve(response.statusCode))
  blocked.once('open', () => reject(new Error('second pending connection was admitted')))
  blocked.once('error', reject)
})
assert.equal(rejectedStatus, 429, 'only one pending HELLO per IP')
idle.send(Buffer.alloc(257))
const oversizedClose = await new Promise(resolve => idle.once('close', resolve))
assert.equal(oversizedClose, 1009, 'oversized frame was closed by ws')
const cleanupDeadline = Date.now() + 3000
while ((await fetch(`${endpoint}/health`).then(res => res.json())).players !== 0) {
  if (Date.now() > cleanupDeadline) throw new Error('oversized connection was not removed')
  await new Promise(resolve => setTimeout(resolve, 20))
}

const rateRoom = await fetch(`${endpoint}/rooms`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 2 }) }).then(res => res.json())
guardUrl.searchParams.set('room', rateRoom.code)
const busy = new WebSocket(guardUrl)
await new Promise((resolve, reject) => { busy.once('open', resolve); busy.once('error', reject) })
for (let i = 0; i < 121; i++) busy.send(JSON.stringify({ type: 'ship', ship: 'hornet' }))
const rateClose = await new Promise(resolve => busy.once('close', resolve))
assert.equal(rateClose, 1008, 'message rate limit closed the connection')
console.log('pending connection, packet size, and message rate limits held')

async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for room state')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function createRoom(seats, ip) {
  const response = await fetch(`${endpoint}/rooms`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
    body: JSON.stringify({ seats }) })
  return { status: response.status, ...await response.json() }
}

async function joinRoom(code, ip, ship = 1) {
  const url = new URL('/ws', endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', code)
  const socket = new WebSocket(url, { headers: { 'X-Real-IP': ip } })
  const frames = []
  const controls = []
  socket.on('message', (data, binary) => {
    if (binary) frames.push(Buffer.from(data))
    else controls.push(JSON.parse(String(data)))
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(Buffer.from([1, 3, ship]))
  await waitFor(() => frames.some(frame => frame[0] === 7))
  return { socket, frames, controls }
}

const gapIp = '198.51.100.10'
const gap = await createRoom(3, gapIp)
assert.equal(gap.status, 201)
const p1 = await joinRoom(gap.code, gapIp, 1) // Hornet
const p2 = await joinRoom(gap.code, gapIp, 2) // Drone
const p3 = await joinRoom(gap.code, gapIp, 0) // Wasp
p2.socket.close()
await waitFor(async () => (await fetch(`${endpoint}/health`).then(res => res.json())).players === 2)
p1.socket.send(JSON.stringify({ type: 'start' }))
await waitFor(() => p1.frames.some(frame => frame[0] === 2) && p3.frames.some(frame => frame[0] === 2))
const gapWelcome = p3.frames.find(frame => frame[0] === 2)
assert.equal(gapWelcome[2], 2, 'Wasp player kept reserved lobby seat 2')
assert.equal(gapWelcome[10], 1, 'vacant seat 1 uses default Hornet')
assert.equal(gapWelcome[11], 0, 'seat 2 keeps Wasp instead of giving it to AI')
p1.socket.close()
p3.socket.close()
await waitFor(async () => (await fetch(`${endpoint}/health`).then(res => res.json())).players === 0)
console.log('lobby gap kept seat and hull assignments')

const sharedIp = '198.51.100.20'
const sharedSockets = []
for (let i = 0; i < 3; i++) {
  const room = await createRoom(2, sharedIp)
  assert.equal(room.status, 201)
  sharedSockets.push((await joinRoom(room.code, sharedIp)).socket)
  sharedSockets.push((await joinRoom(room.code, sharedIp)).socket)
}
assert.equal((await createRoom(2, sharedIp)).status, 429, 'one IP cannot reserve every room')
const otherIp = '198.51.100.21'
const otherRoom = await createRoom(2, otherIp)
assert.equal(otherRoom.status, 201, 'another IP can create despite six same-IP players')
const other = await joinRoom(otherRoom.code, otherIp)
assert.equal((await fetch(`${endpoint}/health`).then(res => res.json())).players, 7,
  'six clients on one NAT coexist with another client')
for (const socket of [...sharedSockets, other.socket]) socket.close()
await waitFor(async () => (await fetch(`${endpoint}/health`).then(res => res.json())).players === 0)
console.log('six same-IP players allowed, per-IP room cap and global headroom held')

const controlIp = '198.51.100.50'
const controlRoom = await createRoom(2, controlIp)
assert.equal(controlRoom.status, 201)
const creator = await joinRoom(controlRoom.code, controlIp)
for (const payload of ['null', '1', '"text"', '[]', '{}', '{"type":"unknown"}', '{']) {
  const offender = await joinRoom(controlRoom.code, controlIp)
  const closed = new Promise(resolve => offender.socket.once('close', resolve))
  offender.socket.send(payload)
  assert.equal(await closed, 1008, `invalid control ${payload} closed only its sender`)
  assert.equal(creator.socket.readyState, WebSocket.OPEN, 'creator stayed in lobby')
  await waitFor(async () => (await fetch(`${endpoint}/health`).then(res => res.json())).players === 1)
}
const survivor = await joinRoom(controlRoom.code, controlIp)
const creatorClosed = new Promise(resolve => creator.socket.once('close', resolve))
creator.socket.send('null')
assert.equal(await creatorClosed, 1008, 'invalid creator control was a policy close')
assert.equal(survivor.socket.readyState, WebSocket.OPEN, 'creator bad frame did not close the room')
const replacement = await joinRoom(controlRoom.code, controlIp)
assert.equal(replacement.frames.find(frame => frame[0] === 7)?.[6], 0,
  'vacated creator seat can be joined again')

const rawResponse = await new Promise((resolve, reject) => {
  const url = new URL(endpoint)
  const socket = createConnection(Number(url.port), url.hostname)
  let response = ''
  socket.setTimeout(3000, () => socket.destroy(new Error('malformed upgrade timed out')))
  socket.on('connect', () => socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'))
  socket.on('data', data => { response += String(data) })
  socket.on('close', () => resolve(response))
  socket.on('error', reject)
})
assert.match(rawResponse, /^HTTP\/1\.1 400 Bad Request/, 'malformed upgrade got HTTP 400')
assert.equal((await fetch(`${endpoint}/health`).then(res => res.json())).ok, true,
  'process remained healthy after malformed upgrade')
assert.equal(survivor.socket.readyState, WebSocket.OPEN,
  'malformed upgrade did not disrupt an existing room')
survivor.socket.close()
replacement.socket.close()
console.log('invalid controls closed only their senders; malformed upgrade returned 400')

for (const [index, kicked] of [false, true].entries()) {
  const ip = `198.51.100.${60 + index}`
  const room = await createRoom(3, ip)
  assert.equal(room.status, 201)
  const [first, next, last] = [await joinRoom(room.code, ip), await joinRoom(room.code, ip),
    await joinRoom(room.code, ip)]
  const roomControl = peer => peer.controls.filter(control => control.type === 'room').at(-1)
  await waitFor(() => roomControl(first)?.creator === true && roomControl(next)?.creator === false)
  const closed = new Promise(resolve => first.socket.once('close', resolve))
  if (kicked) first.socket.send('null')
  else first.socket.close()
  const closeCode = await closed
  if (kicked) assert.equal(closeCode, 1008, 'policy kick closed only the creator')
  await waitFor(() => roomControl(next)?.creator === true && roomControl(last)?.creator === false)
  assert.equal(roomControl(next).launcherSeat, 1, 'room control names the promoted launcher')
  assert.equal(next.socket.readyState, WebSocket.OPEN, 'next seat stayed in the lobby')
  last.socket.send(JSON.stringify({ type: 'start' }))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(!last.frames.some(frame => frame[0] === 2), 'higher seat could not launch')
  next.socket.send(JSON.stringify({ type: 'start' }))
  await waitFor(() => next.frames.some(frame => frame[0] === 2) && last.frames.some(frame => frame[0] === 2))
  assert.equal(next.frames.find(frame => frame[0] === 2)[2], 1,
    'promoted launcher kept its reserved seat')
  next.socket.close()
  last.socket.close()
  console.log(`${kicked ? 'policy kick' : 'normal departure'} handed launch to the lowest remaining seat`)
}
