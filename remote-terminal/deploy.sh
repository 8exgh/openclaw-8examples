#!/usr/bin/env bash
# Dedicated canary service. Does not restart the browser broker or other Claws.
set -euo pipefail
: "${MOC_ROOT:?Set the live managed-openclaw checkout}"
: "${REMOTE_CONNECT_SERVICE_TOKEN:?Set the existing server-only service credential}"
: "${REMOTE_TERMINAL_HOST:?Set the fleet Tailscale address}"
test "${#REMOTE_CONNECT_SERVICE_TOKEN}" -ge 32
test -f "$MOC_ROOT/data/tenants.json"
CANARY=openclaw1
docker exec --user node --workdir /home/node/.openclaw/workspace "openclaw-$CANARY" python3 -c 'import pty, termios, fcntl; import os; assert os.getuid() == 1000; assert os.path.isfile("/bin/bash")'
HERE="$(cd "$(dirname "$0")" && pwd)"
REVISION=$(git -C "$HERE" rev-parse HEAD)
DEST="/opt/openclaw-remote-terminal/$REVISION"
install -d -m 0755 "$DEST/remote-terminal/plugin"
install -m 0644 "$HERE"/*.mjs "$HERE"/*.py "$HERE"/instructions.md "$DEST/remote-terminal/"
install -m 0644 "$HERE"/plugin/* "$DEST/remote-terminal/plugin/"
install -d -m 0700 /etc/openclaw
umask 077
cat > /etc/openclaw/remote-terminal.env <<ENV
MOC_ROOT=$MOC_ROOT
REMOTE_CONNECT_SERVICE_TOKEN=$REMOTE_CONNECT_SERVICE_TOKEN
REMOTE_TERMINAL_HOST=$REMOTE_TERMINAL_HOST
REMOTE_TERMINAL_PORT=18882
REMOTE_TERMINAL_TENANTS=openclaw1
REMOTE_CONNECT_PUBLIC_ORIGIN=https://8examples.com
ENV
cat > /etc/systemd/system/openclaw-remote-terminal.service <<UNIT
[Unit]
Description=8Examples remote terminal canary broker
After=docker.service network-online.target tailscaled.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/openclaw/remote-terminal.env
ExecStart=/usr/bin/node $DEST/remote-terminal/server.mjs
Restart=on-failure
RestartSec=5
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
MemoryMax=256M
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT
# Credentials are distinct from the browser's. Install only the explicit canary.
node --input-type=module - "$DEST/remote-terminal/workspace.mjs" <<'JS'
import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { installTerminalWorkspace } = await import(pathToFileURL(process.argv[2]));
const root = process.env.MOC_ROOT;
const tenant = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8')).find(t => t.id === 'openclaw1');
if (!tenant || tenant.offboardedAt || tenant.tier === 'desktop' || tenant.modelAccess === 'suppressed') throw new Error('Canary is not eligible');
const dir = path.join(root, 'tenants', tenant.id);
const backup = path.join(dir, 'config/openclaw.before-remote-terminal.json');
if (!existsSync(backup)) copyFileSync(path.join(dir, 'config/openclaw.json'), backup);
installTerminalWorkspace(dir, tenant.id);
console.log('Installed the terminal helper and runtime context for openclaw1 only.');
JS
docker exec --user node "openclaw-$CANARY" openclaw config validate --json
# After config validation, recover a failed in-process reload with a fresh
# gateway process. Restart only this unhealthy canary.
if ! docker exec --user node "openclaw-$CANARY" node -e "fetch('http://127.0.0.1:18789/healthz', {signal: AbortSignal.timeout(2000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
  docker restart --time 20 "openclaw-$CANARY"
fi
docker exec -i --user node "openclaw-$CANARY" node --input-type=module - <<'JS'
const healthy = async () => { try { return (await fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
for (let n = 0; n < 120 && !await healthy(); n++) await new Promise(resolve => setTimeout(resolve, 1000));
if (!await healthy()) throw new Error('Canary gateway did not recover after configuration repair');
console.log('Canary gateway is healthy and its installed configuration is valid.');
JS
systemctl daemon-reload
systemctl enable openclaw-remote-terminal.service
systemctl restart openclaw-remote-terminal.service
node --input-type=module - <<'JS'
const url = `http://${process.env.REMOTE_TERMINAL_HOST}:18882/health`;
for (let n = 0; n < 20; n++) {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.REMOTE_CONNECT_SERVICE_TOKEN}` }, signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      if ((await fetch(url)).status !== 401) throw new Error('Unauthenticated broker access');
      console.log('Terminal broker healthy; service authentication enforced.'); process.exit(0);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
throw new Error('Terminal broker health check failed');
JS
