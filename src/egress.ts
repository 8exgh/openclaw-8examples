import { execFileSync } from 'node:child_process';
import { getTenant, loadFleet, loadTenants, saveFleet, upsertTenant } from './store.js';
import type { ExitNode, Fleet, Tenant } from './types.js';

/**
 * Residential egress: tenant VMs join the tailnet (base-image 65-tailscale.sh)
 * and route all traffic through a residential exit node. The pool lives in
 * fleet config; each desktop-tier tenant gets a sticky assignment at signup
 * (least-loaded) so egress IPs never flap mid-session — messaging platforms
 * treat IP changes as an account-risk signal. Failover is a deliberate,
 * logged `egress migrate`, never automatic.
 */

export const DEFAULT_TENANT_TAG = 'tag:dc-egress';

/** MagicDNS name of a tenant's VM; the seed sets the same --hostname. */
export function vmHostname(tenantId: string): string {
  return `openclaw-${tenantId}`;
}

export function exitNodePool(fleet: Fleet): ExitNode[] {
  return fleet.egress?.exitNodes ?? [];
}

export function tenantTag(fleet: Fleet): string {
  return fleet.egress?.tenantTag ?? DEFAULT_TENANT_TAG;
}

/** Active desktop-tier tenants — the only ones that consume an exit node. */
function egressTenants(tenants: Tenant[]): Tenant[] {
  return tenants.filter((t) => !t.offboardedAt && (t.tier ?? 'container') === 'desktop');
}

export function assignmentCounts(fleet: Fleet, tenants: Tenant[]): Map<string, number> {
  const counts = new Map(exitNodePool(fleet).map((n) => [n.name, 0]));
  for (const t of egressTenants(tenants)) {
    const node = t.egress?.exitNode;
    if (node && counts.has(node)) counts.set(node, counts.get(node)! + 1);
  }
  return counts;
}

/** Least-loaded node in the pool (pool order breaks ties); undefined when the pool is empty. */
export function pickExitNode(fleet: Fleet, tenants: Tenant[]): string | undefined {
  const counts = assignmentCounts(fleet, tenants);
  let best: string | undefined;
  for (const node of exitNodePool(fleet)) {
    if (best === undefined || counts.get(node.name)! < counts.get(best)!) best = node.name;
  }
  return best;
}

export function addExitNode(name: string, opts: { expectedIp?: string; location?: string } = {}): ExitNode {
  const fleet = loadFleet();
  const pool = exitNodePool(fleet);
  const existing = pool.find((n) => n.name === name);
  const node: ExitNode = { ...existing, name, ...opts };
  fleet.egress = {
    ...fleet.egress,
    exitNodes: existing ? pool.map((n) => (n.name === name ? node : n)) : [...pool, node],
  };
  saveFleet(fleet);
  return node;
}

export function removeExitNode(name: string): void {
  const fleet = loadFleet();
  const pool = exitNodePool(fleet);
  if (!pool.some((n) => n.name === name)) throw new Error(`Unknown exit node: ${name}`);
  const assigned = egressTenants(loadTenants()).filter((t) => t.egress?.exitNode === name);
  if (assigned.length) {
    throw new Error(
      `Exit node ${name} still carries ${assigned.length} tenant(s): ${assigned.map((t) => t.id).join(', ')}. ` +
        `Move them first: npm run cli -- egress migrate --from ${name} --to <node>`,
    );
  }
  fleet.egress = { ...fleet.egress, exitNodes: pool.filter((n) => n.name !== name) };
  saveFleet(fleet);
}

function requirePoolNode(fleet: Fleet, name: string): ExitNode {
  const node = exitNodePool(fleet).find((n) => n.name === name);
  if (!node) {
    const pool = exitNodePool(fleet).map((n) => n.name).join(', ') || '(pool is empty — egress add-node first)';
    throw new Error(`Exit node not in pool: ${name}. Known: ${pool}`);
  }
  return node;
}

/** Record-only assignment; takes effect at the next seed render (or via `egress migrate` on a live VM). */
export function assignEgress(tenantId: string, nodeName: string): Tenant {
  const tenant = getTenant(tenantId);
  requirePoolNode(loadFleet(), nodeName);
  tenant.egress = { exitNode: nodeName, assignedAt: new Date().toISOString() };
  upsertTenant(tenant);
  return tenant;
}

/**
 * Run a command on a tenant VM over the tailnet. Requires key-based SSH to the
 * VM's `openclaw` user; the seed passes --operator=openclaw so `tailscale set`
 * needs no sudo.
 */
