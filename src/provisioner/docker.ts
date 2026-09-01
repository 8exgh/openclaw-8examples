import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Marker written into a plugin's project dir once capability consent is recorded. */
const CONSENT_MARKER = '.moc-capability-consent';

/**
 * Plugin projects already on this tenant's disk, however they got there
 * (control plane, hand-installed, another release's CLI). The wrapper
 * project's single dependency names the actual plugin package.
 */
function pluginProjects(tenant: Tenant): { dir: string; pkg: string }[] {
  const projects = path.join(tenantDir(tenant.id), 'config', 'npm', 'projects');
  if (!existsSync(projects)) return [];
  const out: { dir: string; pkg: string }[] = [];
  for (const entry of readdirSync(projects)) {
    const dir = path.join(projects, entry);
    try {
      const deps = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }).dependencies;
      const pkg = Object.keys(deps ?? {})[0];
      if (pkg) out.push({ dir, pkg });
    } catch {
      /* not a plugin project */
    }
  }
  return out;
}

/**
 * An `openclaw plugins` subcommand in a one-off container against the
 * tenant's mounts, never via exec into the gateway: since 2026.8.1 the
 * gateway EXITS when a configured plugin lacks capability consent, so such a
 * tenant crash-loops and an exec races the ~10s restart window (and dies
 * half-staged when it loses, leaving a project dir the registry cannot see).
 */
function pluginCommand(tenant: Tenant, args: string[]): void {
  docker(
    ['compose', 'run', '--rm', '--no-deps', 'openclaw', 'openclaw', 'plugins', ...args],
    tenantDir(tenant.id),
  );
}

/** Everything a spawn failure can tell us — stderr/stdout are not always in message. */
function errText(err: unknown): string {
  const e = err as { message?: string; stderr?: string; stdout?: string };
  return [e.message, e.stderr, e.stdout].filter(Boolean).join('\n');
}

/** Consent is per plugin, not per staged dir — mark every dir of the package. */
function writeConsentMarkers(tenant: Tenant, pkg: string): void {
  for (const project of pluginProjects(tenant)) {
    if (project.pkg === pkg) {
      writeFileSync(path.join(project.dir, CONSENT_MARKER), new Date().toISOString() + '\n');
    }
  }
}

/**
 * Install any declared plugin this tenant is missing, and record the
 * capability consent 2026.8.1 requires for every plugin already on disk
 * (hand-installed, or installed by the pre-2.0 CLI, which had no consent to
 * record — without it the v2 gateway refuses ready and crash-loops).
 * Best-effort by design: a registry hiccup must not fail a fleet rollout, and
 * the next apply retries. Returns the packages newly installed (the caller
 * restarts to load them).
 *
 * Consent state lives inside the tenant's SQLite, so a marker file in each
 * project dir tracks it host-side. The marker is written only when the
 * consent-flag install succeeded — the pre-2.0 CLI rejects the flag, leaving
 * no marker, so the pass retries once the tenant actually runs 2026.8.1+.
 */
export function ensurePlugins(tenant: Tenant, packages: string[]): string[] {
  const installed: string[] = [];

  const dirsByPkg = new Map<string, string[]>();
  for (const project of pluginProjects(tenant)) {
    dirsByPkg.set(project.pkg, [...(dirsByPkg.get(project.pkg) ?? []), project.dir]);
  }
  for (const [pkg, dirs] of dirsByPkg) {
    if (dirs.some((d) => existsSync(path.join(d, CONSENT_MARKER)))) continue;
    try {
      try {
        pluginCommand(tenant, ['install', pkg, '--accept-capabilities']);
      } catch (err) {
        const text = errText(err);
        if (/unknown option|unknown argument/i.test(text)) continue; // pre-2.0 CLI: no consent to record yet
        if (!/plugin already exists/i.test(text)) throw err;
        // Tracked plugin (install refuses to overwrite): `update` re-stages
        // the current build — upgrading a stale pre-2.0 build along the way —
        // and records the consent.
        pluginCommand(tenant, ['update', pkg, '--accept-capabilities']);
      }
      writeConsentMarkers(tenant, pkg);
    } catch (err) {
      console.warn(`  ${tenant.id}: could not record plugin consent for ${pkg} (${errText(err).split('\n')[0]}); retrying next apply`);
    }
  }

  for (const pkg of packages) {
    if (pluginInstalled(tenant, pkg)) continue; // the consent pass above covered it
    try {
      try {
        pluginCommand(tenant, ['install', pkg, '--accept-capabilities']);
        writeConsentMarkers(tenant, pkg);
      } catch (err) {
        if (!/unknown option|unknown argument/i.test(errText(err))) throw err;
        pluginCommand(tenant, ['install', pkg]);
      }
      installed.push(pkg);
    } catch (err) {
      const text = errText(err);
      // Already-present is success; the host-side check can miss a rename.
      if (/plugin already exists/i.test(text)) continue;
      console.warn(`  ${tenant.id}: could not install ${pkg} (${text.split('\n')[0]}); retrying next apply`);
    }
  }
  return installed;
}

export function composeUp(tenant: Tenant, plugins: string[] = []): void {
  const dir = tenantDir(tenant.id);
  // Install before first start: a 2026.8.1+ gateway that boots with a
  // configured-but-missing plugin refuses ready and crash-loops.
  ensurePlugins(tenant, plugins);
  docker(['compose', 'up', '-d', '--remove-orphans'], dir);
  // A config-only change (openclaw.json is bind-mounted, so the compose file is
  // unchanged) makes `up -d` a no-op and the gateway hot-reloads in place — but
  // hot-reloading the Telegram channel leaks the old long-poll loop, so two
  // pollers fight over getUpdates and inbound messages silently vanish. A full
  // restart guarantees exactly one poller. It is also what loads plugins
  // installed above when the container already existed.
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
