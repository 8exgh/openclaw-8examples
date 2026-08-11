#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

HOME_DIR="/home/${OPENCLAW_USER}"

# --- SSH: add key auth (password auth stays on — these VMs live behind the
#     tailnet, and openclaw/openclaw console access is intentional). ---
install -d -m 0700 -o "${OPENCLAW_USER}" -g "${OPENCLAW_USER}" "${HOME_DIR}/.ssh"
cat > "${HOME_DIR}/.ssh/authorized_keys" <<'EOF'
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCd63n7hlcEVev/97sXddtosjFx8aPiH8+lHmVazLum612kWGmbKUmKOvqFpjbwQFX9EH1vLzPVK8w9SpEJKu4a6BElJulzqxADT0eNThVQjJSOsxXq585yMEeOoyB+gPO9HiAFHOfVgd/NQElThytLV2P8hN1hUvRWfx0z39R6up2u3Gp2vxyFj2nfRUkOZSIr00A9hNlkcMMZcrXlRHCyzmPs/mFsH5YAJGyodwbazl5YWPDOw2AZxSzkzb9WgmqYIsWRyXyMD3yKa1Gd+19HoyifkPwbSj8JprFItIO7j7bnKzbGYbnmJU7TGlgQpNC1dysUBvq8NGODomjE9TzSQ2tAoxiwkrRPmGR68lOhbjycFzKEkkIAbu+JlwLzq8E1pX0x/A9Yv2qCUVzfGjm8p8H0XwQ4pl/ibhn9WYAHIUyfn9dyAMAH0r+TvQStU2ZDsG7asxwzPXwggYs6oVVscsR4mEokUkr7LxXW4egs2OY132+EEjWapS97JGw9jbUgbKxxRiVf79lXd9h5mfhP2N1itDLbEKQ4BTQjsYsKdEJ6NxnGwLnbZnxQjduWlzuQfxweWiTIG57g6QP/8WOr2PLRHA/SE2y/XILrUynbSlvf1gbEgFB9YbeoD/EF5c9Tx7yxJ4eBQlZmSoxU7+fU4n2Dr98FD7YJL+voskH84w==
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEb7YBtSOOdF8Z+mw1q/N3biaq2SnhgV73ICBQHOjWd
EOF
chmod 0600 "${HOME_DIR}/.ssh/authorized_keys"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${HOME_DIR}/.ssh/authorized_keys"

# --- No autonomous package churn: all change comes from versioned image
#     rebuilds. This is the class of bug that hung server10's apt for 158 days
#     and let needrestart kill CI jobs. ---
apt-get -y purge unattended-upgrades || true
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
