# Neon Orbit dedicated server

The deployed hostname is `104-131-185-100.sslip.io` on the Neon Orbit droplet
(`104.131.185.100`). Caddy terminates TLS and forwards WebSocket traffic to
Node on loopback port 8080. The process admits twelve connected players across
rooms, with two to four seats per match. Rooms live only in process memory.

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
tar -czf /tmp/neon-orbit-server.tgz dist-server package.json package-lock.json deploy/neon-orbit.service deploy/Caddyfile
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
result, and an empty room closes immediately. An unjoined room expires after
about one minute; occupied lobbies expire after 30 minutes of inactivity.
One IP may create at most three rooms and hold six connections, while the
server allows twelve players globally so a shared Wi-Fi can fill a room
without excluding other IPs. There is no reconnect in this slice.
