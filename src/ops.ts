import { CAPABILITIES, capability } from './capabilities/registry.js';
import { deliverToWorkspace, pickNudge } from './nudges/engine.js';
import { composeUp, containerStatus, dockerAvailable, pullImage, resolveDigest } from './provisioner/docker.js';
import { managedVersion, renderTenant } from './provisioner/render.js';
import { getTenant, loadFleet, loadTenants, saveFleet, slugify, upsertTenant } from './store.js';
import type { CapabilityId, ChannelId, NudgeRecord, Tenant } from './types.js';

export interface SignupInput {
  name: string;
  phone?: string;
  email?: string;
  channel?: ChannelId;
  /** Capabilities to switch on at signup, beyond the defaults. */
  enable?: CapabilityId[];
}

export interface ApplyResult {
  tenant: Tenant;
  missingEnv: string[];
  started: boolean;
}

/** Render the tenant to disk on the current fleet release and (re)start its container. */
export function applyTenant(tenant: Tenant, opts: { start?: boolean } = {}): ApplyResult {
  const fleet = loadFleet();
  const missingEnv = renderTenant(tenant, fleet);

  let started = false;
  const wantStart = opts.start !== false && process.env.MOC_NO_START !== '1';
  if (wantStart && dockerAvailable()) {
    composeUp(tenant);
    started = true;
  }

  tenant.applied = {
    imageRef: fleet.pinnedImageRef ?? fleet.image,
    managedVersion: managedVersion(),
    appliedAt: new Date().toISOString(),
  };
  upsertTenant(tenant);
  return { tenant, missingEnv, started };
}

export function signup(input: SignupInput, opts: { start?: boolean } = {}): ApplyResult {
  const fleet = loadFleet();
  const now = new Date().toISOString();

  const tenant: Tenant = {
    id: slugify(input.name),
    name: input.name,
    contact: { phone: input.phone, email: input.email },
    channel: input.channel ?? 'whatsapp',
    gatewayPort: fleet.nextPort,
    createdAt: now,
    capabilities: {},
    nudgeLog: [],
  };
  fleet.nextPort += 1;
  saveFleet(fleet);

  for (const def of CAPABILITIES) {
    const enable = def.defaultEnabled || (input.enable ?? []).includes(def.id);
    tenant.capabilities[def.id] = enable
      ? { enabled: true, enabledAt: now }
      : { enabled: false };
  }
  upsertTenant(tenant);

  // Day-one nudge so the assistant starts selling the next capability immediately.
  runNudge(tenant);

  return applyTenant(tenant, opts);
}

export function setCapability(
  tenantId: string,
  capabilityId: CapabilityId,
  enabled: boolean,
  opts: { start?: boolean } = {},
): ApplyResult {
  const tenant = getTenant(tenantId);
  capability(capabilityId); // validates id
  const prev = tenant.capabilities[capabilityId];
  tenant.capabilities[capabilityId] = enabled
    ? { enabled: true, enabledAt: prev?.enabledAt ?? new Date().toISOString() }
    : { enabled: false };
  upsertTenant(tenant);
  return applyTenant(tenant, opts);
}

/** Run the nudge engine for one tenant; writes into its workspace when a nudge fires. */
export function runNudge(tenant: Tenant): NudgeRecord | null {
  const nudge = pickNudge(tenant);
  if (!nudge) return null;
  tenant.nudgeLog.push(nudge);
  upsertTenant(tenant);
  deliverToWorkspace(tenant, nudge);
  return nudge;
}

export function runNudgesAll(): { tenant: string; nudge: NudgeRecord | null }[] {
  return loadTenants().map((t) => ({ tenant: t.id, nudge: runNudge(t) }));
}

export interface UpdateResult {
  imageRef: string;
  managedVersion: string;
  tenants: { id: string; started: boolean; missingEnv: string[] }[];
}

/**
 * Fleet update: pull the newest OpenClaw image, pin its digest, then re-render
 * every tenant on the newest managed templates and rolling-restart them.
 * New signups automatically use the same pinned release.
 */
export function updateFleet(opts: { start?: boolean } = {}): UpdateResult {
  const fleet = loadFleet();

  if (dockerAvailable()) {
    pullImage(fleet.image);
    fleet.pinnedImageRef = resolveDigest(fleet.image) ?? fleet.image;
  }
  saveFleet(fleet);

  const tenants = loadTenants().map((t) => {
    const result = applyTenant(t, opts);
    return { id: t.id, started: result.started, missingEnv: result.missingEnv };
  });

  return {
    imageRef: fleet.pinnedImageRef ?? fleet.image,
    managedVersion: managedVersion(),
    tenants,
  };
}

export interface TenantSummary {
  id: string;
  name: string;
  channel: ChannelId;
  gatewayPort: number;
  container: string;
  capabilities: Record<string, boolean>;
  managedVersion?: string;
  upToDate: boolean;
  nudges: number;
}

export function summarize(tenant: Tenant): TenantSummary {
  const current = managedVersion();
  return {
    id: tenant.id,
    name: tenant.name,
    channel: tenant.channel,
    gatewayPort: tenant.gatewayPort,
    container: containerStatus(tenant),
    capabilities: Object.fromEntries(
      Object.entries(tenant.capabilities).map(([id, s]) => [id, !!s?.enabled]),
    ),
    managedVersion: tenant.applied?.managedVersion,
    upToDate: tenant.applied?.managedVersion === current,
    nudges: tenant.nudgeLog.length,
  };
}
