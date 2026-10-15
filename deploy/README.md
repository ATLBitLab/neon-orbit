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
protocol. `npm run check:bandwidth` enforces a representative 130 KB/s per-client
budget for a synthetic four-player active match. Actual egress also includes
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

## Pot payment lobby (disabled until payout/refunds ship)

`POT_ENABLED=0` is the service default. Do **not** enable pot rooms from this
branch: they can receive invoices but deliberately cannot launch yet. The
client shows a pot choice, invoice QR and copy control, and settled-seat status;
authoritative results, payout, and refunds come in the next PR.
Free rooms keep the existing `/rooms` and WebSocket behavior.

When the complete flow is ready, systemd's optional root-owned
`/etc/neon-orbit/pot.env` provides `POT_ENABLED=1` and `VOLTAGE_API_KEY`.
The server uses the dedicated mainnet `neon-orbit-pot` wallet and stores its
ledger at `/var/lib/neon-orbit/pot-ledger.json` (the service's `StateDirectory`).
The state directory is mode 0700 and the ledger file is mode 0600. The ledger contains payment IDs, invoice state, and salted hashes of private
seat claim credentials; it does not store those credentials or the API key.
Back up the state directory before replacing the droplet. A restart ends live
matches but keeps payment records for reconciliation and later refunds.

With the flag on, `POST /rooms` accepts an optional
`{"pot":{"buyInSats":100}}` (1–1000 sats). A seat receives its claim over
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
server address, not the claim. Even after every seat pays, LAUNCH remains
disabled until payout and refund handling is ready.

Run `npm run check:pot` for loopback-only mocked Voltage and listener tests.
They use a fake key and make no mainnet requests.

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
