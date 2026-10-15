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
    socket.on('message', (data, binary) => { if (binary) frames.push(data[0]) })
    socket.once('open', () => { sockets.push(socket); socket.send(Buffer.from([1, 3, 0])); resolve({ socket, frames }) })
    socket.once('error', reject)
  })
}

try {
  const first = await connect()
  const second = await connect()
  const until = async predicate => {
    const deadline = Date.now() + 15_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for game frames')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  await until(() => first.frames.includes(7) && second.frames.includes(7))
  first.socket.send(JSON.stringify({ type: 'start' }))
  await until(() => first.frames.includes(2) && second.frames.includes(2))
  await until(() => first.frames.includes(4) && second.frames.includes(4))
  const health = await fetch(`${endpoint}/health`).then(res => res.json())
  assert.equal(health.players, 2)
  console.log(`room ${code}: both clients received lobby, welcome, and snapshots`)
} finally {
  for (const socket of sockets) socket.close()
}
