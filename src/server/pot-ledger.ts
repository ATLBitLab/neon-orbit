import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { open, readFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ReceiveState = 'prepared' | 'submitted' | 'uncertain' | 'receiving' | 'completed' | 'failed' | 'expired'
export type SendState = 'prepared' | 'uncertain' | 'needs-reconcile' | 'submitted' | 'sending' | 'completed' | 'failed'

export interface PotSend {
  id: string
  /** The invoice is needed only for the one permitted POST after the ID is durable. */
  invoice: string
  amountMsat: number
  maxFeeMsat: number
  state: SendState
  createdAt: number
  updatedAt: number
  networkFeeMsat?: number
  processingFeeMsat?: number
  totalFeeMsat?: number
  /** First confirmed GET 404 after a possibly accepted POST; never proof of failure. */
  notFoundSince?: number
}

export interface PotEntitlement {
  kind: 'winner' | 'refund'
  grossMsat: number
  amountMsat: number
  maxFeeMsat: number
  expiresAt: number
  sends: PotSend[]
}

export interface PotSeat {
  seat: number
  paymentId: string
  claimSalt: string
  claimHash: string
  state: ReceiveState
  invoice: string | null
  createdAt: number
  updatedAt: number
  entitlement?: PotEntitlement
  canceled?: boolean
}

export interface PotRoom {
  code: string
  seats: number
  buyInSats: number
  createdAt: number
  entries: PotSeat[]
  phase?: 'lobby' | 'running' | 'resolved' | 'refunding'
  participants?: number[]
  winnerSeat?: number
  closedAt?: number
}

interface DustRecord { code: string; seat: number; amountMsat: number; claimSalt: string;
  claimHash: string; recordedAt: number }
interface LedgerFile { version: 1; rooms: PotRoom[]; dust?: DustRecord[] }

function hashClaim(secret: string, salt: string): Buffer {
  // The claim itself has 256 random bits, so a fast one-way hash is safe and
  // avoids letting unauthenticated status requests stall the game loop.
  return createHash('sha256').update(salt).update(secret).digest()
}

export class PotLedger {
  private readonly rooms = new Map<string, PotRoom>()
  private readonly dust: DustRecord[] = []
  private writeQueue: Promise<void> = Promise.resolve()
  private operationQueue: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<PotLedger> {
    const ledger = new PotLedger(path)
    let file: LedgerFile
    try { file = JSON.parse(await readFile(path, 'utf8')) as LedgerFile }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      file = { version: 1, rooms: [] }
    }
    if (file.version !== 1 || !Array.isArray(file.rooms)) throw new Error('invalid pot ledger')
    for (const room of file.rooms) ledger.rooms.set(room.code, room)
    if (Array.isArray(file.dust)) ledger.dust.push(...file.dust)
    return ledger
  }

  getRoom(code: string): PotRoom | undefined { return this.rooms.get(code) }
  listRooms(): PotRoom[] { return [...this.rooms.values()] }
  listDust(): readonly DustRecord[] { return this.dust }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(() => {}, () => {})
    return result
  }

  async createRoom(code: string, seats: number, buyInSats: number): Promise<PotRoom> {
    return this.serial(async () => {
    if (!Number.isInteger(seats) || seats < 2 || seats > 4 ||
        !Number.isInteger(buyInSats) || buyInSats < 10 || buyInSats > 1000) {
      throw new Error('invalid pot room')
    }
    if (this.rooms.has(code)) throw new Error('pot room already exists')
    const room: PotRoom = { code, seats, buyInSats, createdAt: Date.now(), entries: [], phase: 'lobby' }
    this.rooms.set(code, room)
    try { await this.persist() } catch (error) { this.rooms.delete(code); throw error }
    return room
    })
  }

  // A seat receives an independent, durable claim credential. This is never a
  // 12-second match resume token and is returned only at initial assignment.
  async prepareSeat(code: string, seat: number): Promise<{ entry: PotSeat; claim: string }> {
    return this.serial(async () => {
    const room = this.rooms.get(code)
    if (!room || !Number.isInteger(seat) || seat < 0 || seat >= room.seats ||
        room.entries.some(entry => entry.seat === seat)) throw new Error('seat unavailable')
    const claim = randomBytes(32).toString('base64url')
    const claimSalt = randomBytes(16).toString('hex')
    const now = Date.now()
    const entry: PotSeat = { seat, paymentId: randomUUID(), claimSalt,
      claimHash: hashClaim(claim, claimSalt).toString('hex'), state: 'prepared',
      invoice: null, createdAt: now, updatedAt: now }
    room.entries.push(entry)
    try { await this.persist() } catch (error) {
      room.entries.splice(room.entries.indexOf(entry), 1)
      throw error
    }
    return { entry, claim }
    })
  }

  ownsSeat(code: string, seat: number, claim: string): boolean {
    const entry = this.rooms.get(code)?.entries.find(item => item.seat === seat)
    if (!entry || !/^[A-Za-z0-9_-]{43}$/.test(claim)) return false
    const actual = hashClaim(claim, entry.claimSalt)
    return timingSafeEqual(actual, Buffer.from(entry.claimHash, 'hex'))
  }

  async update(code: string, seat: number, state: ReceiveState, invoice?: string): Promise<PotSeat> {
    return this.serial(async () => {
    const entry = this.rooms.get(code)?.entries.find(item => item.seat === seat)
    if (!entry) throw new Error('seat unavailable')
    const previous = { state: entry.state, invoice: entry.invoice, updatedAt: entry.updatedAt }
    entry.state = state
    if (invoice) entry.invoice = invoice
    entry.updatedAt = Date.now()
    try { await this.persist() } catch (error) {
      Object.assign(entry, previous)
      throw error
    }
    return entry
    })
  }

  /** Freeze who paid before the host starts its first authoritative tick. */
  async launch(code: string, participants: number[]): Promise<void> {
    return this.serial(async () => {
    const room = this.rooms.get(code)
    if (!room || (room.phase ?? 'lobby') !== 'lobby' || participants.length < 2 ||
        new Set(participants).size !== participants.length ||
        participants.some(seat => {
          const entry = room.entries.find(item => item.seat === seat)
          return entry?.state !== 'completed' || entry.canceled
        })) {
      throw new Error('pot room is not ready')
    }
    const previous = { phase: room.phase, participants: room.participants }
    room.phase = 'running'
    room.participants = [...participants]
    try { await this.persist() } catch (error) { Object.assign(room, previous); throw error }
    })
  }

  /** A crash after launch and before the result always becomes refunds. */
  async interrupt(code: string): Promise<void> {
    return this.serial(async () => {
    const room = this.rooms.get(code)
    if (!room || room.phase === 'resolved' || room.phase === 'refunding') return
    const previous = { phase: room.phase, closedAt: room.closedAt }
    room.phase = 'refunding'
    room.closedAt = Date.now()
    try { await this.persist() } catch (error) { Object.assign(room, previous); throw error }
    })
  }

  async resolve(code: string, winnerSeat: number): Promise<void> {
    return this.serial(async () => {
    const room = this.rooms.get(code)
    if (!room || room.phase !== 'running' || !room.participants?.includes(winnerSeat)) {
      throw new Error('invalid pot result')
    }
    const winner = room.entries.find(entry => entry.seat === winnerSeat)
    if (!winner || winner.state !== 'completed') throw new Error('winner was not paid')
    const grossMsat = room.participants.length * room.buyInSats * 1000
    const previous = { phase: room.phase, winnerSeat: room.winnerSeat, closedAt: room.closedAt,
      entitlement: winner.entitlement }
    room.phase = 'resolved'
    room.winnerSeat = winnerSeat
    room.closedAt = Date.now()
    winner.entitlement = entitlement('winner', grossMsat)
    try { await this.persist() } catch (error) {
      room.phase = previous.phase; room.winnerSeat = previous.winnerSeat
      room.closedAt = previous.closedAt; winner.entitlement = previous.entitlement
      throw error
    }
    })
  }

  /** Amount the winner can request before actual route fees are known. */
  previewWinner(code: string): number {
    const room = this.rooms.get(code)
    if (!room?.participants?.length) throw new Error('pot participants unavailable')
    return entitlement('winner', room.participants.length * room.buyInSats * 1000).amountMsat
  }

  /** Only a completed receive creates a refundable liability. Never infer it from 202. */
  async ensureRefunds(code: string): Promise<void> {
    return this.serial(async () => {
    const room = this.rooms.get(code)
    if (!room) return
    const added: PotSeat[] = []
    for (const entry of room.entries) {
      if (entry.state === 'completed' && !entry.entitlement &&
          (room.phase === 'refunding' || entry.canceled ||
            (room.phase === 'resolved' && !room.participants?.includes(entry.seat)))) {
        entry.entitlement = entitlement('refund', room.buyInSats * 1000)
        added.push(entry)
      }
    }
    if (!added.length) return
    try { await this.persist() } catch (error) {
      for (const entry of added) delete entry.entitlement
      throw error
    }
    })
  }

  /** An abandoned paid lobby seat is refunded without waiting for other players. */
  async cancelSeat(code: string, seat: number): Promise<void> {
    return this.serial(async () => {
      const room = this.rooms.get(code)
      const entry = room?.entries.find(item => item.seat === seat)
      if (!room || !entry || room.phase !== 'lobby') throw new Error('seat cannot be canceled')
      if (entry.canceled) return
      entry.canceled = true
      if (entry.state === 'completed') entry.entitlement = entitlement('refund', room.buyInSats * 1000)
      try { await this.persist() } catch (error) {
        delete entry.canceled; delete entry.entitlement
        throw error
      }
    })
  }

  /** Persist the exact UUID, invoice and amount before the external send. */
  async prepareSend(code: string, seat: number, invoice: string): Promise<PotSend> {
    return this.serial(async () => {
    const entry = this.rooms.get(code)?.entries.find(item => item.seat === seat)
    const entitlement = entry?.entitlement
    const next = entitlement ? nextPayout(entitlement) : null
    if (!next || entitlementExpired(entitlement!)) throw new Error('claim unavailable')
    const now = Date.now()
    const send: PotSend = { id: randomUUID(), invoice, amountMsat: next.amountMsat,
      maxFeeMsat: next.maxFeeMsat, state: 'prepared', createdAt: now, updatedAt: now }
    entitlement!.sends.push(send)
    try { await this.persist() } catch (error) { entitlement!.sends.pop(); throw error }
    return send
    })
  }

  nextPayout(code: string, seat: number): { amountMsat: number; maxFeeMsat: number } | null {
    const entitlement = this.rooms.get(code)?.entries.find(item => item.seat === seat)?.entitlement
    if (!entitlement || entitlementExpired(entitlement)) return null
    return nextPayout(entitlement)
  }

  async updateSend(code: string, seat: number, id: string, state: SendState,
    fees?: { networkFeeMsat?: number; processingFeeMsat?: number; totalFeeMsat: number }): Promise<PotSend> {
    return this.serial(async () => {
    const entitlement = this.rooms.get(code)?.entries.find(item => item.seat === seat)?.entitlement
    const send = entitlement?.sends.find(item => item.id === id)
    if (!send) throw new Error('send unavailable')
    const previous = { state: send.state, updatedAt: send.updatedAt,
      networkFeeMsat: send.networkFeeMsat, processingFeeMsat: send.processingFeeMsat,
      totalFeeMsat: send.totalFeeMsat, expiresAt: entitlement!.expiresAt }
    send.state = state; send.updatedAt = Date.now()
    if (fees) Object.assign(send, fees)
    if (['uncertain', 'needs-reconcile', 'submitted', 'sending'].includes(previous.state) &&
        (state === 'completed' || state === 'failed')) {
      entitlement!.expiresAt = Math.max(entitlement!.expiresAt, Date.now() + DAY)
    }
    try { await this.persist() } catch (error) {
      send.state = previous.state; send.updatedAt = previous.updatedAt
      send.networkFeeMsat = previous.networkFeeMsat
      send.processingFeeMsat = previous.processingFeeMsat
      send.totalFeeMsat = previous.totalFeeMsat
      entitlement!.expiresAt = previous.expiresAt
      throw error
    }
    return send
    })
  }

  /** Persistent 404 needs an operator; it never proves that a send did not execute. */
  async noteSendNotFound(code: string, seat: number, id: string, now = Date.now()): Promise<PotSend> {
    return this.serial(async () => {
      const send = this.rooms.get(code)?.entries.find(item => item.seat === seat)
        ?.entitlement?.sends.find(item => item.id === id)
      if (!send) throw new Error('send unavailable')
      // A 202 or a previously visible payment is known to exist. Never infer
      // its failure from a later 404; only an ambiguous POST can time out.
      if (send.state !== 'uncertain' && send.state !== 'needs-reconcile') return send
      const previous = { state: send.state, notFoundSince: send.notFoundSince, updatedAt: send.updatedAt }
      if (send.notFoundSince === undefined) send.notFoundSince = now
      else if (send.state === 'uncertain' && now - send.notFoundSince >= 30 * 60_000) {
        send.state = 'needs-reconcile'
        send.updatedAt = now
      } else return send
      try { await this.persist() } catch (error) { Object.assign(send, previous); throw error }
      return send
    })
  }

  /** Offline operator action, after the payment UUID is confirmed absent in Voltage. */
  async failAbsentSend(id: string): Promise<{ code: string; seat: number }> {
    return this.serial(async () => {
      const matches = [...this.rooms.values()].flatMap(room => room.entries.flatMap(entry =>
        entry.entitlement?.sends.filter(send => send.id === id).map(send => ({ room, entry, send })) ?? []))
      if (matches.length !== 1 || matches[0].send.state !== 'needs-reconcile') {
        throw new Error('send is not uniquely pending operator reconciliation')
      }
      const { room, entry, send } = matches[0]
      const entitlement = entry.entitlement!
      const previous = { state: send.state, updatedAt: send.updatedAt, expiresAt: entitlement.expiresAt }
      send.state = 'failed'
      send.updatedAt = Date.now()
      entitlement.expiresAt = Math.max(entitlement.expiresAt, Date.now() + DAY)
      try { await this.persist() } catch (error) {
        send.state = previous.state; send.updatedAt = previous.updatedAt
        entitlement.expiresAt = previous.expiresAt
        throw error
      }
      return { code: room.code, seat: entry.seat }
    })
  }

  async clearSendNotFound(code: string, seat: number, id: string): Promise<void> {
    return this.serial(async () => {
      const send = this.rooms.get(code)?.entries.find(item => item.seat === seat)
        ?.entitlement?.sends.find(item => item.id === id)
      if (!send?.notFoundSince) return
      const previous = send.notFoundSince
      delete send.notFoundSince
      try { await this.persist() } catch (error) { send.notFoundSince = previous; throw error }
    })
  }

  /** Remove only records with no possible future credit or unpaid entitlement. */
  async collect(now = Date.now()): Promise<number> {
    return this.serial(async () => {
    const removed: PotRoom[] = []
    const dustBefore = this.dust.length
    for (const room of this.rooms.values()) {
      if (!room.closedAt || now - room.closedAt < 7 * 24 * 60 * 60_000) continue
      if (room.entries.some(entry =>
        !['prepared', 'failed', 'expired', 'completed'].includes(entry.state) ||
        (entry.state === 'completed' &&
          (!entry.entitlement && !(room.phase === 'resolved' && room.participants?.includes(entry.seat))) ||
          (entry.entitlement && !entry.entitlement.sends.some(send => send.state === 'completed'))) ||
        entry.entitlement?.sends.some(send => !['completed', 'failed'].includes(send.state)))) continue
      const residuals = room.entries.flatMap(entry => {
        const value = entry.entitlement
        if (!value) return []
        if (value.sends.some(send => send.state === 'completed' && !knownFee(send))) return [null]
        const spent = value.sends.filter(send => send.state === 'completed')
          .reduce((sum, send) => sum + send.amountMsat + actualFee(send), 0)
        return [{ entry, amountMsat: value.grossMsat - spent }]
      })
      if (residuals.some(value => !value || value.amountMsat < 0 || value.amountMsat >= 2000)) continue
      // Keep even sub-2-sat money as a compact, claim-bound liability record.
      for (const value of residuals) if (value && value.amountMsat) this.dust.push({
        code: room.code, seat: value.entry.seat, amountMsat: value.amountMsat,
        claimSalt: value.entry.claimSalt, claimHash: value.entry.claimHash, recordedAt: now,
      })
      removed.push(room)
      this.rooms.delete(room.code)
    }
    if (!removed.length) return 0
    try { await this.persist() } catch (error) {
      for (const room of removed) this.rooms.set(room.code, room)
      this.dust.length = dustBefore
      throw error
    }
    return removed.length
    })
  }

  private persist(): Promise<void> {
    const save = async () => {
      const parent = dirname(this.path)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, rooms: [...this.rooms.values()],
          dust: this.dust }))
        await handle.sync()
      } finally { await handle.close() }
      await rename(temp, this.path)
      const dir = await open(parent, 'r')
      try { await dir.sync() } finally { await dir.close() }
    }
    const queued = this.writeQueue.then(save)
    this.writeQueue = queued.catch(() => {})
    return queued
  }
}

