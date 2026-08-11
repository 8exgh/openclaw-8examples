import { capability } from '../capabilities/registry.js';
import type { CapabilityId, Tenant } from '../types.js';

export interface Resources {
  memoryGb: number;
  cpus: number;
  pidsLimit: number;
}

/** Floor for a text-only tenant: gateway ~1 GB + headroom. */
const BASE: Resources = { memoryGb: 4, cpus: 1.5, pidsLimit: 512 };

/**
 * Enabled capabilities raise the floor; an explicit `tenant.resources`
 * override always wins (operator knows about a specific heavy tenant).
 */
export function resourcesFor(tenant: Tenant): Resources {
  const out = { ...BASE };

  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    const floor = capability(id as CapabilityId).memoryGbFloor;
    if (floor && floor > out.memoryGb) out.memoryGb = floor;
  }

  return { ...out, ...tenant.resources };
}

export const asDockerMem = (gb: number): string => `${gb}g`;
