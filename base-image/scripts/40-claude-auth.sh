#!/usr/bin/env bash
set -euxo pipefail

# claude-login: one-command Claude subscription login for this VM.
#   Interactive (on the VM desktop): claude-login
#     -> runs the OAuth setup-token flow; Chrome opens; sign into claude.ai; done.
#   Non-interactive (from your workstation):
#     claude setup-token                       # locally, on any machine
#     ssh openclaw@<vm> claude-login --token sk-ant-oat-...
cat > /usr/local/bin/claude-login <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

TOKEN=""
if [[ "${1:-}" == "--token" ]]; then
  TOKEN="${2:-}"
  [[ -n "$TOKEN" ]] || { echo "usage: claude-login [--token sk-ant-oat-...]" >&2; exit 1; }
fi

if [[ -z "$TOKEN" ]]; then
  echo "Starting Claude subscription login (opens a browser)..."
  exec openclaw models auth setup-token --provider anthropic
fi

printf '%s\n' "$TOKEN" | openclaw models auth paste-token --provider anthropic
echo "Claude subscription token installed for OpenClaw."
EOF
chmod 0755 /usr/local/bin/claude-login

# Desktop launcher so login is one double-click on the VM's desktop.
cat > /usr/share/applications/claude-login.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Connect Claude
Comment=Log this assistant into your Claude subscription
Exec=gnome-terminal -- /usr/local/bin/claude-login
Icon=utilities-terminal
Terminal=false
Categories=Utility;
EOF

# First-boot token import: if provisioning (cloud-init/control plane) drops a
# token at /etc/openclaw/claude-token.seed, install it before the gateway starts,
# then shred it. Lets tenant clones come up already logged in.
install -d -m 0700 /etc/openclaw
cat > /usr/local/lib/openclaw-import-token.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
SEED=/etc/openclaw/claude-token.seed
[[ -s "\$SEED" ]] || exit 0
sudo -u ${OPENCLAW_USER} -H bash -c '/usr/local/bin/claude-login --token "\$(cat '"\$SEED"')"'
shred -u "\$SEED"
EOF
chmod 0755 /usr/local/lib/openclaw-import-token.sh

cat > /etc/systemd/system/openclaw-token-import.service <<EOF
[Unit]
Description=Import seeded Claude subscription token
Before=openclaw.service
After=network-online.target
ConditionPathExists=/etc/openclaw/claude-token.seed

[Service]
Type=oneshot
ExecStart=/usr/local/lib/openclaw-import-token.sh

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable openclaw-token-import.service
