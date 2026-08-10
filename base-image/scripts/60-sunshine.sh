#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Sunshine — Moonlight streaming host (LizardByte), official Ubuntu 24.04 deb.
curl -fsSL -o /tmp/sunshine.deb \
  https://github.com/LizardByte/Sunshine/releases/latest/download/sunshine-ubuntu-24.04-amd64.deb
apt-get -y install /tmp/sunshine.deb
rm -f /tmp/sunshine.deb

HOME_DIR="/home/${OPENCLAW_USER}"
SUNSHINE_DIR="${HOME_DIR}/.config/sunshine"
install -d -o "${OPENCLAW_USER}" -g "${OPENCLAW_USER}" "${SUNSHINE_DIR}"

# Web UI reachable from the LAN (https://<vm>:47990), not just localhost.
cat > "${SUNSHINE_DIR}/sunshine.conf" <<EOF
origin_web_ui_allowed = lan
address_family = both
EOF
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${SUNSHINE_DIR}/sunshine.conf"

# Pre-set web UI credentials so the image ships with a known login
# (same username/password as the system account; see credentials.txt).
sudo -u "${OPENCLAW_USER}" -H sunshine --creds "${OPENCLAW_USER}" "${OPENCLAW_PASSWORD}"

# Start with the desktop session (autologin -> Xorg session -> Sunshine).
install -d -o "${OPENCLAW_USER}" -g "${OPENCLAW_USER}" "${HOME_DIR}/.config/autostart"
cat > "${HOME_DIR}/.config/autostart/sunshine.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Sunshine
Exec=sunshine
X-GNOME-Autostart-enabled=true
EOF
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${HOME_DIR}/.config/autostart/sunshine.desktop"
