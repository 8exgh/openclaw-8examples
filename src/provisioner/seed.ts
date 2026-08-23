import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pickExitNode, tenantTag, vmHostname } from '../egress.js';
import { loadFleet, loadTenants, tenantDir, upsertTenant } from '../store.js';
import type { Tenant } from '../types.js';

/**
 * First-boot NoCloud seed for a desktop-tier tenant VM. Generates exactly the
 * seed files the base image has consumers for:
 *
 *   /etc/openclaw/tailscale.seed     read by openclaw-tailscale.service
 *                                    (base-image/scripts/65-tailscale.sh),
 *                                    shredded after a successful join
 *   /etc/openclaw/claude-token.seed  read by openclaw-token-import (optional)
 *
 * The tailscale seed carries the tenant's sticky exit-node assignment, so the
 * VM egresses from its residential IP from the very first boot. openclaw.json
 * and workspace seeding for the VM tier are still the open track noted in
 * provisioner/index.ts.
 */

export interface SeedOptions {
  /** Tailscale pre-auth key (ideally tagged + pre-approved for the tenant tag). */
  authkey: string;
  /** Claude OAuth token (sk-ant-oat-...) to install before the gateway starts. */
  claudeToken?: string;
}

export interface SeedResult {
  tenant: Tenant;
  dir: string;
  hostname: string;
  exitNode?: string;
  /** Set when an ISO tool was found and the image was built. */
  isoPath?: string;
  /** Set when no ISO tool was available — run this inside `dir`. */
  isoCommand?: string;
}

const ISO_TOOLS: string[][] = [
  ['cloud-localds', 'seed.iso', 'user-data', 'meta-data'],
  ['genisoimage', '-output', 'seed.iso', '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data'],
  ['xorriso', '-as', 'genisoimage', '-output', 'seed.iso', '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data'],
];

function buildIso(dir: string): string | undefined {
  for (const [tool, ...args] of ISO_TOOLS) {
    try {
      execFileSync(tool, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const iso = path.join(dir, 'seed.iso');
      chmodSync(iso, 0o600);
      return iso;
    } catch {
      /* tool missing or failed — try the next one */
    }
  }
  return undefined;
}

export function renderSeed(tenant: Tenant, opts: SeedOptions): SeedResult {
  if ((tenant.tier ?? 'container') !== 'desktop') {
    throw new Error(
      `${tenant.id} is container-tier — seeds are for desktop-tier VMs (signup --tier desktop, or set tier in data/tenants.json)`,
    );
  }
  if (!opts.authkey.startsWith('tskey-')) {
    throw new Error('authkey does not look like a tailscale pre-auth key (expected tskey-...)');
  }

  const fleet = loadFleet();

  // Sticky assignment: keep what the tenant has; otherwise take the
  // least-loaded node now (covers tenants created before the pool existed).
  let exitNode = tenant.egress?.exitNode;
  if (!exitNode) {
    exitNode = pickExitNode(fleet, loadTenants());
    if (exitNode) {
      tenant.egress = { exitNode, assignedAt: new Date().toISOString() };
      upsertTenant(tenant);
    }
  }

  const hostname = vmHostname(tenant.id);
  const tailscaleArgs = [
    `--authkey=${opts.authkey}`,
    `--hostname=${hostname}`,
    `--advertise-tags=${tenantTag(fleet)}`,
    // Lets the control plane run `tailscale set` over SSH without sudo.
    '--operator=openclaw',
    ...(exitNode ? [`--exit-node=${exitNode}`] : []),
  ].join(' ');

  const writeFiles = [
    {
      path: '/etc/openclaw/tailscale.seed',
      content: tailscaleArgs,
    },
    ...(opts.claudeToken
      ? [{ path: '/etc/openclaw/claude-token.seed', content: opts.claudeToken }]
      : []),
  ];

  const userData = [
    '#cloud-config',
    `hostname: ${hostname}`,
    'preserve_hostname: false',
    'write_files:',
    ...writeFiles.flatMap((f) => [
      `  - path: ${f.path}`,
      '    owner: root:root',
      "    permissions: '0600'",
      '    content: |',
      `      ${f.content}`,
    ]),
    '',
  ].join('\n');

  // Fresh instance-id per render so re-attaching a regenerated seed (e.g. a
  // rotated authkey or a new exit-node assignment) re-runs cloud-init.
  const metaData = [
    `instance-id: ${hostname}-${randomBytes(4).toString('hex')}`,
    `local-hostname: ${hostname}`,
    '',
  ].join('\n');

  const dir = path.join(tenantDir(tenant.id), 'seed');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700); // holds the authkey (and possibly a Claude token)
  writeFileSync(path.join(dir, 'user-data'), userData, { mode: 0o600 });
  writeFileSync(path.join(dir, 'meta-data'), metaData, { mode: 0o600 });

  const isoPath = buildIso(dir);
  return {
    tenant,
    dir,
    hostname,
    exitNode,
    isoPath,
    isoCommand: isoPath ? undefined : ISO_TOOLS[1].join(' '),
  };
}