const DAY = 24 * 60 * 60_000
function knownFee(send: PotSend): boolean {
  return send.totalFeeMsat !== undefined ||
    (send.networkFeeMsat !== undefined && send.processingFeeMsat !== undefined)
}
function actualFee(send: PotSend): number {
  return send.totalFeeMsat ?? ((send.networkFeeMsat ?? 0) + (send.processingFeeMsat ?? 0))
}
function entitlement(kind: PotEntitlement['kind'], grossMsat: number): PotEntitlement {
  // A fixed BOLT11 invoice is chosen before the route fee is known. Reserve a
  // bounded fee allowance from the gross; never promise wallet credit as cash.
  // Unused allowance remains an accounting liability until reconciled.
  const processingBps = Number(process.env.POT_PROCESSING_FEE_BPS ?? 0)
  const processingBudget = Math.ceil(grossMsat * processingBps / 10_000)
  const reserveMsat = Math.min(Math.floor(grossMsat / 4),
    Math.max(2000, Math.ceil(grossMsat * 0.02), processingBudget + 1000))
  if (grossMsat - reserveMsat < 1000) throw new Error('pot too small for fee budget')
  return { kind, grossMsat, amountMsat: grossMsat - reserveMsat,
    maxFeeMsat: reserveMsat - processingBudget,
    expiresAt: Date.now() + DAY, sends: [] }
}

