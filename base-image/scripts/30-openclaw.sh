#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Node 22 LTS (OpenClaw requires >= 22)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs

# OpenClaw + Claude Code CLI (the CLI provides `claude setup-token`, and
# OpenClaw reuses a local Claude login when one exists).
npm install -g openclaw@latest @anthropic-ai/claude-code@latest

# Call-home telemetry reporter (8examples fleet dashboard) — out of the box.
# Stays dormant until configured: run `openclaw-telemetry` once (or set
# OPENCLAW_TELEMETRY_TOKEN / OPENCLAW_TELEMETRY_CLAW in the service env).
npm install -g openclaw-telemetry@latest

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

# Telemetry reporter service: enabled, but only starts once configured
# (openclaw-telemetry setup writes the config file).
cat > /etc/systemd/system/openclaw-telemetry.service <<EOF
[Unit]
Description=OpenClaw telemetry reporter
After=network-online.target
Wants=network-online.target
ConditionPathExists=/home/${OPENCLAW_USER}/.openclaw-telemetry/config.json

[Service]
User=${OPENCLAW_USER}
Environment=HOME=/home/${OPENCLAW_USER}
ExecStart=/usr/bin/env openclaw-telemetry run
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
systemctl enable openclaw-telemetry.service

systemctl daemon-reload
systemctl enable openclaw.service
