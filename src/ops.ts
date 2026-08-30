import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, capability } from './capabilities/registry.js';
import { pickExitNode } from './egress.js';
import { deliverToWorkspace, pickNudge } from './nudges/engine.js';
import { containerStatus, dockerAvailable, pullImage, resolveDigest } from './provisioner/docker.js';
import { getProvisioner } from './provisioner/index.js';
import { managedVersion } from './provisioner/render.js';
import {
  TENANTS_DIR,
  getTenant,
  loadFleet,
  loadTenants,
  saveFleet,
  saveTenants,
  slugify,
  tenantDir,
  upsertTenant,
} from './store.js';
import type { CapabilityId, ChannelId, NudgeRecord, OpenAIAuth, Tenant, Tier } from './types.js';

export interface SignupInput {
  name: string;
  /** Explicit tenant id; otherwise derived from name. */
  id?: string;
  phone?: string;
  email?: string;
  channel?: ChannelId;
  tier?: Tier;
  /** Capabilities to switch on at signup, beyond the defaults. */
  enable?: CapabilityId[];
}

export interface ApplyResult {
  tenant: Tenant;
  missingEnv: string[];
  started: boolean;
}

/** Tenants that participate in rollouts, nudging, and billing. */
export function activeTenants(): Tenant[] {
  return loadTenants().filter((t) => !t.offboardedAt);
}

/** Render the tenant to disk on the current fleet release and (re)start its runtime. */
export function applyTenant(tenant: Tenant, opts: { start?: boolean } = {}): ApplyResult {
  const fleet = loadFleet();
  const wantStart = opts.start !== false && process.env.MOC_NO_START !== '1';
  const { started, missingEnv } = getProvisioner(tenant.tier).apply(tenant, fleet, {
    start: wantStart,
  });

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

  const gatewayPort = fleet.freePorts?.length ? fleet.freePorts.shift()! : fleet.nextPort++;

  const id = input.id ?? slugify(input.name);
  if (loadTenants().some((t) => t.id === id)) {
    throw new Error(`Tenant id already taken: ${id}`);
  }

  const tenant: Tenant = {
    id,
    name: input.name,
    contact: { phone: input.phone, email: input.email },
    channel: input.channel ?? 'whatsapp',
    tier: input.tier ?? 'container',
    gatewayPort,
    createdAt: now,
    modelAccess: 'suppressed',
    capabilities: {},
    nudgeLog: [],
  };
  saveFleet(fleet);

  // Sticky residential egress for VM tenants: least-loaded exit node at
  // signup, then never moved implicitly (see src/egress.ts).
  if (tenant.tier === 'desktop') {
    const exitNode = pickExitNode(fleet, loadTenants());
    if (exitNode) tenant.egress = { exitNode, assignedAt: now };
  }

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

/** Record the sales system's authoritative assignment state. */
export function setModelAccess(tenantId: string, assigned: boolean, opts: { start?: boolean } = {}): ApplyResult {
  const tenant = getTenant(tenantId);
  tenant.modelAccess = assigned ? 'assigned' : 'suppressed';
  upsertTenant(tenant);
  return applyTenant(tenant, opts);
}

/** Synchronize every inventory slot atomically before a fleet rollout. */
export function syncModelAccess(assignedIds: ReadonlySet<string>): { assigned: number; suppressed: number; changed: string[] } {
  const tenants = loadTenants();
  let assigned = 0;
  let suppressed = 0;
  const changed: string[] = [];
  for (const tenant of tenants) {
    if (tenant.offboardedAt) continue;
    const next = assignedIds.has(tenant.id) ? 'assigned' : 'suppressed';
    const envFile = path.join(tenantDir(tenant.id), '.env');
    const env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const hasRealKey = (key: string): boolean => {
      const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
      return Boolean(match?.[1] && match[1] !== 'changeme');
    };
    const credentialsMatch = next === 'assigned'
      ? hasRealKey('ANTHROPIC_API_KEY') || hasRealKey('KIMI_API_KEY')
      : !/^ANTHROPIC_API_KEY=/m.test(env) && !/^KIMI_API_KEY=/m.test(env);
    const runtimeReady = tenant.tier === 'desktop' || /\bUp\b/i.test(containerStatus(tenant));
    // Compare the desired state with what is actually on disk and running.
    // A prior interrupted reconcile may have saved the flag before apply failed.
    if (!credentialsMatch || !runtimeReady) changed.push(tenant.id);
    tenant.modelAccess = next;
    if (tenant.modelAccess === 'assigned') assigned += 1;
    else suppressed += 1;
  }
  saveTenants(tenants);
  return { assigned, suppressed, changed };
}

function parseJwtExp(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return (JSON.parse(json) as { exp?: number }).exp;
  } catch {
    return undefined;
  }
}

