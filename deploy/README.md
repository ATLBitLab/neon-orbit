# Neon Orbit dedicated server

This branch stacks on #39. The Node process hosts one or more two to four seat matches;
the process admits at most six connected players total. It listens on port 8080 and
Caddy terminates TLS and WebSocket traffic. No database is required. A restart ends
active rooms.

On a fresh Ubuntu 24.04 droplet, point an `sslip.io` hostname at its public IP:
`<IP_WITH_DASHES>.sslip.io` (for example, `192-0-2-4.sslip.io`). Open inbound
TCP 22, 80, and 443 in the DigitalOcean firewall. Install Node 22 LTS, npm, Git,
and Caddy. Then, as root:

```sh
apt-get update
apt-get install -y curl git caddy ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
useradd --system --home /opt/neon-orbit --shell /usr/sbin/nologin neon-orbit
git clone https://github.com/ATLBitLab/neon-orbit.git /opt/neon-orbit
cd /opt/neon-orbit
git fetch origin feat/server-rooms
git checkout feat/server-rooms
npm ci
npm run build:server
chown -R neon-orbit:neon-orbit /opt/neon-orbit
install -m 0644 deploy/neon-orbit.service /etc/systemd/system/neon-orbit.service
sed 's/GAME_HOSTNAME/192-0-2-4.sslip.io/' deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now neon-orbit
systemctl reload caddy
curl https://192-0-2-4.sslip.io/health
```

Replace the example hostname with the actual droplet IP before running `sed` and
`curl`. For IPv4, replace periods with dashes. The server must be pushed before
the droplet can fetch the branch. On updates, `git pull --ff-only`, `npm ci`,
`npm run build:server`, then `systemctl restart neon-orbit`.

Set `VITE_SERVER_URL=https://<hostname>` in the frontend build environment and
redeploy Vercel. For a temporary preview, append `?server=https://<hostname>&host=2`
to the client URL. The creator copies the room link from the wing panel; a second
browser opens it, chooses a hull, and joins. The creator launches once two people
are present. `?p2p=1&host=2` forces the original browser-hosted mode even when
`VITE_SERVER_URL` is set. A room closes after its result has been sent for ten
seconds, or immediately when everyone leaves. Lobby rooms expire after 30 minutes
without activity. There is no reconnect on this slice.

Use `journalctl -u neon-orbit -f` for server logs. `/health` returns room and
player counts. `POST /rooms` accepts `{"seats":2}` and returns a code; WebSocket
clients connect to `/ws?room=CODE`. Browser game frames remain the binary protocol
from `src/net/session.ts`; JSON control frames only create/start/report rooms.
