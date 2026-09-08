#!/usr/bin/env bash
# Run on the fleet host as root, from a reviewed checkout of this repo.
# Requires MOC_ROOT, REMOTE_CONNECT_SERVICE_TOKEN, REMOTE_CONNECT_HOST.
set -euo pipefail
: "${MOC_ROOT:?Set MOC_ROOT to the live managed-openclaw checkout}"
: "${REMOTE_CONNECT_SERVICE_TOKEN:?Set the website/broker shared service token}"
: "${REMOTE_CONNECT_HOST:?Set the fleet host Tailscale IP}"
test "${#REMOTE_CONNECT_SERVICE_TOKEN}" -ge 32
test -f "$MOC_ROOT/data/tenants.json"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/openclaw-remote-connect
install -d -m 0755 "$DEST/remote-connect" "$DEST/templates/workspace/remote-connect" "$DEST/templates/workspace/skills/remote-login"
install -m 0644 "$HERE"/remote-connect/*.mjs "$DEST/remote-connect/"
install -d -m 0755 "$DEST/remote-connect/plugin"
install -m 0644 "$HERE"/remote-connect/plugin/* "$DEST/remote-connect/plugin/"
install -m 0644 "$HERE"/templates/workspace/remote-connect/* "$DEST/templates/workspace/remote-connect/"
install -m 0644 "$HERE/templates/workspace/skills/remote-login/SKILL.md" "$DEST/templates/workspace/skills/remote-login/"
install -d -m 0700 /etc/openclaw
umask 077
cat > /etc/openclaw/remote-connect.env <<ENV
MOC_ROOT=$MOC_ROOT
REMOTE_CONNECT_SERVICE_TOKEN=$REMOTE_CONNECT_SERVICE_TOKEN
REMOTE_CONNECT_HOST=$REMOTE_CONNECT_HOST
REMOTE_CONNECT_PORT=18880
REMOTE_CONNECT_PUBLIC_ORIGIN=https://8examples.com
ENV
cat > /etc/systemd/system/openclaw-remote-connect.service <<UNIT
[Unit]
Description=8Examples remote browser login broker
After=docker.service network-online.target tailscaled.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/openclaw/remote-connect.env
ExecStart=/usr/bin/node $DEST/remote-connect/server.mjs
Restart=on-failure
RestartSec=5
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
MemoryMax=512M
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable openclaw-remote-connect.service
systemctl restart openclaw-remote-connect.service
node "$DEST/remote-connect/sync-workspaces.mjs" "${REMOTE_CONNECT_TENANT:-}"
# Do not print the secret into command lines or curl diagnostics.
node --input-type=module - <<'JS'
const url = `http://${process.env.REMOTE_CONNECT_HOST}:18880/health`;
let ready = false;
for (let n = 0; n < 20; n++) {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.REMOTE_CONNECT_SERVICE_TOKEN}` }, signal: AbortSignal.timeout(1000) });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error('Remote broker did not become healthy');
const unauthenticated = await fetch(url);
if (unauthenticated.status !== 401) throw new Error('Broker must require authentication');
console.log('Remote broker is healthy; unauthenticated access is denied.');
JS
