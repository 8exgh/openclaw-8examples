import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CAPABILITIES, capability } from '../capabilities/registry.js';
import { TEMPLATES_DIR, tenantDir } from '../store.js';
import type { CapabilityId, Fleet, Tenant } from '../types.js';
import { asDockerMem, resourcesFor } from './resources.js';

/** The openclaw image runs as `node`, uid/gid 1000 — bind mounts must be writable by it. */
const CONTAINER_UID = 1000;

function ensureDirForContainer(dir: string, mode = 0o755): void {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
  // Only root can hand ownership to uid 1000; otherwise we rely on the
  // documented constraint that the control plane runs as uid 1000 itself.
  if (process.getuid?.() === 0) {
    try {
      chownSync(dir, CONTAINER_UID, CONTAINER_UID);
    } catch {
      /* best effort */
    }
  }
}

/** Bump when the managed layer changes in a way not captured by template files. */
export const MANAGED_LAYER_VERSION = '0.1.0';

/** Version fingerprint of the managed layer: templates + code version. */
export function managedVersion(): string {
  const hash = createHash('sha256');
  hash.update(MANAGED_LAYER_VERSION);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        hash.update(path.relative(TEMPLATES_DIR, full));
        hash.update(readFileSync(full));
      }
    }
  };
  if (existsSync(TEMPLATES_DIR)) walk(TEMPLATES_DIR);
  return `${MANAGED_LAYER_VERSION}+${hash.digest('hex').slice(0, 12)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for config fragments; arrays and scalars are replaced. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * OpenClaw does not currently expose native heartbeat jitter. Give each tenant
 * a stable interval between 4h00m and 4h59m so fleet restarts do not leave all
 * assistants firing on the same cadence.
 */
function heartbeatEvery(tenantId: string): string {
  let hash = 2166136261;
  for (const char of tenantId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${240 + ((hash >>> 0) % 60)}m`;
}

function channelConfig(tenant: Tenant, opts: { channelReady: boolean }): Record<string, unknown> {
  const allowFrom = tenant.contact.phone ? [tenant.contact.phone] : [];
  switch (tenant.channel) {
    case 'telegram': {
      // Stay disabled until a real bot token is present — a placeholder token
      // crash-loops the gateway. The web chat works regardless.
      // Locked to specific peers when telegramAllowFrom is set (e.g.
      // ["telegram:8097846352"]); otherwise open to anyone. 'open'/'allowlist'
      // both REQUIRE an allowFrom — without it OpenClaw silently drops every
      // message after polling it (["*"] is the open wildcard).
      const locked = (tenant.telegramAllowFrom?.length ?? 0) > 0;
      const audience = locked ? tenant.telegramAllowFrom! : ['*'];
      const policy = locked ? 'allowlist' : 'open';
      return {
        telegram: {
          enabled: opts.channelReady,
          botToken: '${TELEGRAM_BOT_TOKEN}',
          dmPolicy: policy,
          allowFrom: audience,
          // Group responses enabled. In groups the bot only sees mentions/replies
          // unless privacy mode is disabled in BotFather, so it stays quiet
          // otherwise without needing an (unsupported) requireMention flag.
          groupPolicy: policy,
          groupAllowFrom: audience,
        },
      };
    }
    case 'signal':
      return { signal: { enabled: true, dmPolicy: allowFrom.length ? 'allowlist' : 'pairing', allowFrom } };
    case 'whatsapp':
    default:
      return {
        whatsapp: {
          enabled: true,
          dmPolicy: allowFrom.length ? 'allowlist' : 'pairing',
          allowFrom,
        },
      };
  }
}

