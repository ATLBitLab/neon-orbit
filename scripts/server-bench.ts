/** Synthetic four-client load, without sockets. Measures host work, not browser rendering. */
import { cpus } from 'node:os'
import { STEP } from '../src/game/game'
import type { Channel } from '../src/net/channel'
import { encodeHello, FRAME } from '../src/net/session'
import { encodeIntent } from '../src/net/wire'
import { createDedicatedMatch } from '../src/server/match'

const seconds = Number(process.argv[2] ?? 60)
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
  throw new RangeError('duration must be an integer from 1 to 600 simulated seconds')
}
const started = performance.now()
const match = createDedicatedMatch({ setup: { ships: ['hornet', 'wasp', 'drone', 'hornet'], seed: 0x5120fa11, respawn: true } })
const startupMs = performance.now() - started
let bytes = 0
let snapshots = 0
const receivers: ((bytes: Uint8Array) => void)[][] = []
for (let seat = 0; seat < 4; seat++) {
  let open = true
  const handlers: ((bytes: Uint8Array) => void)[] = []
  const closers: (() => void)[] = []
  const channel: Channel = {
    get open() { return open },
    send(frame) { bytes += frame.length; if (frame[0] === FRAME.SNAPSHOT) snapshots++ },
    onMessage(fn) { handlers.push(fn) }, onClose(fn) { closers.push(fn) },
    close() { if (open) { open = false; for (const fn of closers) fn() } },
  }
  match.connect(channel)
  for (const fn of [...handlers]) fn(encodeHello())
  receivers.push(handlers)
}
const timings: number[] = []
const cpuStart = process.cpuUsage()
try {
  for (let tick = 0; tick < seconds / STEP && !match.result; tick++) {
    for (let seat = 0; seat < 4; seat++) {
      const intent = encodeIntent(seat, tick, { pitch: Math.sin(tick / 180 + seat) * 0.4,
        yaw: 0.3, roll: 0.1, throttle: 0.8, fire: true, dash: false,
        secondary: false, aim: null, spread: 0 })
      const frame = new Uint8Array(intent.length + 1)
      frame[0] = FRAME.INTENT; frame.set(intent, 1)
      for (const fn of [...receivers[seat]]) fn(frame)
    }
    const before = performance.now()
    match.step()
    timings.push(performance.now() - before)
  }
  const cpu = process.cpuUsage(cpuStart)
  const simulatedSeconds = match.ticks * STEP
  timings.sort((a, b) => a - b)
  console.log(JSON.stringify({
    node: process.version, cpu: cpus()[0]?.model, platform: process.platform,
    clients: 4, seed: match.seed, simulatedSeconds, result: !!match.result,
    startupMs, stepMeanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
    stepP95Ms: timings[Math.ceil(timings.length * 0.95) - 1], stepMaxMs: timings.at(-1),
    cpuMs: (cpu.user + cpu.system) / 1000, rssMiB: process.memoryUsage().rss / 1024 ** 2,
    snapshots, outboundBytes: bytes, outboundBytesPerSimulatedSecond: bytes / simulatedSeconds,
    note: 'One synthetic match; real arena and codecs, no sockets, TLS, renderer or concurrent rooms. RSS includes startup geometry and Node. This is not a hosting capacity estimate.',
  }, null, 2))
} finally { match.close() }
