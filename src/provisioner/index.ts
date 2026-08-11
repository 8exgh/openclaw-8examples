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
 * deployed via the devops workflow. Wiring it through this interface is the
 * next step of that track; keeping the seam here so ops.ts is tier-agnostic.
 */
const desktopProvisioner: Provisioner = {
  apply() {
    throw new Error(
      "desktop tier isn't wired into the control plane yet — provision via base-image/ + the devops deploy workflow",
    );
  },
  status: () => 'desktop VM (managed outside the control plane for now)',
  teardown() {
    throw new Error('desktop tier teardown is manual for now (virsh/qm destroy + disk removal)');
  },
};

export function getProvisioner(tier: Tier | undefined): Provisioner {
  return tier === 'desktop' ? desktopProvisioner : containerProvisioner;
}