/** Build the tenant's openclaw.json: managed base + every enabled capability's patch. */
export function buildOpenclawConfig(
  tenant: Tenant,
  opts: { channelReady?: boolean } = {},
): Record<string, unknown> {
  let config: Record<string, unknown> = {
    gateway: {
      mode: 'local', // required by current OpenClaw; absent = start refused (exit 78)
      port: 18789,
      bind: 'lan', // container port is published only on the host's loopback (see compose file)
      auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' },
    },
    agents: {
      defaults: {
        workspace: '/home/node/.openclaw/workspace',
        model: {
          primary: 'anthropic/claude-opus-4-8',
          // Authentication is installed separately in each tenant's persisted
          // auth store. Never clone a ChatGPT OAuth refresh token across the
          // fleet: refresh-token rotation would make the tenants invalidate
          // one another's credentials.
          fallbacks: [
            tenant.openaiAuth ? 'openai-codex/gpt-5.6-sol' : 'openai/gpt-5.6-sol',
            'kimi/k3',
          ],
        },
        heartbeat: { every: heartbeatEvery(tenant.id), target: 'last' },
        // Container tier: the container IS the isolation boundary, and there's
        // no Docker inside it — non-main/all would need Docker-in-Docker and
        // fail every agent turn. Desktop VMs do have Docker, so sandbox there.
        sandbox: { mode: tenant.tier === 'desktop' ? 'non-main' : 'off', scope: 'agent' },
      },
    },
    channels: channelConfig(tenant, { channelReady: opts.channelReady ?? false }),
    session: {
      dmScope: 'per-channel-peer',
      reset: { mode: 'daily', atHour: 4 },
    },
    plugins: {
      allow: ['kimi'],
      entries: {
        kimi: { enabled: true },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        kimi: {
          // K3 is the general flagship model available to the fleet's Kimi
          // subscription. Do not add the coding-tuned `kimi-for-coding` model.
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKey: '${KIMI_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'k3',
              name: 'Kimi K3',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 131072,
            },
          ],
        },
      },
    },
    auth: {
      profiles: {
        'kimi:manual': { provider: 'kimi', mode: 'api_key' },
      },
    },
  };

  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    config = deepMerge(config, capability(id as CapabilityId).configPatch(tenant));
  }

  if (tenant.openaiAuth) {
    config = deepMerge(config, {
      plugins: {
        entries: {
          codex: { enabled: true },
        },
      },
    });
  }

  return config;
}

function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Render .env, preserving any values already filled in. New keys get
 * placeholders; the CLI reports which ones still need real values.
 */
function renderEnv(tenant: Tenant, dir: string): string[] {
  const file = path.join(dir, '.env');
  const env = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : new Map<string, string>();

  const ensure = (key: string, value: string): void => {
    if (!env.get(key)) env.set(key, value);
  };

  ensure('OPENCLAW_GATEWAY_TOKEN', randomBytes(24).toString('hex'));
  ensure('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY ?? 'changeme');
  ensure('KIMI_API_KEY', process.env.KIMI_API_KEY ?? 'changeme');
  // Fleet call-home telemetry (openclaw-telemetry on npm): the token is
  // inherited from the control plane's environment at render time; when
  // absent, the tenant's reporter simply stays off.
  if (process.env.OPENCLAW_TELEMETRY_TOKEN) {
    ensure('OPENCLAW_TELEMETRY_TOKEN', process.env.OPENCLAW_TELEMETRY_TOKEN);
  }
  if (tenant.channel === 'telegram') ensure('TELEGRAM_BOT_TOKEN', 'changeme');
  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    for (const { key } of capability(id as CapabilityId).env) ensure(key, 'changeme');
  }

  const lines = [...env.entries()].map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return [...env.entries()].filter(([, v]) => v === 'changeme').map(([k]) => k);
}

