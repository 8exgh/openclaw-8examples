import type { Fleet, Tenant, Tier } from '../types.js';
import { composeDown, composeUp, containerStatus, dockerAvailable } from './docker.js';
import { renderTenant } from './render.js';

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
      composeUp(tenant);
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
