#!/usr/bin/env bash
# Install the Rocket.Chat <-> OpenClaw bridge as a systemd service on the box
# that runs the openclaw-* containers (the datacenter box). Run with sudo.
#
# Config comes from /etc/openclaw/rc-bridge.env (created below if absent).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

install -d -m 0755 /opt/openclaw-rc-bridge
install -m 0644 "$HERE/bridge.mjs" /opt/openclaw-rc-bridge/bridge.mjs

install -d -m 0700 /etc/openclaw
if [ ! -f /etc/openclaw/rc-bridge.env ]; then
  cat > /etc/openclaw/rc-bridge.env <<'ENV'
# Rocket.Chat base URL the bridge posts replies to (public URL or LAN IP).
RC_URL=https://chat.fusenv.com
# Bridge bot account (created by provision.mjs).
RC_BOT_USER=openclaw-bridge
RC_BOT_PASS=openclaw-bridge-pass
# Shared secret; must match the outgoing-webhook token in Rocket.Chat.
WEBHOOK_TOKEN=changeme-hook-token
# Port the bridge listens on for Rocket.Chat's outgoing webhook.
BRIDGE_PORT=8090
CONTAINER_PREFIX=openclaw-
ENV
  chmod 0600 /etc/openclaw/rc-bridge.env
  echo "Created /etc/openclaw/rc-bridge.env — fill in RC_BOT_PASS / WEBHOOK_TOKEN to match provisioning."
fi

cat > /etc/systemd/system/openclaw-rc-bridge.service <<'UNIT'
[Unit]
Description=Rocket.Chat <-> OpenClaw bridge
After=docker.service network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/openclaw/rc-bridge.env
ExecStart=/usr/bin/node /opt/openclaw-rc-bridge/bridge.mjs
Restart=on-failure
RestartSec=5
# needs docker CLI access to exec the openclaw-* containers
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now openclaw-rc-bridge.service
sleep 2
systemctl --no-pager status openclaw-rc-bridge.service | head -6 || true
