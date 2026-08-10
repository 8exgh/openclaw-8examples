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
  docker(['compose', 'up', '-d', '--remove-orphans'], tenantDir(tenant.id));
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
