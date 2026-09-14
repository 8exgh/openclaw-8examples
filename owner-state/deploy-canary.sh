#!/usr/bin/env bash
# Apply ownership preservation and container administration to openclaw1 only.
set -euo pipefail
: "${MOC_ROOT:?Set the live managed-openclaw checkout}"
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
REVISION=$(git -C "$SOURCE" rev-parse HEAD)
export SOURCE
node --input-type=module - <<'JS'
import path from 'node:path';
const { assertOwnerIdle } = await import(`${process.env.SOURCE}/owner-state/index.mjs`);
assertOwnerIdle(path.join(process.env.MOC_ROOT, 'tenants/openclaw1'));
JS
test -z "$(runuser -u openclaw -- git -C "$MOC_ROOT" status --porcelain --untracked-files=no)"
runuser -u openclaw -- git -C "$MOC_ROOT" fetch origin main
runuser -u openclaw -- git -C "$MOC_ROOT" merge --ff-only "$REVISION"
runuser -u openclaw -- npm --prefix "$MOC_ROOT" ci
# This updates the provisioner for subsequent operations without starting a
# fleet rollout. Only the following explicit canary apply touches a container.
runuser -u openclaw -- node --import "$MOC_ROOT/node_modules/tsx/dist/loader.mjs" --input-type=module - <<'JS'
import { writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
const root = process.env.MOC_ROOT;
const { getTenant, loadFleet } = await import(`${root}/src/store.ts`);
const { getProvisioner } = await import(`${root}/src/provisioner/index.ts`);
const tenant = getTenant('openclaw1');
if (tenant.offboardedAt || tenant.modelAccess === 'suppressed' || tenant.tier === 'desktop') throw new Error('Canary is not eligible');
const dir = path.join(root, 'tenants/openclaw1');
copyFileSync(path.join(dir, 'config/openclaw.json'), path.join(dir, `config/owner-before-preservation-${Date.now()}.json`));
writeFileSync(path.join(dir, '.owner-admin'), 'Owner administers this container.\n', { mode: 0o600 });
getProvisioner(tenant.tier).apply(tenant, loadFleet(), { start: true });
console.log('Owner configuration adopted and admin capabilities enabled on openclaw1 only.');
JS
docker exec --user node openclaw-openclaw1 openclaw config validate --json
docker exec --user root openclaw-openclaw1 sh -c 'test "$(id -u)" = 0 && test ! -S /var/run/docker.sock && runuser -u node -- test -r /home/node/.openclaw/openclaw.json'
