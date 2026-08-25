import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tenantDir } from '../store.js';
import type { Tenant } from '../types.js';

function docker(args: string[], cwd?: string): string {
  return execFileSync('docker', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function dockerAvailable(): boolean {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * External plugins live in the tenant's bind-mounted config dir
 * (config/npm/projects/<slug>-<hash>/), so an install survives container
 * recreation — but nothing ever performed that install, which is why a
 * rendered config could reference a plugin the gateway did not have.
 * Checking host-side avoids an exec per tenant per deploy.
 */
function pluginInstalled(tenant: Tenant, pkg: string): boolean {
  const slug = pkg.replace(/^@/, '').replace(/\//g, '-');
  const projects = path.join(tenantDir(tenant.id), 'config', 'npm', 'projects');
  if (!existsSync(projects)) return false;
  return readdirSync(projects).some((entry) => entry.startsWith(`${slug}-`));
}

/**
 * Install any declared plugin this tenant is missing. Best-effort by design:
 * a registry hiccup must not fail a fleet rollout, and the next apply retries.
 * Returns the packages newly installed (the caller restarts to load them).
 */
export function ensurePlugins(tenant: Tenant, packages: string[]): string[] {
  const installed: string[] = [];
  for (const pkg of packages) {
    if (pluginInstalled(tenant, pkg)) continue;
    try {
      docker(['exec', `openclaw-${tenant.id}`, 'openclaw', 'plugins', 'install', pkg]);
      installed.push(pkg);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      // Already-present is success; the host-side check can miss a rename.
      if (/plugin already exists/i.test(detail)) continue;
      console.warn(`  ${tenant.id}: could not install ${pkg} (${detail}); retrying next apply`);
    }
  }
  return installed;
}

export function composeUp(tenant: Tenant, plugins: string[] = []): void {
  const dir = tenantDir(tenant.id);
  docker(['compose', 'up', '-d', '--remove-orphans'], dir);
  // Between up and restart: the restart below is what loads them.
  ensurePlugins(tenant, plugins);
  // A config-only change (openclaw.json is bind-mounted, so the compose file is
  // unchanged) makes `up -d` a no-op and the gateway hot-reloads in place — but
  // hot-reloading the Telegram channel leaks the old long-poll loop, so two
  // pollers fight over getUpdates and inbound messages silently vanish. A full
  // restart guarantees exactly one poller.
  docker(['compose', 'restart'], dir);
}

export function composeDown(tenant: Tenant): void {
  docker(['compose', 'down'], tenantDir(tenant.id));
}

export function containerStatus(tenant: Tenant): string {
  try {
    const out = docker([
      'ps',
      '--all',
      '--filter',
      `name=openclaw-${tenant.id}`,
      '--format',
      '{{.Status}}',
    ]).trim();
    return out || 'not created';
  } catch {
    return 'docker unavailable';
  }
}

export function pullImage(image: string): void {
  execFileSync('docker', ['pull', image], { stdio: 'inherit' });
}

/** Resolve the digest-pinned ref for an image so the whole fleet runs one build. */
export function resolveDigest(image: string): string | undefined {
  try {
    const out = docker(['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}']).trim();
    return out && out !== '<no value>' ? out : undefined;
  } catch {
    return undefined;
  }
}
