import { execFileSync } from 'node:child_process';
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

export function composeUp(tenant: Tenant): void {
  const dir = tenantDir(tenant.id);
  docker(['compose', 'up', '-d', '--remove-orphans'], dir);
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
