import type { PotLedger, PotSeat } from './pot-ledger'

export interface VoltageConfig {
  baseUrl: string
  organizationId: string
  environmentId: string
  walletId: string
  apiKey: string
}

interface Payment {
  id: string
  wallet_id: string
  organization_id: string
  environment_id: string
  direction: string
  type: string
  status: string
  requested_amount?: { currency: string; amount: number }
  data?: { payment_request?: string | null; amount?: { currency: string; amount: number } }
}

export class VoltageReceive {
  private readonly submissions = new Map<string, Promise<PotSeat>>()
  constructor(private readonly ledger: PotLedger, private readonly config: VoltageConfig,
    private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(config.baseUrl)
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('Voltage API requires HTTPS')
    }
    if (!config.apiKey) throw new Error('Voltage API key missing')
  }

  private paymentUrl(id?: string): string {
    const { baseUrl, organizationId, environmentId } = this.config
    const path = `/organizations/${organizationId}/environments/${environmentId}/payments`
    return new URL(path + (id ? `/${id}` : ''), baseUrl).toString()
  }

  // A timeout applies to every external read/write. No POST is retried after
  // an ambiguous outcome: the persisted UUID is the reconciliation key.
  private async request(url: string, init: RequestInit): Promise<Response> {
    return this.fetcher(url, { ...init, headers: {
      'x-api-key': this.config.apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    }, signal: AbortSignal.timeout(5000) })
  }

  async submit(code: string, seat: number): Promise<PotSeat> {
    const room = this.ledger.getRoom(code)
    const entry = room?.entries.find(item => item.seat === seat)
    if (!room || !entry) throw new Error('payment not prepared')
    const active = this.submissions.get(entry.paymentId)
    if (active) return active
    if (entry.state !== 'prepared') return entry
    const submission = this.submitPrepared(code, seat, entry, room.buyInSats)
    this.submissions.set(entry.paymentId, submission)
    try { return await submission } finally { this.submissions.delete(entry.paymentId) }
  }

  private async submitPrepared(code: string, seat: number, entry: PotSeat, buyInSats: number): Promise<PotSeat> {
    const body = {
      id: entry.paymentId,
      wallet_id: this.config.walletId,
      payment_kind: 'bolt11',
      amount: { currency: 'btc', amount: buyInSats * 1000 },
      description: `Neon Orbit pot ${code} seat ${seat}`,
      expiration: 600,
      metadata: { external_id: `${code}:${seat}` },
    }
    // The UUID was fsynced by prepareSeat before this point. Mark the attempt
    // before the write so a crash cannot cause a duplicate POST on restart.
    await this.ledger.update(code, seat, 'uncertain')
    let response: Response
    try { response = await this.request(this.paymentUrl(), { method: 'POST', body: JSON.stringify(body) }) }
    catch { return entry }
    if (response.status === 202 || response.status === 409) {
      // 202 only acknowledges the request; it never means invoice or payment.
      await this.ledger.update(code, seat, 'submitted')
    }
    // Other outcomes remain uncertain until GET by the same persisted ID.
    return entry
  }

  async poll(code: string, seat: number): Promise<PotSeat> {
    const room = this.ledger.getRoom(code)
    const entry = room?.entries.find(item => item.seat === seat)
    if (!room || !entry) throw new Error('payment not prepared')
    if (entry.state === 'completed' || entry.state === 'failed' || entry.state === 'expired') return entry
    let response: Response
    try { response = await this.request(this.paymentUrl(entry.paymentId), { method: 'GET' }) }
    catch { return entry }
    if (!response.ok) return entry
    let payment: Payment
    try { payment = await response.json() as Payment } catch { return entry }
    if (payment.id !== entry.paymentId || payment.wallet_id !== this.config.walletId ||
        payment.organization_id !== this.config.organizationId ||
        payment.environment_id !== this.config.environmentId ||
        payment.direction !== 'receive' || payment.type !== 'bolt11') return entry
    const amount = payment.requested_amount ?? payment.data?.amount
    if (amount?.currency !== 'btc' || amount.amount !== room.buyInSats * 1000) return entry
    const invoice = payment.data?.payment_request
    switch (payment.status) {
      case 'generating': return entry
      case 'receiving':
        if (typeof invoice === 'string' && invoice.startsWith('ln')) {
          return this.ledger.update(code, seat, 'receiving', invoice)
        }
        return entry
      case 'completed':
        // A completed payment is the only state that admits a paid seat.
        return this.ledger.update(code, seat, 'completed', typeof invoice === 'string' ? invoice : undefined)
      case 'expired': return this.ledger.update(code, seat, 'expired')
      case 'failed': return this.ledger.update(code, seat, 'failed')
      default: return entry
    }
  }

  async pollUntilInvoice(code: string, seat: number, attempts = 8, delayMs = 500): Promise<PotSeat> {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('invalid poll bound')
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = await this.poll(code, seat)
      if (entry.invoice || entry.state === 'completed' || entry.state === 'failed' || entry.state === 'expired') return entry
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs))
    }
    return this.ledger.getRoom(code)!.entries.find(item => item.seat === seat)!
  }
}
