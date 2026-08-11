import { CAPABILITIES, isCapabilityId } from './capabilities/registry.js';
import { applyTenant, offboardTenant, runNudge, runNudgesAll, setCapability, signup, summarize, updateFleet } from './ops.js';
import { managedVersion } from './provisioner/render.js';
import { getTenant, loadFleet, loadTenants, tenantDir } from './store.js';
import type { ChannelId } from './types.js';

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(flags: Map<string, string | true>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

function reportApply(result: { tenant: { id: string }; missingEnv: string[]; started: boolean }): void {
  console.log(`  rendered: ${tenantDir(result.tenant.id)}`);
  console.log(`  container: ${result.started ? 'started' : 'not started (docker off or --no-start)'}`);
  if (result.missingEnv.length) {
    console.log(`  fill these in ${tenantDir(result.tenant.id)}/.env then run: npm run cli -- apply ${result.tenant.id}`);
    for (const key of result.missingEnv) console.log(`    - ${key}`);
  }
}

const HELP = `managed-openclaw — control plane for a fleet of managed OpenClaw assistants

Usage: npm run cli -- <command> [args]

  signup --name <name> [--phone +1555...] [--email a@b.com]
         [--channel whatsapp|telegram|signal] [--enable email,sms] [--no-start]
                                Provision a new person's managed assistant
  list                          All tenants, one line each
  show <tenant>                 Tenant detail incl. nudge history
  enable <tenant> <capability>  Switch a capability on (re-renders + restarts)
  disable <tenant> <capability> Switch a capability off
  apply <tenant>                Re-render on current templates/config + restart
  nudge [tenant]                Run the nudge engine (all tenants if omitted)
  update [--canary <tenant>]    Fleet update: pull newest OpenClaw, re-render
                                every tenant, rolling restart. With --canary,
                                that tenant updates first and must pass a
                                health check before the rollout continues
  offboard <tenant>             Stop the tenant's runtime, mark inactive,
                                reclaim the port
  offboard <tenant> --purge-data --yes
                                ...and delete all stored data incl. contact
                                info (deletion-request path; irreversible)
  status                        Fleet + per-tenant container status
  serve [--port 8787]           Start the HTTP control-plane API

Capabilities: ${CAPABILITIES.map((c) => c.id).join(', ')}
Flags: --no-start (or MOC_NO_START=1) renders without touching docker
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const start = flags.has('no-start') ? false : undefined;

  switch (command) {
    case 'signup': {
      const name = str(flags, 'name');
      if (!name) throw new Error('signup requires --name');
      const enable = (str(flags, 'enable') ?? '').split(',').map((s) => s.trim()).filter(isCapabilityId);
      const result = signup(
        {
          name,
          phone: str(flags, 'phone'),
          email: str(flags, 'email'),
          channel: str(flags, 'channel') as ChannelId | undefined,
          enable,
        },
        { start },
      );
      console.log(`Signed up "${name}" as tenant ${result.tenant.id} (port ${result.tenant.gatewayPort})`);
      reportApply(result);
      break;
    }
    case 'list': {
      for (const t of loadTenants()) {
        const s = summarize(t);
        const caps = Object.entries(s.capabilities).filter(([, on]) => on).map(([id]) => id).join(',');
        console.log(`${s.id}\t${s.channel}\tport ${s.gatewayPort}\t[${caps}]\t${s.container}${s.upToDate ? '' : '\t(update pending)'}${s.offboarded ? '\t(offboarded)' : ''}`);
      }
      break;
    }
    case 'show': {
      const tenant = getTenant(positional[0]);
      console.log(JSON.stringify({ ...summarize(tenant), nudgeLog: tenant.nudgeLog, contact: tenant.contact }, null, 2));
      break;
    }
    case 'enable':
    case 'disable': {
      const [tenantId, capabilityId] = positional;
      if (!tenantId || !capabilityId || !isCapabilityId(capabilityId)) {
        throw new Error(`Usage: ${command} <tenant> <${CAPABILITIES.map((c) => c.id).join('|')}>`);
      }
      const result = setCapability(tenantId, capabilityId, command === 'enable', { start });
      console.log(`${command}d ${capabilityId} for ${tenantId}`);
      reportApply(result);
      break;
    }
    case 'apply': {
      const result = applyTenant(getTenant(positional[0]), { start });
      console.log(`Applied ${managedVersion()} to ${positional[0]}`);
      reportApply(result);
      break;
    }
    case 'nudge': {
      const results = positional[0]
        ? [{ tenant: positional[0], nudge: runNudge(getTenant(positional[0])) }]
        : runNudgesAll();
      for (const r of results) {
        console.log(r.nudge ? `${r.tenant}: [${r.nudge.id}] ${r.nudge.text}` : `${r.tenant}: quiet (cooldowns)`);
      }
      break;
    }
    case 'update': {
      const result = await updateFleet({ start, canary: str(flags, 'canary') });
      console.log(`Fleet now on ${result.imageRef} / managed ${result.managedVersion}`);
      if (result.previousImageRef) console.log(`  rollback target: ${result.previousImageRef}`);
      for (const t of result.tenants) {
        console.log(`  ${t.id}: ${t.started ? 'restarted' : 'rendered'}${t.missingEnv.length ? ` (missing env: ${t.missingEnv.join(', ')})` : ''}`);
      }
      break;
    }
    case 'offboard': {
      const tenantId = positional[0];
      if (!tenantId) throw new Error('Usage: offboard <tenant> [--purge-data --yes]');
      const purge = flags.has('purge-data');
      if (purge && !flags.has('yes')) {
        throw new Error(`--purge-data permanently deletes tenants/${tenantId}/ and the stored record. Re-run with --yes to confirm.`);
      }
      const result = offboardTenant(tenantId, { purge });
      console.log(purge ? `Purged ${result.tenant}: runtime stopped, data and record deleted.` : `Offboarded ${result.tenant}: runtime stopped, port reclaimed, data retained.`);
      break;
    }
    case 'status': {
      const fleet = loadFleet();
      console.log(`release: ${fleet.pinnedImageRef ?? fleet.image} | managed: ${managedVersion()} | tenants: ${loadTenants().length}`);
      for (const t of loadTenants()) {
        const s = summarize(t);
        console.log(`  ${s.id}: ${s.container}${s.upToDate ? '' : ' (update pending)'}`);
      }
      break;
    }
    case 'serve': {
      const { startServer } = await import('./server.js');
      await startServer(Number(str(flags, 'port') ?? 8787));
      break;
    }
    default:
      console.log(HELP);
      if (command && command !== 'help') process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
