const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i]
  }
  return chk
}

function words(bytes: Uint8Array): number[] {
  const out: number[] = []
  let acc = 0, bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31) }
  }
  if (bits) out.push((acc << (5 - bits)) & 31)
  return out
}

/** LUD-03 encodes the HTTPS withdraw endpoint as an uppercase bech32 LNURL. */
export function encodeLnurl(url: string): string {
  if (!url.startsWith('https://')) throw new Error('LNURL withdraw needs HTTPS')
  const hrp = 'lnurl'
  const data = words(new TextEncoder().encode(url))
  const chars = [...hrp].map(char => char.charCodeAt(0))
  const checksum = polymod(chars.map(char => char >>> 5)
    .concat([0], chars.map(char => char & 31), data, Array(6).fill(0))) ^ 1
  for (let i = 0; i < 6; i++) data.push((checksum >>> (5 * (5 - i))) & 31)
  return `${hrp}1${data.map(value => ALPHABET[value]).join('')}`.toUpperCase()
}

/** Read only network and fixed amount; Voltage remains the invoice verifier. */
export function fixedMainnetInvoiceAmount(invoice: string): number | null {
  if (invoice.length > 5000 || invoice.length < 60 || !/^[a-z0-9]+$/i.test(invoice)) return null
  const hrp = invoice.toLowerCase().slice(0, invoice.lastIndexOf('1'))
  const match = /^lnbc(\d+)([munp]?)$/.exec(hrp)
  if (!match) return null
  const units: Record<string, bigint> = { '': 100_000_000_000n, m: 100_000_000n,
    u: 100_000n, n: 100n, p: 1n }
  const amount = BigInt(match[1]) * units[match[2]]
  const msats = match[2] === 'p' ? amount / 10n : amount
  if (match[2] === 'p' && amount % 10n !== 0n) return null
  return msats > 0n && msats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(msats) : null
}
