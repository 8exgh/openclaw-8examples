import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tenantDir } from '../store.js';
import type { Fleet, Tenant, Tier } from '../types.js';
import { composeDown, composeUp, containerStatus, dockerAvailable } from './docker.js';
import { renderTenant } from './render.js';

/**
 * Plugins the image does not bundle. Enabling one in config without
 * installing it leaves the gateway warning "plugin not installed" and
 * silently ignoring whatever it powers — which is how web_search sat inert
 * fleet-wide, and how a fresh tenant would come up with no Kimi fallback.
 */
const EXTERNAL_PLUGIN_PACKAGES: Record<string, string> = {
  brave: '@openclaw/brave-plugin',
  kimi: '@openclaw/kimi-provider',
  moonshot: '@openclaw/moonshot-provider',
};

/** Read back what the render actually enabled, rather than re-deriving it. */
function requiredPluginPackages(tenant: Tenant): string[] {
  const file = path.join(tenantDir(tenant.id), 'config', 'openclaw.json');
  if (!existsSync(file)) return [];
  try {
    const config = JSON.parse(readFileSync(file, 'utf8')) as {
      plugins?: { entries?: Record<string, { enabled?: boolean }> };
    };
    const packages = Object.entries(config.plugins?.entries ?? {})
      .filter(([id, entry]) => entry?.enabled && EXTERNAL_PLUGIN_PACKAGES[id])
      .map(([id]) => EXTERNAL_PLUGIN_PACKAGES[id]);
    // Since 2026.8.1 the kimi provider drags in a moonshot plugin requirement:
    // a gateway with kimi enabled but moonshot unconsented refuses ready and
    // crash-loops, even when the moonshot entry itself is not in the config.
    if (packages.includes(EXTERNAL_PLUGIN_PACKAGES.kimi) && !packages.includes(EXTERNAL_PLUGIN_PACKAGES.moonshot)) {
      packages.push(EXTERNAL_PLUGIN_PACKAGES.moonshot);
    }
    return packages;
  } catch {
    return [];
  }
}

export interface ApplyOutcome {
  started: boolean;
  /** Env keys still holding placeholder values after render. */
  missingEnv: string[];
}

export interface Provisioner {
  apply(tenant: Tenant, fleet: Fleet, opts: { start: boolean }): ApplyOutcome;
  status(tenant: Tenant): string;
  teardown(tenant: Tenant): void;
}

const containerProvisioner: Provisioner = {
  apply(tenant, fleet, { start }) {
    const missingEnv = renderTenant(tenant, fleet);
    let started = false;
    if (start && dockerAvailable()) {
      composeUp(tenant, requiredPluginPackages(tenant));
      started = true;
    }
    return { started, missingEnv };
  },
  status: (tenant) => containerStatus(tenant),
  teardown(tenant) {
    if (dockerAvailable()) composeDown(tenant);
  },
};

/**
 * Desktop tier: one full VM per tenant, built from base-image/ and (today)
 * deployed via the devops workflow. The control plane renders the first-boot
 * NoCloud seed (`cli seed <id>`: tailnet join + exit node + Claude token) and
 * manages egress; VM lifecycle and openclaw.json/workspace seeding are still
 * manual — keeping the seam here so ops.ts is tier-agnostic.
 */
const desktopProvisioner: Provisioner = {
  apply(tenant) {
    console.log(
      `  desktop tier: VM lifecycle is manual — render the first-boot seed with \`npm run cli -- seed ${tenant.id}\` and boot an overlay of the base image with it attached`,
    );
    return { started: false, missingEnv: [] };
  },
  status: () => 'desktop VM (managed outside the control plane for now)',
  teardown(tenant) {
    console.warn(
      `  desktop tier: destroy the VM manually (e.g. virsh destroy openclaw-${tenant.id} + disk removal); record updated either way`,
    );
  },
};

export function getProvisioner(tier: Tier | undefined): Provisioner {
  return tier === 'desktop' ? desktopProvisioner : containerProvisioner;
}
