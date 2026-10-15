# Neon Orbit dedicated server

The deployed hostname is `104-131-185-100.sslip.io` on the Neon Orbit droplet
(`104.131.185.100`). Caddy terminates TLS and forwards WebSocket traffic to
Node on loopback port 8080. The process admits twelve connected players across
rooms, with two to four seats per match. Rooms live only in process memory.
Free-room match state lives only in process memory. During a running match, a dropped player's seat is held for 12 seconds. The
server gives each seat a 256-bit resume token after WELCOME; RETRY sends it
in the first WebSocket frame to reclaim that seat. The server rotates the token
after each successful resume. For one release, the previous client can still
present its token in `?resume=` during the upgrade. A room code alone cannot
join a running match.
The AI flies the seat while it is vacant, and a seat whose token expires stays
AI. If all players drop, the room closes when the last grace window expires.
Restarting the process ends all rooms and invalidates all tokens.

The match and client input run at 60 Hz. This listener sends a full world
snapshot every second tick (30 Hz), with no change to the browser-hosted WebRTC
protocol. `npm run check:bandwidth` enforces a 160 KB/s per-client
budget for mixed, all-Drone and all-Hornet synthetic four-player matches. Actual egress also includes
WebSocket/TLS overhead and varies with how many bolts are in flight; watch the
droplet's 500 GB monthly transfer allowance during playtests.

## Build locally and install on the droplet

From this repository branch on a development machine:

```sh
npm ci
npm run build:server
tar -czf /tmp/neon-orbit-server.tgz dist-server scripts/stats-summary.mjs package.json package-lock.json deploy/neon-orbit.service deploy/Caddyfile
scp /tmp/neon-orbit-server.tgz root@104.131.185.100:/tmp/
```

On the droplet (Ubuntu 24.04, Node 22, Caddy, and the `neonorbit` user already
exist), as root:

```sh
mkdir -p /opt/neon-orbit
tar -xzf /tmp/neon-orbit-server.tgz -C /opt/neon-orbit
cd /opt/neon-orbit
npm ci --omit=dev
chown -R neonorbit:neonorbit /opt/neon-orbit
install -m 0644 deploy/neon-orbit.service /etc/systemd/system/neon-orbit.service
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now neon-orbit
systemctl reload caddy
curl -fsS https://104-131-185-100.sslip.io/health
```

