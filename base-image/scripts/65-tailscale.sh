#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Tailscale: installed and enabled, but stays logged out until a per-tenant
# seed provides an auth key on first boot. This is what gives every tenant VM
# its own tailnet presence + residential egress with zero manual setup.
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable tailscaled

install -d -m 0700 /etc/openclaw

# First-boot join. Seed file holds `tailscale up` arguments, e.g.:
#   --authkey=tskey-... --advertise-tags=tag:dc-egress --hostname=openclaw-jason --operator=openclaw --exit-node=server2
# (This is what the control plane's `cli seed <tenant>` writes; --operator lets
# it run `tailscale set` over SSH without sudo for egress migrations.)
# The seed is shredded after a successful join so the auth key never lingers.
cat > /usr/local/lib/openclaw-tailscale-up.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SEED=/etc/openclaw/tailscale.seed
[ -s "$SEED" ] || exit 0
# shellcheck disable=SC2046  # deliberate word-splitting of controlled seed args
if tailscale up $(cat "$SEED"); then
  shred -u "$SEED"
fi
EOF
chmod 0755 /usr/local/lib/openclaw-tailscale-up.sh

cat > /etc/systemd/system/openclaw-tailscale.service <<EOF
[Unit]
Description=Join tailnet from seed on first boot
After=tailscaled.service network-online.target
Wants=network-online.target
ConditionPathExists=/etc/openclaw/tailscale.seed

[Service]
Type=oneshot
ExecStart=/usr/local/lib/openclaw-tailscale-up.sh

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable openclaw-tailscale.service