export function sshVm(host: string, command: string): string {
  return execFileSync(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      // Clone VMs regenerate host keys on first boot; the tailnet is the trust boundary here.
      '-o', 'StrictHostKeyChecking=accept-new',
      `openclaw@${host}`,
      command,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export interface MigrateResult {
  tenant: string;
  ok: boolean;
  detail: string;
}

/**
 * Live-move VM egress: `tailscale set --exit-node=<to>` over SSH, then update
 * the record. Either one tenant (`tenantId`) or every desktop tenant currently
 * assigned to `from`. This changes those tenants' public IP — deliberate
 * failover/rebalance only.
 */
export function migrateEgress(opts: {
  tenantId?: string;
  from?: string;
  to: string;
  dryRun?: boolean;
}): MigrateResult[] {
  const fleet = loadFleet();
  requirePoolNode(fleet, opts.to);
  if (!opts.tenantId && !opts.from) throw new Error('egress migrate needs --tenant <id> or --from <node>');
  if (opts.tenantId && opts.from) throw new Error('egress migrate takes --tenant or --from, not both');
  if (opts.from) {
    requirePoolNode(fleet, opts.from);
    if (opts.from === opts.to) throw new Error('--from and --to are the same node');
  }

  let targets: Tenant[];
  if (opts.tenantId) {
    const tenant = getTenant(opts.tenantId);
    if ((tenant.tier ?? 'container') !== 'desktop') {
      throw new Error(`${tenant.id} is container-tier — egress there is host-level, nothing to migrate`);
    }
    targets = [tenant];
  } else {
    targets = egressTenants(loadTenants()).filter((t) => t.egress?.exitNode === opts.from);
  }

  const results: MigrateResult[] = [];
  for (const tenant of targets) {
    const host = vmHostname(tenant.id);
    const command = `tailscale set --exit-node=${opts.to}`;
    if (opts.dryRun) {
      results.push({ tenant: tenant.id, ok: true, detail: `would run: ssh openclaw@${host} ${command}` });
      continue;
    }
    try {
      sshVm(host, command);
      tenant.egress = { exitNode: opts.to, assignedAt: new Date().toISOString() };
      upsertTenant(tenant);
      results.push({ tenant: tenant.id, ok: true, detail: `now egressing via ${opts.to}` });
    } catch (err) {
      results.push({
        tenant: tenant.id,
        ok: false,
        detail: `ssh to ${host} failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — record unchanged`,
      });
    }
  }
  return results;
}

interface TailscalePeer {
  HostName?: string;
  Online?: boolean;
}

/**
 * Online state per tailnet machine, from the control-plane host's tailscale
 * CLI. Undefined when the host isn't on the tailnet / CLI is missing.
 */
export function tailscaleOnline(): Map<string, boolean> | undefined {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const status = JSON.parse(out) as { Self?: TailscalePeer; Peer?: Record<string, TailscalePeer> };
    const map = new Map<string, boolean>();
    // Self is this host: if we can ask, it's online.
    if (status.Self?.HostName) map.set(status.Self.HostName.toLowerCase(), true);
    for (const peer of Object.values(status.Peer ?? {})) {
      if (peer.HostName) map.set(peer.HostName.toLowerCase(), !!peer.Online);
    }
    return map;
  } catch {
    return undefined;
  }
}

export interface NodeCheck {
  node: ExitNode;
  assigned: number;
  /** Undefined when the control-plane host has no tailscale CLI. */
  online?: boolean;
  /** Public IP observed by curling through an assigned VM (end-to-end probe). */
  observedIp?: string;
  probeTenant?: string;
  /** Only set when both expectedIp and observedIp are known. */
  ipMatch?: boolean;
  errors: string[];
}

export interface EgressCheckResult {
  nodes: NodeCheck[];
  /** Human-readable problem lines; non-empty means unhealthy (exit non-zero). */
  problems: string[];
  tailscaleAvailable: boolean;
}

/**
 * Health pass for cron: is each exit node online, and do tenants behind it
 * actually egress from the expected residential IP? Exit nodes fail closed
 * (tenant traffic blackholes when one dies), so an offline node is a page,
 * not a footnote. Alert-only by design — migration stays a human decision.
 */
export function checkEgress(): EgressCheckResult {
  const fleet = loadFleet();
  const pool = exitNodePool(fleet);
  const online = tailscaleOnline();
  const tenants = egressTenants(loadTenants());
  const problems: string[] = [];

  const nodes = pool.map((node) => {
    const assigned = tenants.filter((t) => t.egress?.exitNode === node.name);
    const check: NodeCheck = { node, assigned: assigned.length, errors: [] };

    if (online) {
      check.online = online.get(node.name.toLowerCase());
      if (check.online === undefined) check.errors.push('not found in tailnet (check the machine name)');
      else if (!check.online) check.errors.push('offline in tailnet');
    }

    // End-to-end probe: a VM assigned to this node should see the node's
    // public IP as its own. Try up to two VMs before calling it unreachable.
    const probeErrors: string[] = [];
    for (const tenant of assigned.slice(0, 2)) {
      try {
        const ip = sshVm(vmHostname(tenant.id), 'curl -4fsS --max-time 10 https://api.ipify.org').trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`unexpected probe output: ${ip.slice(0, 60)}`);
        check.observedIp = ip;
        check.probeTenant = tenant.id;
        if (node.expectedIp) {
          check.ipMatch = ip === node.expectedIp;
          if (!check.ipMatch) {
            check.errors.push(
              `egress IP ${ip} != expected ${node.expectedIp} (ISP re-lease? update with: egress add-node ${node.name} --ip ${ip})`,
            );
          }
        }
        break;
      } catch (err) {
        probeErrors.push(
          `probe via ${tenant.id} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        );
      }
    }
    if (assigned.length && !check.observedIp) {
      check.errors.push(...(probeErrors.length ? probeErrors : ['no reachable VM to probe through']));
    }

    problems.push(...check.errors.map((e) => `${node.name}: ${e}`));
    return check;
  });

  return { nodes, problems, tailscaleAvailable: online !== undefined };
}