function writeOpenAIAuthProfile(tenantId: string, credential: unknown): OpenAIAuth {
  const cred = credential as Record<string, unknown> | undefined;
  const tokens = cred?.tokens as Record<string, string> | undefined;
  const accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token;
  const idToken = tokens?.id_token;
  const accountId = tokens?.account_id;
  if (!accessToken || !refreshToken || !idToken || !accountId) {
    throw new Error(
      'Credential must contain tokens.access_token, tokens.refresh_token, tokens.id_token, and tokens.account_id',
    );
  }

  const exp = parseJwtExp(accessToken);
  if (!exp) {
    throw new Error('Could not parse expiry from access_token JWT');
  }

  const dir = path.join(tenantDir(tenantId), 'config', 'agents', 'main', 'agent');
  mkdirSync(dir, { recursive: true });

  const profile = {
    version: 1,
    profiles: {
      'openai-codex:default': {
        type: 'oauth',
        provider: 'openai-codex',
        access: accessToken,
        refresh: refreshToken,
        expires: exp * 1000,
        idToken,
        accountId,
      },
    },
  };

  const file = path.join(dir, 'auth-profiles.json');
  writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);

  return { profileId: 'openai-codex:default', enabledAt: new Date().toISOString() };
}

export function applyOpenAIAuth(
  tenantId: string,
  credentialPath: string,
  opts: { start?: boolean } = {},
): ApplyResult {
  const tenant = getTenant(tenantId);
  const credential = JSON.parse(readFileSync(credentialPath, 'utf8')) as unknown;
  tenant.openaiAuth = writeOpenAIAuthProfile(tenantId, credential);
  upsertTenant(tenant);
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

export function setAgentTimeout(
  tenantId: string,
  timeoutSeconds: number,
  opts: { start?: boolean } = {},
): ApplyResult {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3600) {
    throw new Error('Agent timeout must be a whole number from 60 through 3600 seconds');
  }
  const tenant = getTenant(tenantId);
  tenant.agentTimeoutSeconds = timeoutSeconds;
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
  return activeTenants().map((t) => ({ tenant: t.id, nudge: runNudge(t) }));
}

