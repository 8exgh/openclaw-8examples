#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- Office & paperwork (the assistant's core trade) ------------------------
# Headless LibreOffice: best-fidelity converter for real .docx/.xlsx/.odt,
#   e.g. `soffice --headless --convert-to pdf contract.docx`
apt-get -y install --no-install-recommends libreoffice
# OCR pipeline: scanned form -> searchable text/PDF
apt-get -y install tesseract-ocr ocrmypdf qpdf zbar-tools

# --- Browser automation ------------------------------------------------------
# Playwright CLI + managed Chromium (can also drive installed Chrome via
# channel:"chrome"). Browsers live in the agent user's ~/.cache/ms-playwright.
npm install -g playwright@latest
playwright install-deps chromium
sudo -u "${OPENCLAW_USER}" -H playwright install chromium
sudo -u "${OPENCLAW_USER}" -H playwright --version

# --- Desktop automation (Xorg session) ---------------------------------------
# xdotool: synthetic keyboard/mouse; wmctrl: window control; maim: screenshots
apt-get -y install xdotool wmctrl maim

# --- Data plumbing ------------------------------------------------------------
apt-get -y install rclone postgresql-client mysql-client httpie
apt-get -y install yq || pipx install yq

# --- Fast Python tooling (uv) for the agent user ------------------------------
sudo -u "${OPENCLAW_USER}" -H bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