export function hasPendingSend(value: PotEntitlement): boolean {
  return value.sends.some(send => ['uncertain', 'needs-reconcile', 'submitted', 'sending']
    .includes(send.state))
}

export function entitlementExpired(value: PotEntitlement, now = Date.now()): boolean {
  return now >= value.expiresAt && !hasPendingSend(value)
}

function nextPayout(value: PotEntitlement): { amountMsat: number; maxFeeMsat: number } | null {
  if (value.sends.some(send => send.state !== 'failed' && send.state !== 'completed')) return null
  const completed = value.sends.filter(send => send.state === 'completed')
  if (!completed.length) return { amountMsat: value.amountMsat, maxFeeMsat: value.maxFeeMsat }
  // Unknown actual fees cannot be treated as unspent funds. Keep the liability
  // in the ledger until Voltage reports its final breakdown or an operator
  // reconciles it.
  if (completed.some(send => !knownFee(send))) return null
  const spent = completed.reduce((sum, send) => sum + send.amountMsat +
    actualFee(send), 0)
  const residual = value.grossMsat - spent
  if (residual < 2000) return null
  const processingBps = Number(process.env.POT_PROCESSING_FEE_BPS ?? 0)
  const reserve = Math.min(Math.floor(residual / 2),
    Math.max(1000, Math.ceil(residual * 0.02), Math.ceil(residual * processingBps / 10_000) + 500))
  return { amountMsat: residual - reserve,
    maxFeeMsat: reserve - Math.ceil((residual - reserve) * processingBps / 10_000) }
}