export interface UpdateResult {
  imageRef: string;
  previousImageRef?: string;
  managedVersion: string;
  tenants: { id: string; started: boolean; missingEnv: string[] }[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A tenant is healthy when its runtime reports an up-and-not-restarting state. */
async function waitHealthy(tenant: Tenant, attempts = 6, gapMs = 5000): Promise<boolean> {
  const provisioner = getProvisioner(tenant.tier);
  for (let i = 0; i < attempts; i++) {
    await sleep(gapMs);
    const status = provisioner.status(tenant);
    if (status.startsWith('Up') && !status.includes('Restarting')) return true;
  }
  return false;
}

/**
 * Fleet update: pull the newest OpenClaw image, pin its digest, then re-render
 * every active tenant on the newest managed templates and rolling-restart them.
 * With `canary`, that tenant is updated first and must pass a health check
 * before the rollout continues — run your own instance as tenant zero.
 */
export async function updateFleet(
  opts: { start?: boolean; canary?: string } = {},
): Promise<UpdateResult> {
  const fleet = loadFleet();

  if (dockerAvailable()) {
    pullImage(fleet.image);
    const next = resolveDigest(fleet.image) ?? fleet.image;
    if (fleet.pinnedImageRef && fleet.pinnedImageRef !== next) {
      fleet.previousImageRef = fleet.pinnedImageRef;
    }
    fleet.pinnedImageRef = next;
  }
  saveFleet(fleet);

  const all = activeTenants();
  if (opts.canary && !all.some((t) => t.id === opts.canary)) {
    throw new Error(`Canary tenant not found or offboarded: ${opts.canary}`);
  }
  const order = opts.canary
    ? [...all.filter((t) => t.id === opts.canary), ...all.filter((t) => t.id !== opts.canary)]
    : all;

  const tenants: UpdateResult['tenants'] = [];
  for (let i = 0; i < order.length; i++) {
    const tenant = order[i];
    const result = applyTenant(tenant, opts);
    tenants.push({ id: tenant.id, started: result.started, missingEnv: result.missingEnv });

    if (i === 0 && opts.canary && result.started && !(await waitHealthy(tenant))) {
      throw new Error(
        `Canary ${tenant.id} unhealthy on ${fleet.pinnedImageRef ?? fleet.image} — rollout halted` +
          (fleet.previousImageRef ? ` (previous release: ${fleet.previousImageRef})` : ''),
      );
    }
  }

  return {
    imageRef: fleet.pinnedImageRef ?? fleet.image,
    previousImageRef: fleet.previousImageRef,
    managedVersion: managedVersion(),
    tenants,
  };
}

/**
 * Offboarding: stop the runtime, mark the tenant inactive, reclaim the port.
 * With `purge`, also delete the tenant directory (config, workspace, secrets)
 * and the stored record including contact info — the PIPEDA deletion path.
 */
export function offboardTenant(
  tenantId: string,
  opts: { purge?: boolean } = {},
): { tenant: string; purged: boolean } {
  const tenant = getTenant(tenantId);
  if (tenant.offboardedAt && !opts.purge) {
    return { tenant: tenant.id, purged: false };
  }

  getProvisioner(tenant.tier).teardown(tenant);

  const fleet = loadFleet();
  if (!fleet.freePorts?.includes(tenant.gatewayPort) && !tenant.offboardedAt) {
    fleet.freePorts = [...(fleet.freePorts ?? []), tenant.gatewayPort];
    saveFleet(fleet);
  }

  let purged = false;
  if (opts.purge) {
    // Containment: never delete outside the tenants directory.
    const dir = path.resolve(tenantDir(tenant.id));
    if (!dir.startsWith(path.resolve(TENANTS_DIR) + path.sep)) {
      throw new Error(`Refusing to purge path outside tenants dir: ${dir}`);
    }
    rmSync(dir, { recursive: true, force: true });
    saveTenants(loadTenants().filter((t) => t.id !== tenant.id));
    purged = true;
  } else {
    tenant.offboardedAt = new Date().toISOString();
    upsertTenant(tenant);
  }

  return { tenant: tenant.id, purged };
}

export interface TenantSummary {
  id: string;
  name: string;
  channel: ChannelId;
  tier: Tier;
  gatewayPort: number;
  container: string;
  /** Exit node the tenant's VM egresses through (desktop tier). */
  egress?: string;
  capabilities: Record<string, boolean>;
  managedVersion?: string;
  upToDate: boolean;
  nudges: number;
  offboarded: boolean;
}

export function summarize(tenant: Tenant): TenantSummary {
  const current = managedVersion();
  return {
    id: tenant.id,
    name: tenant.name,
    channel: tenant.channel,
    tier: tenant.tier ?? 'container',
    gatewayPort: tenant.gatewayPort,
    container: getProvisioner(tenant.tier).status(tenant),
    egress: tenant.egress?.exitNode,
    capabilities: Object.fromEntries(
      Object.entries(tenant.capabilities).map(([id, s]) => [id, !!s?.enabled]),
    ),
    managedVersion: tenant.applied?.managedVersion,
    upToDate: tenant.applied?.managedVersion === current,
    nudges: tenant.nudgeLog.length,
    offboarded: !!tenant.offboardedAt,
  };
}
