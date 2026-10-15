import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import WebSocket from 'ws'

const root = process.cwd()
const listener = resolve(root, 'src/server/listener.ts')
const fixture = resolve(root, 'scripts/fixtures/faulting-match.ts')
const bundle = resolve(root, 'node_modules/.cache/server-isolation.mjs')
await build({ entryPoints: [listener], outfile: bundle, bundle: true, packages: 'external',
  platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  plugins: [{ name: 'faulting-match', setup(build) {
    build.onResolve({ filter: /^\.\/match$/ }, args => {
      if (args.importer === listener) return { path: fixture }
    })
  } }],
})

async function freePort() {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

async function until(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function scenario(stage) {
  const port = await freePort()
  const endpoint = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, PORT: String(port), FAULT_STAGE: stage },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const sockets = []
  const health = async () => fetch(`${endpoint}/health`).then(response => response.json())

  async function createRoom() {
    const response = await fetch(`${endpoint}/rooms`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 2 }) })
    assert.equal(response.status, 201)
    return (await response.json()).code
  }

  async function join(code) {
    const url = `ws://127.0.0.1:${port}/ws?room=${code}`
    const socket = new WebSocket(url)
    const peer = { socket, frames: [], closeCode: null }
    const frames = peer.frames
    socket.on('message', (data, binary) => { if (binary) frames.push(Buffer.from(data)) })
    socket.on('close', code => { peer.closeCode = code })
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    sockets.push(socket)
    socket.send(Buffer.from([FRAME.HELLO, 3, 1]))
    await until(() => frames.some(frame => frame[0] === FRAME.LOBBY), 'lobby')
    return peer
  }

  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`)
      try { return (await health()).ok } catch { return false }
    }, 'server start')
    const failedCode = await createRoom()
    const healthyCode = await createRoom()
    const failed = [await join(failedCode), await join(failedCode)]
    const healthy = [await join(healthyCode), await join(healthyCode)]
    failed[0].socket.send(JSON.stringify({ type: 'start' }))
    healthy[0].socket.send(JSON.stringify({ type: 'start' }))
    await until(() => healthy.every(peer => peer.frames.some(frame => frame[0] === FRAME.SNAPSHOT)),
      'healthy snapshots')
    if (stage === 'dispatch') failed[0].socket.send(Buffer.from([FRAME.INTENT, 1, 0, 0, 0, 0, 0]))
    await until(async () => {
      const state = await health()
      return state.rooms === 1 && state.players === 2
    }, 'failed room cleanup')
    await until(() => stderr.includes(failedCode) && stderr.includes(`injected ${stage} failure`),
      'room-coded error log')
    await until(() => failed.every(peer => peer.closeCode !== null),
      'failed-room player disconnects')
    assert.ok(failed.every(peer => peer.closeCode === 1000),
      'failed-room players received a normal socket close for RETRY')
    const snapshots = healthy.map(peer => peer.frames.filter(frame => frame[0] === FRAME.SNAPSHOT).length)
    await until(() => healthy.every((peer, i) =>
      peer.frames.filter(frame => frame[0] === FRAME.SNAPSHOT).length > snapshots[i]),
    'healthy room continues ticking')
    assert.equal(child.exitCode, null, 'server process stayed up')
    console.log(`${stage}: room ${failedCode} closed; room ${healthyCode} kept ticking; process stayed up`)
  } finally {
    for (const socket of sockets) socket.close()
    child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
}

const FRAME = { HELLO: 1, SNAPSHOT: 4, LOBBY: 7, INTENT: 3 }
await scenario('tick')
await scenario('dispatch')
await scenario('launch')
