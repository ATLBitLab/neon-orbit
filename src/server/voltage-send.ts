import type { PotLedger, PotSend } from './pot-ledger'
import type { VoltageConfig } from './voltage-receive'

interface Payment {
  id: string
  wallet_id: string
  organization_id: string
  environment_id: string
  direction: string
  type: string
  status: string
  data?: { amount?: { currency: string; amount: number };
    fees?: { currency: string; unit: string; amount: number } | null }
  payment_breakdown?: {
    network_fee?: { currency: string; unit: string; amount: number }
    processing_fee?: { currency: string; unit: string; amount: number }
  } | null
}

/** A send ID is durable before its first POST. An uncertain POST is GET-only. */
export class VoltageSend {
  private readonly submissions = new Map<string, Promise<PotSend>>()
  private readonly warnedReconciles = new Set<string>()
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
    return new URL(`/organizations/${organizationId}/environments/${environmentId}/payments` +
      (id ? `/${id}` : ''), baseUrl).toString()
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return this.fetcher(url, { ...init, headers: {
      'x-api-key': this.config.apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    }, signal: AbortSignal.timeout(5000) })
  }

  async submit(code: string, seat: number, id: string): Promise<PotSend> {
    const entry = this.ledger.getRoom(code)?.entries.find(item => item.seat === seat)
    const send = entry?.entitlement?.sends.find(item => item.id === id)
    if (!send) throw new Error('send unavailable')
    const active = this.submissions.get(id)
    if (active) return active
    if (send.state !== 'prepared') return send
    const task = this.submitPrepared(code, seat, send)
    this.submissions.set(id, task)
    try { return await task } finally { this.submissions.delete(id) }
  }

  private async submitPrepared(code: string, seat: number, send: PotSend): Promise<PotSend> {
    // The wallet has no credit line. Check spendable BTC on every attempt, not
    // its nominal limit or total balance; processing fees are additional.
    try {
    const walletUrl = new URL(`/organizations/${this.config.organizationId}/wallets/${this.config.walletId}`,
      this.config.baseUrl).toString()
    const walletResponse = await this.request(walletUrl, { method: 'GET' })
    if (!walletResponse.ok) throw new Error('wallet balance unavailable')
    const wallet = await walletResponse.json() as { id?: string; network?: string; balances?: {
      currency?: string; network?: string; available?: { amount?: number; unit?: string; negative?: boolean }
    }[] }
    const available = wallet.balances?.find(balance => balance.currency === 'btc' &&
      (balance.network === undefined || balance.network === 'mainnet') &&
      balance.available?.unit === 'msats' && !balance.available.negative)?.available?.amount
    const processingBound = Math.ceil(send.amountMsat * Number(process.env.POT_PROCESSING_FEE_BPS ?? 0) / 10_000)
    if (wallet.id !== this.config.walletId || wallet.network !== 'mainnet' ||
        !Number.isSafeInteger(available) ||
        available! < send.amountMsat + send.maxFeeMsat + processingBound) {
      throw new Error('pot wallet lacks confirmed spendable funds and fee reserve')
    }
    } catch (error) {
      // No POST was attempted: release the entitlement for a fresh LNURL invoice.
      await this.ledger.updateSend(code, seat, send.id, 'failed')
      throw error
    }
    // Persist an attempted write before making it. Even an empty 202 is only
    // accepted; no client sees "paid" until a matching GET says completed.
    await this.ledger.updateSend(code, seat, send.id, 'uncertain')
    const body = {
      id: send.id, wallet_id: this.config.walletId, currency: 'btc', type: 'bolt11',
      data: { payment_request: send.invoice,
        amount: { currency: 'btc', amount: send.amountMsat, unit: 'msats' },
        max_fee: { currency: 'btc', amount: send.maxFeeMsat, unit: 'msats' } },
      metadata: { external_id: `neon-orbit:${code}:${seat}` },
    }
    let response: Response
    try { response = await this.request(this.paymentUrl(), { method: 'POST', body: JSON.stringify(body) }) }
    catch { return send }
    if (response.status === 202 || response.status === 409) {
      await this.ledger.updateSend(code, seat, send.id, 'submitted')
    } else if (response.status === 400 || response.status === 422) {
      // These validation responses reject the request before execution. An
      // unrelated 5xx/timeout remains uncertain and must be reconciled by ID.
      await this.ledger.updateSend(code, seat, send.id, 'failed')
    }
    return send
  }

  async poll(code: string, seat: number, id: string): Promise<PotSend> {
    const send = this.ledger.getRoom(code)?.entries.find(item => item.seat === seat)
      ?.entitlement?.sends.find(item => item.id === id)
    if (!send) throw new Error('send unavailable')
    if (send.state === 'completed' || send.state === 'failed') return send
    let response: Response
    try { response = await this.request(this.paymentUrl(id), { method: 'GET' }) }
    catch { return send }
    if (response.status === 404) {
      const current = await this.ledger.noteSendNotFound(code, seat, id)
      if (current.state === 'needs-reconcile' && !this.warnedReconciles.has(id)) {
        console.error('[neon-orbit] pot payout needs reconciliation', { room: code, seat, paymentId: id })
        this.warnedReconciles.add(id)
      }
      return current
    }
    if (!response.ok) return send
    let payment: Payment
    try { payment = await response.json() as Payment } catch { return send }
    if (payment.id !== id || payment.wallet_id !== this.config.walletId ||
        payment.organization_id !== this.config.organizationId ||
        payment.environment_id !== this.config.environmentId ||
        payment.direction !== 'send' || payment.type !== 'bolt11' ||
        (payment.data?.amount &&
        (payment.data.amount.currency !== 'btc' || payment.data.amount.amount !== send.amountMsat))) return send
    await this.ledger.clearSendNotFound(code, seat, id)
    if (payment.status === 'completed') {
      const fee = (value: { currency: string; unit: string; amount: number } | undefined) =>
        value?.currency === 'btc' && value.unit === 'msats' && Number.isSafeInteger(value.amount) &&
        value.amount >= 0 ? value.amount : null
      const network = fee(payment.payment_breakdown?.network_fee)
      const processing = fee(payment.payment_breakdown?.processing_fee)
      const total = fee(payment.data?.fees ?? undefined)
      // data.fees is the aggregate network/provider *plus* processing fee.
      // If the breakdown is absent, store its known total in one bucket; no
      // residual can be overstated by pretending the total excludes processing.
      const fees = network !== null && processing !== null
        ? { networkFeeMsat: network, processingFeeMsat: processing,
          totalFeeMsat: network + processing }
        : total !== null ? { totalFeeMsat: total } : undefined
      return this.ledger.updateSend(code, seat, id, 'completed', fees)
    }
    if (payment.status === 'failed') return this.ledger.updateSend(code, seat, id, 'failed')
    if (payment.status === 'sending' || payment.status === 'approved') {
      return this.ledger.updateSend(code, seat, id, 'sending')
    }
    return send
  }

  async pollBounded(code: string, seat: number, id: string): Promise<PotSend> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const send = await this.poll(code, seat, id)
      if (send.state === 'completed' || send.state === 'failed') return send
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
    return this.ledger.getRoom(code)!.entries.find(item => item.seat === seat)!
      .entitlement!.sends.find(item => item.id === id)!
  }
}
