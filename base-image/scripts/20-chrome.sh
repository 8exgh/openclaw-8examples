#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Google's official deb — explicitly not the snap.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  > /etc/apt/sources.list.d/google-chrome.list

apt-get update
apt-get -y install google-chrome-stable

# Default browser for the agent user (xdg-settings needs a session; mimeapps works offline).
HOME_DIR="/home/${OPENCLAW_USER}"
install -d -o "${OPENCLAW_USER}" -g "${OPENCLAW_USER}" "${HOME_DIR}/.config"
cat > "${HOME_DIR}/.config/mimeapps.list" <<EOF
[Default Applications]
x-scheme-handler/http=google-chrome.desktop
x-scheme-handler/https=google-chrome.desktop
text/html=google-chrome.desktop
EOF
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${HOME_DIR}/.config/mimeapps.list"
