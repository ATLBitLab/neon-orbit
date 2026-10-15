import { execFileSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { PotLedger } from './pot-ledger'

// Offline only. The operator must first establish in Voltage that this exact
// UUID never executed; a GET 404 alone is not sufficient evidence.
const id = process.argv[2] ?? ''
if (process.getuid?.() !== 0 || !process.setgid || !process.setuid) {
  throw new Error('pot reconciliation requires root on a Unix host')
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    process.argv[3] !== '--confirmed-absent' || process.argv.length !== 4) {
  throw new Error('usage: pot-reconcile <payment-uuid> --confirmed-absent')
}
try {
  execFileSync('/usr/bin/systemctl', ['is-active', '--quiet', 'neon-orbit'], { stdio: 'ignore' })
  throw new Error('stop neon-orbit before modifying the ledger')
} catch (error) {
  // systemctl returns 3 only for an inactive unit. Any other failure, or an
  // active service, must not allow an offline write racing the listener.
  if ((error as { status?: number }).status !== 3) throw error
}
const path = process.env.POT_LEDGER_PATH ?? '/var/lib/neon-orbit/pot-ledger.json'
const owner = await stat(path)
if (owner.uid === 0 || (owner.mode & 0o077) !== 0) {
  throw new Error('pot ledger must be private and owned by the service user')
}
// Keep the replacement ledger file readable by neonorbit after the offline
// write. Root access is needed to enter this command, not for the file write.
process.setgid(owner.gid)
process.setuid(owner.uid)
const ledger = await PotLedger.open(path)
const result = await ledger.failAbsentSend(id)
console.log(JSON.stringify({ paymentId: id, room: result.code, seat: result.seat, state: 'failed' }))
