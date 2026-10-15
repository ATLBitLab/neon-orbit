import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { open, readFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ReceiveState = 'prepared' | 'submitted' | 'uncertain' | 'receiving' | 'completed' | 'failed' | 'expired'

export interface PotSeat {
  seat: number
  paymentId: string
  claimSalt: string
  claimHash: string
  state: ReceiveState
  invoice: string | null
  createdAt: number
  updatedAt: number
}

export interface PotRoom {
  code: string
  seats: number
  buyInSats: number
  createdAt: number
  entries: PotSeat[]
}

interface LedgerFile { version: 1; rooms: PotRoom[] }

function hashClaim(secret: string, salt: string): Buffer {
  // The claim itself has 256 random bits, so a fast one-way hash is safe and
  // avoids letting unauthenticated status requests stall the game loop.
  return createHash('sha256').update(salt).update(secret).digest()
}

export class PotLedger {
  private readonly rooms = new Map<string, PotRoom>()
  private writeQueue: Promise<void> = Promise.resolve()

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
    return ledger
  }

  getRoom(code: string): PotRoom | undefined { return this.rooms.get(code) }
  listRooms(): PotRoom[] { return [...this.rooms.values()] }

  async createRoom(code: string, seats: number, buyInSats: number): Promise<PotRoom> {
    if (!Number.isInteger(seats) || seats < 2 || seats > 4 ||
        !Number.isInteger(buyInSats) || buyInSats < 1 || buyInSats > 1000) {
      throw new Error('invalid pot room')
    }
    if (this.rooms.has(code)) throw new Error('pot room already exists')
    const room: PotRoom = { code, seats, buyInSats, createdAt: Date.now(), entries: [] }
    this.rooms.set(code, room)
    try { await this.persist() } catch (error) { this.rooms.delete(code); throw error }
    return room
  }

  // A seat receives an independent, durable claim credential. This is never a
  // 12-second match resume token and is returned only at initial assignment.
  async prepareSeat(code: string, seat: number): Promise<{ entry: PotSeat; claim: string }> {
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
  }

  ownsSeat(code: string, seat: number, claim: string): boolean {
    const entry = this.rooms.get(code)?.entries.find(item => item.seat === seat)
    if (!entry || !/^[A-Za-z0-9_-]{43}$/.test(claim)) return false
    const actual = hashClaim(claim, entry.claimSalt)
    return timingSafeEqual(actual, Buffer.from(entry.claimHash, 'hex'))
  }

  async update(code: string, seat: number, state: ReceiveState, invoice?: string): Promise<PotSeat> {
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
  }

  private persist(): Promise<void> {
    const save = async () => {
      const parent = dirname(this.path)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }))
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