Repeat the local build, `scp`, extraction, `npm ci --omit=dev`, and
`systemctl restart neon-orbit` to update. The process runs as `neonorbit`, binds
only to loopback, and needs only the firewall's public 80/443 ports. A restart
ends active rooms. Check `journalctl -u neon-orbit -f` if health fails.
The [Caddy reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
documents the upstream client-IP header used for per-IP connection limits.

## Anonymous match stats

Every dedicated-server match appends anonymous JSONL to
`/var/lib/neon-orbit/match-stats.jsonl` (override with `STATS_PATH`; set it
empty to turn recording off). Each match writes one `match` line (random match
id, the hour it started, duration, outcome, hulls) and one `player` line per
human seat: hull, kills, deaths, shots/hits, time to first kill, seconds per
life, approximate hull damage taken, death positions rounded to 100 units, and
how the seat left (`end`, `quit`, `disconnect`). AI seats get no player line.
The only cross-match link is `session`, a random id the browser keeps in
sessionStorage and sends in its own frame before HELLO (never in the URL, so
no proxy log can pair it with an IP), so a repeat pick is visible while the
tab stays open. The file
never contains IPs, user agents, room codes, resume tokens, pubkeys or names;
`npm run check:stats` asserts that against a real listener. The file is capped
at `STATS_MAX_BYTES` (50 MB) with one rotation to `match-stats.jsonl.1`, and a
write failure is logged once and never reaches a match. Browser-hosted (P2P)
matches are not recorded. The wing panel tells players about the recording.

Summarise on the droplet:

```sh
node /opt/neon-orbit/scripts/stats-summary.mjs            # table per hull
node /opt/neon-orbit/scripts/stats-summary.mjs --json     # raw numbers
```

## Optional Bitcoin pot matches

`POT_ENABLED=0` is the service default. Keep it off until the payout branch has
passed independent review and the owner-authorized mainnet trial below. The
client shows a pot choice (10–1,000 sats), invoice QR and copy control, and
settled-seat status. A pot launches only after at least two present humans have
settled. It uses elimination: the last human alive wins; if several remain when
the squadron clears, their highest score wins; if none remain, the highest
human score wins. A tie breaks toward the lower seat number. AI cannot win.
Free rooms keep the existing `/rooms` and WebSocket behavior.

When the complete flow is ready, systemd's optional root-owned
`/etc/neon-orbit/pot.env` provides `POT_ENABLED=1`, `VOLTAGE_API_KEY`, and
`POT_PROCESSING_FEE_BPS`. Set that last value to the verified **send** fee rate
configured on the dedicated Voltage wallet, using `0` only if the dashboard
confirms no rate. Pot mode refuses to start without this explicit value; rates
above 1,000 basis points are refused. The fee reserve and wallet-available check
both include it. Recheck the setting if the wallet policy changes.
The server uses the dedicated mainnet `neon-orbit-pot` wallet and stores its
ledger at `/var/lib/neon-orbit/pot-ledger.json` (the service's `StateDirectory`).
The state directory is mode 0700 and the ledger file is mode 0600. The ledger contains payment IDs, invoice state, and salted hashes of private
seat claim credentials; it does not store those credentials or the API key.
Back up the state directory before replacing the droplet. A restart ends live
matches but keeps payment records for reconciliation and later refunds.

With the flag on, `POST /rooms` accepts an optional
`{"pot":{"buyInSats":100}}` (10–1000 sats). A seat receives its claim over
its own WebSocket after HELLO. `POST /pot` with `{"code":"…","seat":0}`
and `Authorization: Bearer <claim>` submits a fixed BOLT11 receive invoice;
`GET /pot?room=…&seat=0` with the same header polls settlement. The HTTP
responses distinguish `receiving` from `completed`; an accepted Voltage 202
is never treated as payment. An uncertain submit stays tied to its persisted
UUID and is reconciled by GET, never blindly reposted. A code-only late joiner
cannot inherit a claimed pot seat. The browser keeps its private seat claim in
local storage and proves it in the first WebSocket frame when reclaiming a
vacated paid seat. After creating a pot room, the host address becomes its
join link so reloading returns to that room. Room links contain the code and
server address, not the claim.

When the result is durably recorded, the winner gets a 24-hour claim bound to
that seat credential. The browser shows an LNURL-withdraw QR and a BOLT11
invoice input for wallets without LNURL-withdraw. Each short-lived LNURL `k1`
works once. A send UUID, invoice and fee cap are fsynced before one Voltage
POST; `202` is pending, never proof of payment. Status is verified by GET of
that same UUID. A failed send may be retried with a new invoice; an uncertain
one may only be reconciled, not reposted. If final fees leave at least 2 sats
from the allowance, the same authenticated browser offers a second, smaller
single-use withdrawal. Smaller or unreported residuals remain a ledger
liability for operator reconciliation. A restart, room error, or unlaunched
room expiry converts settled seats to refunds, including payments that settle
late. Leaving the wing explicitly cancels that paid lobby seat; if its owner
disconnects, the seat is refunded after ten minutes unless it is reclaimed.
Revisit the original room link in the same browser to retrieve a refund after
the room closes. The ledger retains every unresolved payment and unused
fee allowance rather than treating it as house revenue. Back it up and reconcile
residual fee allowances before considering a wallet balance free to spend.

The server uses `POT_PUBLIC_URL` (default
`https://104-131-185-100.sslip.io`) in LNURL callbacks. Set it to the exact
public HTTPS origin if the hostname changes. Caddy must proxy `/pot/claim`,
`/lnurlw`, and `/lnurlw/cb` as in `deploy/Caddyfile`.

Run `npm run check:pot` for loopback-only mocked Voltage and listener tests.
They use a fake key and make no mainnet requests.
`npm run check:pot-payout` covers winner/refund ledger transitions and an
ambiguous mocked send across a process restart.

### Owner-authorized mainnet trial (maximum 5,000 sats)

Run only after independent review of this payout PR, while the server has zero
active rooms. The owner authorized the Project Manager to use up to 5,000 sats
from the `atlbitlab` wallet for this trial; no automated test or developer
session should use that wallet. Keep the dedicated `neon-orbit-pot` wallet's
credit limit at zero. Confirm its mainnet network, available BTC balance,
send policies, and the `VOLTAGE_API_KEY` environment key using the Voltage
dashboard without printing the key. Back up `/var/lib/neon-orbit/pot-ledger.json`
securely before switching the flag.

1. In root-owned `/etc/neon-orbit/pot.env`, set `POT_ENABLED=1`, set the
   verified `POT_PROCESSING_FEE_BPS`, and keep the existing key.
   `chmod 0600 /etc/neon-orbit/pot.env`; restart `neon-orbit` and
   check `/health` reports `potEnabled:true`. Do not put the key in git or a
   shell command history. Abort if startup or reconciliation logs an error.
2. Create a 100-sat pot from the production HOST GAME control. Have two test
   seats pay their exact invoices from the approved `atlbitlab` wallet. Before
   launch, verify both show **PAID**, never merely "invoice created" or 202.
   Fly to an elimination result. The winner scans the LNURL-withdraw QR or
   pastes a fixed-amount mainnet BOLT11 invoice for the displayed amount.
   Verify `GET /pot/claim` in that authenticated browser reaches `completed`
   with a payment UUID; check the same UUID in the Voltage dashboard.
3. Create a second 100-sat pot and pay only one seat. Close its tabs and wait
   for the ten-minute empty-room expiry. Reopen its room link on the same
   browser; the claim panel should offer a refund. Withdraw it and verify its
   distinct Voltage send UUID is completed. This trial uses about 300 sats of
   buy-ins, leaving room under the 5,000-sat authorization for fees and one
   retry. Never send a second payment to compensate for an uncertain first;
   reconcile the persisted UUID first.
4. Set `POT_ENABLED=0` in the root-owned environment file and restart only
   after all active rooms have ended. Confirm `/pot` returns 404, free room
   creation/launch still works, and `journalctl -u neon-orbit` has no payout
   errors. Record each buy-in and send UUID, actual fees, and any unpaid fee
   residual from the ledger. Keep the ledger backup until reconciled.

## Client preview

Set `VITE_SERVER_URL=https://104-131-185-100.sslip.io` in the Vercel build
environment and deploy this branch, or append
`?server=https://104-131-185-100.sslip.io&host=2` to a local/preview client
URL. The creator copies the room link from the wing panel. A second browser
opens that link, selects a hull, joins the room, and the creator launches once
both players appear. `?p2p=1&host=2` selects browser-hosted WebRTC mode even
when `VITE_SERVER_URL` is configured.

`/health` reports room and player counts. `POST /rooms` accepts `{"seats":2}`
and returns a code. WebSocket clients connect to `/ws?room=CODE`; game frames
use the existing binary session protocol, while JSON control frames handle
room launch and hull changes. A finished room closes ten seconds after its
result. An empty running room waits for its last resume window before closing;
an unjoined room expires after
about one minute; occupied lobbies expire after 30 minutes of inactivity.
One IP may create at most three rooms and hold six connections, while the
server allows twelve players globally so a shared Wi-Fi can fill a room
without excluding other IPs. A resume token is private to its seat and is never
included in the copied room link.
