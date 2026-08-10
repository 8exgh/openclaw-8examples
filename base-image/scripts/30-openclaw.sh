#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Node 22 LTS (OpenClaw requires >= 22)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs

# OpenClaw + Claude Code CLI (the CLI provides `claude setup-token`, and
# OpenClaw reuses a local Claude login when one exists).
npm install -g openclaw@latest @anthropic-ai/claude-code@latest

# Provisioning runs as root with HOME preserved (sudo -E) — pin HOME to /root
# so these first-run version checks can't seed root-owned state into the
# agent user's home (openclaw/claude create ~/.openclaw, ~/.claude on first run).
HOME=/root node --version
HOME=/root openclaw --version
HOME=/root claude --version

# Gateway service: enabled, but only starts once a config exists
# (tenant provisioning or manual `openclaw onboard` creates it).
cat > /etc/systemd/system/openclaw.service <<EOF
[Unit]
Description=OpenClaw gateway
After=network-online.target
Wants=network-online.target
ConditionPathExists=/home/${OPENCLAW_USER}/.openclaw/openclaw.json

[Service]
User=${OPENCLAW_USER}
Environment=HOME=/home/${OPENCLAW_USER}
WorkingDirectory=/home/${OPENCLAW_USER}
ExecStart=/usr/bin/env openclaw gateway
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable openclaw.service
