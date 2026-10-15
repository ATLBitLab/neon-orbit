import assert from 'node:assert/strict'
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
    socket.on('message', (data, binary) => { if (binary) frames.push(Buffer.from(data)) })
    socket.once('open', () => { sockets.push(socket); socket.send(Buffer.from([1, 3, 0])); resolve({ socket, frames }) })
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
for (let i = 0; i < 121; i++) busy.send(JSON.stringify({ type: 'noop' }))
const rateClose = await new Promise(resolve => busy.once('close', resolve))
assert.equal(rateClose, 1008, 'message rate limit closed the connection')
console.log('pending connection, packet size, and message rate limits held')
