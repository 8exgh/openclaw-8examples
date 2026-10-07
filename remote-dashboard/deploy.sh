#!/usr/bin/env bash
set -euo pipefail
: "${MOC_ROOT:?Set the live managed-openclaw checkout}"
: "${REMOTE_CONNECT_SERVICE_TOKEN:?Set the existing server-only service credential}"
: "${REMOTE_DASHBOARD_HOST:?Set the private fleet Tailscale address}"
: "${REMOTE_DASHBOARD_TENANTS:?Comma-separated tenants to enable}"
[[ "$REMOTE_DASHBOARD_TENANTS" =~ ^[a-z0-9][a-z0-9-]*(,[a-z0-9][a-z0-9-]*)*$ ]]
test "${#REMOTE_CONNECT_SERVICE_TOKEN}" -ge 32
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REVISION="${REMOTE_DASHBOARD_REVISION:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$REVISION" =~ ^[a-zA-Z0-9-]+$ ]]
DEST="/opt/openclaw-remote-dashboard/$REVISION"
install -d -m 0755 "$DEST/remote-dashboard/plugin" "$DEST/remote-connect" "$DEST/owner-state"
install -m 0644 "$HERE"/remote-dashboard/*.mjs "$HERE"/remote-dashboard/instructions.md "$DEST/remote-dashboard/"
install -m 0644 "$HERE"/remote-dashboard/package*.json "$DEST/remote-dashboard/"
npm ci --prefix "$DEST/remote-dashboard" --omit=dev --ignore-scripts --no-audit --no-fund
install -m 0644 "$HERE"/remote-dashboard/plugin/* "$DEST/remote-dashboard/plugin/"
install -m 0644 "$HERE"/remote-connect/*.mjs "$DEST/remote-connect/"
install -m 0644 "$HERE"/owner-state/*.mjs "$DEST/owner-state/"

# Installation uses the owner-state merger and backups. Only the explicitly
# enabled tenants gain this helper, credential, and private-chat runtime hook.
node --input-type=module - "$DEST/remote-dashboard/workspace.mjs" <<'JS'
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { installDashboardWorkspace } = await import(pathToFileURL(process.argv[2]));
const root = process.env.MOC_ROOT;
const tenants = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8'));
const enabled = process.env.REMOTE_DASHBOARD_TENANTS.split(',');
for (const id of enabled) {
  const tenant = tenants.find(t => t.id === id);
  if (!tenant || tenant.offboardedAt || tenant.modelAccess === 'suppressed' || tenant.tier === 'desktop') throw new Error(`Ineligible tenant: ${id}`);
}
for (const id of enabled) { installDashboardWorkspace(path.join(root, 'tenants', id), id); console.log(`Installed dashboard handoff for ${id}.`); }
JS
IFS=',' read -r -a DASHBOARD_TENANTS <<< "$REMOTE_DASHBOARD_TENANTS"
for tenant in "${DASHBOARD_TENANTS[@]}"; do
  docker exec --user node "openclaw-$tenant" openclaw config validate --json
  # Require sustained health across the delayed plugin reload. Restart only
  # a selected gateway that stays unhealthy; never bounce a healthy tenant.
  healthy=0
  restarted=0
  for attempt in $(seq 1 45); do
    if docker exec --user node "openclaw-$tenant" node -e "fetch('http://127.0.0.1:18789/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      healthy=$((healthy + 1))
      if test "$healthy" -ge 8; then break; fi
    else
      healthy=0
      if test "$attempt" -ge 5 && test "$restarted" -eq 0; then
        docker restart --timeout 20 "openclaw-$tenant"
        restarted=1
      fi
    fi
    sleep 2
  done
  test "$healthy" -ge 8 || { echo "Selected gateway did not become healthy" >&2; exit 1; }

done
install -d -m 0700 /etc/openclaw
umask 077
cat > /etc/openclaw/remote-dashboard.env <<ENV
MOC_ROOT=$MOC_ROOT
REMOTE_CONNECT_SERVICE_TOKEN=$REMOTE_CONNECT_SERVICE_TOKEN
REMOTE_DASHBOARD_HOST=$REMOTE_DASHBOARD_HOST
REMOTE_DASHBOARD_PORT=18884
REMOTE_DASHBOARD_TENANTS=$REMOTE_DASHBOARD_TENANTS
REMOTE_CONNECT_PUBLIC_ORIGIN=https://8examples.com
ENV
cat > /etc/systemd/system/openclaw-remote-dashboard.service <<UNIT
[Unit]
Description=8Examples temporary OpenClaw dashboard broker
After=docker.service network-online.target tailscaled.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/openclaw/remote-dashboard.env
ExecStart=/usr/bin/node $DEST/remote-dashboard/server.mjs
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
systemctl daemon-reload
systemctl enable openclaw-remote-dashboard.service
systemctl restart openclaw-remote-dashboard.service
node --input-type=module - <<'JS'
const url = `http://${process.env.REMOTE_DASHBOARD_HOST}:18884/health`;
for (let i = 0; i < 20; i++) {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.REMOTE_CONNECT_SERVICE_TOKEN}` }, signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      if ((await fetch(url)).status !== 401) throw new Error('Unauthenticated broker access');
      console.log('Dashboard broker healthy; service authentication enforced.'); process.exit(0);
    }
  } catch { /* wait for startup */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
throw new Error('Dashboard broker health check failed');
JS