function template(name: string, vars: Record<string, string>): string {
  const raw = readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

function capabilitySections(tenant: Tenant): { enabled: string; upgrades: string } {
  const enabled: string[] = [];
  const upgrades: string[] = [];
  for (const def of CAPABILITIES.slice().sort((a, b) => a.priority - b.priority)) {
    if (tenant.capabilities[def.id]?.enabled) {
      enabled.push(`- **${def.label}** — ${def.tagline} (details: \`capabilities/${def.id}.md\`)`);
    } else if (def.offerNudges.length > 0) {
      upgrades.push(`- **${def.label}** — ${def.tagline}\n  - Offer line: "${def.offerNudges[0]}"`);
    }
  }
  return {
    enabled: enabled.join('\n') || '- (nothing enabled yet — your job is conversation and paperwork triage)',
    upgrades: upgrades.join('\n') || '- (everything is enabled — focus on deepening usage)',
  };
}

/**
 * Render the tenant's full on-disk footprint:
 *
 *   tenants/<id>/
 *     docker-compose.yml      managed (overwritten)
 *     .env                    merged (values preserved)
 *     config/openclaw.json    managed (overwritten)
 *     workspace/
 *       AGENTS.md             managed (overwritten)
 *       HEARTBEAT.md          managed (overwritten)
 *       skills/, capabilities/  managed (rebuilt)
 *       SOUL.md               seeded once, then owned by tenant/agent
 *       nudges/, memory, everything else: never touched here
 *
 * Returns env keys that still hold placeholder values.
 */
export function renderTenant(tenant: Tenant, fleet: Fleet): string[] {
  const dir = tenantDir(tenant.id);
  const workspace = path.join(dir, 'workspace');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700); // holds config, workspace, and secret material
  ensureDirForContainer(path.join(dir, 'config'));
  ensureDirForContainer(workspace);
  // Never re-rendered, never overwritten — losing this invalidates the
  // tenant's stored OAuth tokens. Docker would auto-create it root-owned.
  ensureDirForContainer(path.join(dir, 'auth-profile-secrets'), 0o700);
  ensureDirForContainer(path.join(dir, 'browser-cache'));

  const imageRef = fleet.pinnedImageRef ?? fleet.image;
  const res = resourcesFor(tenant);

  // Telegram only enables once a real bot token is in .env (from a prior render
  // that the operator filled in) — placeholder tokens crash-loop the gateway.
  const envFile = path.join(dir, '.env');
  const existingToken = existsSync(envFile)
    ? parseEnv(readFileSync(envFile, 'utf8')).get('TELEGRAM_BOT_TOKEN')
    : undefined;
  const channelReady = !!existingToken && existingToken !== 'changeme';

  // OpenClaw writes config provenance metadata and restores its last-known-good
  // backup during shutdown when that metadata suddenly disappears. Preserve it
  // across managed renders so an intentional config update is not rolled back
  // while docker compose recreates the container.
  const configFile = path.join(dir, 'config', 'openclaw.json');
  let existingMeta: unknown;
  if (existsSync(configFile)) {
    try {
      existingMeta = (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>).meta;
    } catch {
      /* A malformed config will be replaced by the managed render below. */
    }
  }
  const renderedConfig = buildOpenclawConfig(tenant, { channelReady });
  if (existingMeta !== undefined) renderedConfig.meta = existingMeta;

  writeFileSync(
    configFile,
    JSON.stringify(renderedConfig, null, 2) + '\n',
  );

  writeFileSync(
    path.join(dir, 'docker-compose.yml'),
    template('docker-compose.yml', {
      IMAGE: imageRef,
      TENANT_ID: tenant.id,
      PORT: String(tenant.gatewayPort),
      MEM_LIMIT: asDockerMem(res.memoryGb),
      CPUS: String(res.cpus),
      PIDS_LIMIT: String(res.pidsLimit),
    }),
  );

  const sections = capabilitySections(tenant);
  const vars = {
    NAME: tenant.name,
    TENANT_ID: tenant.id,
    CHANNEL: tenant.channel,
    ENABLED_CAPABILITIES: sections.enabled,
    UPGRADE_CAPABILITIES: sections.upgrades,
    MANAGED_VERSION: managedVersion(),
  };

  writeFileSync(path.join(workspace, 'AGENTS.md'), template('workspace/AGENTS.md', vars));
  writeFileSync(path.join(workspace, 'HEARTBEAT.md'), template('workspace/HEARTBEAT.md', vars));

  const soul = path.join(workspace, 'SOUL.md');
  if (!existsSync(soul)) writeFileSync(soul, template('workspace/SOUL.md', vars));

  // skills/ and capabilities/ are fully managed — rebuild from scratch.
  const skillsDir = path.join(workspace, 'skills');
  rmSync(skillsDir, { recursive: true, force: true });
  const offloadDir = path.join(skillsDir, 'offload-radar');
  mkdirSync(offloadDir, { recursive: true });
  writeFileSync(
    path.join(offloadDir, 'SKILL.md'),
    template('workspace/skills/offload-radar/SKILL.md', vars),
  );

  const capsDir = path.join(workspace, 'capabilities');
  rmSync(capsDir, { recursive: true, force: true });
  mkdirSync(capsDir, { recursive: true });
  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    const def = capability(id as CapabilityId);
    writeFileSync(path.join(capsDir, `${id}.md`), def.workspaceDoc);
  }

  const nudgesDir = path.join(workspace, 'nudges');
  mkdirSync(nudgesDir, { recursive: true });
  const delivered = path.join(nudgesDir, 'DELIVERED.md');
  if (!existsSync(delivered)) writeFileSync(delivered, '# Delivered nudges\n\n');

  return renderEnv(tenant, dir);
}
