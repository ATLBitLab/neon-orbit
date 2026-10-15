import { FRAME } from '../../src/net/session'
import { createDedicatedMatch as createMatch, type DedicatedOptions } from '../../src/server/match'

let created = 0

/** Bundled in place of the listener's match import by server-isolation.mjs. */
export function createDedicatedMatch(options: DedicatedOptions) {
  const match = createMatch(options)
  if (created++ !== 0) return match
  if (process.env.FAULT_STAGE === 'launch') {
    return new Proxy(match, {
      get(target, property, receiver) {
        if (property === 'connect') return () => { throw new Error('injected launch failure') }
        return Reflect.get(target, property, receiver)
      },
    })
  }
  if (process.env.FAULT_STAGE === 'dispatch') {
    return new Proxy(match, {
      get(target, property, receiver) {
        if (property === 'connect') return (channel: Parameters<typeof match.connect>[0], seat: number) => {
          match.connect(channel, seat)
          channel.onMessage(bytes => {
            if (bytes[0] === FRAME.INTENT) throw new Error('injected dispatch failure')
          })
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }
  return new Proxy(match, {
    get(target, property, receiver) {
      if (property === 'step') return () => {
        if (match.ticks >= 120) throw new Error('injected tick failure')
        match.step()
      }
      return Reflect.get(target, property, receiver)
    },
  })
}
