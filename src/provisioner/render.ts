import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, capability } from '../capabilities/registry.js';
import { TEMPLATES_DIR, tenantDir } from '../store.js';
import type { CapabilityId, Fleet, Tenant } from '../types.js';

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

function channelConfig(tenant: Tenant): Record<string, unknown> {
  const allowFrom = tenant.contact.phone ? [tenant.contact.phone] : [];
  switch (tenant.channel) {
    case 'telegram':
      return {
        telegram: {
          enabled: true,
          botToken: '${TELEGRAM_BOT_TOKEN}',
          // Telegram allowlists use tg ids; pairing lets the customer approve themselves on first message.
          dmPolicy: 'pairing',
        },
      };
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
export function buildOpenclawConfig(tenant: Tenant): Record<string, unknown> {
  let config: Record<string, unknown> = {
    gateway: {
      port: 18789,
      bind: 'lan', // container port is published only on the host's loopback (see compose file)
      auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' },
    },
    agents: {
      defaults: {
        workspace: '/home/node/.openclaw/workspace',
        model: { primary: 'anthropic/claude-sonnet-4-6' },
        heartbeat: { every: '30m', target: 'last' },
        sandbox: { mode: 'non-main', scope: 'agent' },
      },
    },
    channels: channelConfig(tenant),
    session: {
      dmScope: 'per-channel-peer',
      reset: { mode: 'daily', atHour: 4 },
    },
  };

  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    config = deepMerge(config, capability(id as CapabilityId).configPatch(tenant));
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
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const imageRef = fleet.pinnedImageRef ?? fleet.image;

  writeFileSync(
    path.join(dir, 'config', 'openclaw.json'),
    JSON.stringify(buildOpenclawConfig(tenant), null, 2) + '\n',
  );

  writeFileSync(
    path.join(dir, 'docker-compose.yml'),
    template('docker-compose.yml', {
      IMAGE: imageRef,
      TENANT_ID: tenant.id,
      PORT: String(tenant.gatewayPort),
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
