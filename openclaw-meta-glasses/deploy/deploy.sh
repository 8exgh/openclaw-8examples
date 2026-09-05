#!/usr/bin/env bash
set -euo pipefail

cd /home/openclaw/managed-openclaw/openclaw-meta-glasses
python3 -m unittest discover -s test -p '*_test.py'
node integration/configure.mjs openclaw1
mkdir -p data secrets
chmod 700 data secrets
sudo install -d -m 700 /home/openclaw/openclaw-backups/meta-glasses
# Capture existing state before replacing an already deployed relay.
if sudo test -f data/glasses.sqlite; then
  sudo python3 deploy/backup.py
fi
npm ci --ignore-scripts
node test/relay.test.mjs
npm run check
npm audit --omit=dev --audit-level=moderate
docker compose build
docker compose up -d --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:8795/health
docker compose exec -T relay docker inspect openclaw-openclaw1 --format '{{.State.Running}}' | grep -qx true
sudo install -m 644 deploy/openclaw-glasses-backup.service deploy/openclaw-glasses-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-glasses-backup.timer
sudo systemctl start openclaw-glasses-backup.service
docker compose ps
systemctl list-timers openclaw-glasses-backup.timer --no-pager
