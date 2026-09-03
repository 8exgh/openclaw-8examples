import { existsSync, readFileSync } from 'node:fs';
import { CAPABILITIES, isCapabilityId } from './capabilities/registry.js';
import {
  addExitNode,
  assignEgress,
  assignmentCounts,
  checkEgress,
  exitNodePool,
  migrateEgress,
  removeExitNode,
  tailscaleOnline,
  tenantTag,
} from './egress.js';
import { applyOpenAIAuth, applyTenant, offboardTenant, pinTenantImage, runNudge, runNudgesAll, setAgentTimeout, setCapability, setModelAccess, setModelGateway, signup, summarize, syncModelAccess, updateFleet } from './ops.js';
import { managedVersion } from './provisioner/render.js';
import { renderSeed } from './provisioner/seed.js';
import { getTenant, loadFleet, loadTenants, tenantDir } from './store.js';
import type { ChannelId, Tier } from './types.js';

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

/** Compact display form for digest-pinned image refs. */
function shortRef(ref: string): string {
  return ref.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@$1…');
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

  signup --name <name> [--id <id>] [--phone +1555...] [--email a@b.com]
         [--channel whatsapp|telegram|signal] [--enable email,sms]
         [--tier container|desktop] [--no-start]
                                Provision a new person's managed assistant
                                (desktop tier also gets a residential exit node
                                from the egress pool, least-loaded)
  list                          All tenants, one line each
  show <tenant>                 Tenant detail incl. nudge history
  enable <tenant> <capability>  Switch a capability on (re-renders + restarts)
  disable <tenant> <capability> Switch a capability off
  apply <tenant>                Re-render on current templates/config + restart
  pin <tenant> <image-ref>      Run one tenant on a specific OpenClaw release
                                (digest-pinned; the canary path for a major
                                upgrade). Fleet updates leave the pin alone.
  pin <tenant> --fleet          Return the tenant to the fleet release — mind
                                one-way migrations before pinning backwards
  model-gateway <tenant> <url>  Route the tenant's model calls through the
                                shared model-gateway (e.g. http://model-gateway:8790).
                                Takes effect once a minted MODEL_GATEWAY_KEY is
                                in the tenant's .env; re-run apply after adding it.
  model-gateway <tenant> --off  Back to direct provider wiring (instant rollback)
  set-timeout <tenant> <seconds>
                                Set interactive agent timeout (60-3600) + restart
  apply-openai <tenant> <credential-file>
                                Install a ChatGPT/Codex OAuth credential as the
                                tenant's OpenAI fallback auth profile
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
  seed <tenant> [--authkey tskey-...] [--claude-token <tok> | --claude-token-file <path>]
                                Render the desktop-tier VM's first-boot NoCloud
                                seed (tailnet join + exit node + Claude token);
                                authkey falls back to MOC_TS_AUTHKEY
  egress nodes                  Residential exit-node pool, assignments, status
  egress add-node <name> [--ip <expected-egress-ip>] [--location <note>]
  egress remove-node <name>
  egress assign <tenant> <node> Record an assignment (applies at next seed)
  egress migrate --to <node> (--tenant <id> | --from <node>) [--dry-run]
                                Live-move VM egress (tailscale set over SSH)
  egress check                  Exit nodes online + egress IPs as expected
                                (cron this; exits non-zero on problems)
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
      const tier = str(flags, 'tier');
      if (tier && tier !== 'container' && tier !== 'desktop') {
        throw new Error(`--tier must be container or desktop, got: ${tier}`);
      }
      const result = signup(
        {
          name,
          id: str(flags, 'id'),
          phone: str(flags, 'phone'),
          email: str(flags, 'email'),
          channel: str(flags, 'channel') as ChannelId | undefined,
          tier: tier as Tier | undefined,
          enable,
        },
        { start },
      );
      if (result.tenant.egress) {
        console.log(`  egress: via ${result.tenant.egress.exitNode} (render the VM seed: npm run cli -- seed ${result.tenant.id})`);
      }
      console.log(`Signed up "${name}" as tenant ${result.tenant.id} (port ${result.tenant.gatewayPort})`);
      reportApply(result);
      break;
    }
    case 'model-access': {
      const [action, tenantId, state] = positional;
      if (action === 'set') {
        if (!tenantId || (state !== 'assigned' && state !== 'suppressed')) {
          throw new Error('Usage: model-access set <tenant> <assigned|suppressed>');
        }
        const result = setModelAccess(tenantId, state === 'assigned', { start });
        console.log(`${tenantId}: model access ${state}`);
        reportApply(result);
        break;
      }
      if (action === 'sync') {
        const ids = new Set((str(flags, 'assigned') ?? '').split(',').map((id) => id.trim()).filter(Boolean));
        const result = syncModelAccess(ids);
        if (flags.has('apply')) {
          for (const id of result.changed) setModelAccess(id, ids.has(id), { start });
        }
        console.log(`Model access synchronized: ${result.assigned} assigned, ${result.suppressed} suppressed, ${result.changed.length} changed${flags.has('apply') ? ' and applied' : ''}`);
        break;
      }
      throw new Error('Usage: model-access <set <tenant> <assigned|suppressed> | sync --assigned id,id,...>');
    }
    case 'list': {
      for (const t of loadTenants()) {
        const s = summarize(t);
        const caps = Object.entries(s.capabilities).filter(([, on]) => on).map(([id]) => id).join(',');
        console.log(`${s.id}\t${s.channel}\tport ${s.gatewayPort}\t[${caps}]\t${s.container}${s.egress ? `\tvia ${s.egress}` : ''}${s.pinnedImageRef ? `\t(pinned ${shortRef(s.pinnedImageRef)})` : ''}${s.modelGatewayUrl ? '\t(model-gateway)' : ''}${s.upToDate ? '' : '\t(update pending)'}${s.offboarded ? '\t(offboarded)' : ''}`);
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
    case 'pin': {
      const [tenantId, ref] = positional;
      const toFleet = flags.has('fleet');
      if (!tenantId || (!ref && !toFleet)) {
        throw new Error('Usage: pin <tenant> <image-ref> | pin <tenant> --fleet');
      }
      const result = pinTenantImage(tenantId, toFleet ? null : ref, { start });
      console.log(
        toFleet
          ? `${tenantId}: back on the fleet release`
          : `${tenantId}: pinned to ${result.tenant.pinnedImageRef}`,
      );
      reportApply(result);
      break;
    }
    case 'model-gateway': {
      const [tenantId, url] = positional;
      const off = flags.has('off');
      if (!tenantId || (!url && !off)) {
        throw new Error('Usage: model-gateway <tenant> <url> | model-gateway <tenant> --off');
      }
      const result = setModelGateway(tenantId, off ? null : url, { start });
      if (off) {
        console.log(`${tenantId}: model calls back on direct provider wiring`);
      } else {
        const key = result.missingEnv.includes('MODEL_GATEWAY_KEY');
        console.log(`${tenantId}: model-gateway set to ${result.tenant.modelGatewayUrl}`);
        if (key) {
          console.log(
            `  NOT live yet: mint a key on the gateway box and put it in ` +
              `tenants/${tenantId}/.env as MODEL_GATEWAY_KEY, then run apply ${tenantId}`,
          );
        }
      }
      reportApply(result);
      break;
    }
    case 'set-timeout': {
      const [tenantId, rawSeconds] = positional;
      const timeoutSeconds = Number(rawSeconds);
      if (!tenantId || !rawSeconds) throw new Error('Usage: set-timeout <tenant> <seconds>');
      const result = setAgentTimeout(tenantId, timeoutSeconds, { start });
      console.log(`Set interactive agent timeout for ${tenantId} to ${timeoutSeconds} seconds`);
      reportApply(result);
      break;
    }
    case 'apply-openai': {
      const [tenantId, credentialFile] = positional;
      if (!tenantId || !credentialFile) {
        throw new Error('Usage: apply-openai <tenant> <credential-file>');
      }
      if (!existsSync(credentialFile)) {
        throw new Error(`Credential file not found: ${credentialFile}`);
      }
      const result = applyOpenAIAuth(tenantId, credentialFile, { start });
      console.log(`Installed OpenAI auth profile on ${tenantId}`);
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
        console.log(`  ${s.id}: ${s.container}${s.pinnedImageRef ? ` (pinned ${shortRef(s.pinnedImageRef)})` : ''}${s.modelGatewayUrl ? ' (model-gateway)' : ''}${s.upToDate ? '' : ' (update pending)'}`);
      }
      break;
    }
    case 'seed': {
      const tenantId = positional[0];
      if (!tenantId) throw new Error('Usage: seed <tenant> [--authkey tskey-...] [--claude-token <tok> | --claude-token-file <path>]');
      const authkey = str(flags, 'authkey') ?? process.env.MOC_TS_AUTHKEY;
      if (!authkey) {
        throw new Error(
          'seed needs a tailscale pre-auth key: --authkey tskey-... or MOC_TS_AUTHKEY. ' +
            'Create one in the tailscale admin console, tagged for your tenant VMs (see README egress section).',
        );
      }
      const tokenFile = str(flags, 'claude-token-file');
      const claudeToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : str(flags, 'claude-token');
      const result = renderSeed(getTenant(tenantId), { authkey, claudeToken });
      console.log(`Rendered first-boot seed for ${tenantId}`);
      console.log(`  hostname: ${result.hostname}`);
      console.log(`  egress: ${result.exitNode ? `via ${result.exitNode}` : 'no exit node (pool empty — egress add-node first if you want residential egress)'}`);
      console.log(`  claude token: ${claudeToken ? 'included' : 'not included'}`);
      console.log(`  seed dir: ${result.dir}`);
      if (result.isoPath) console.log(`  seed iso: ${result.isoPath} — attach as a CD-ROM to a fresh base-image overlay and boot`);
      else console.log(`  no ISO tool found — run inside the seed dir: ${result.isoCommand}`);
      console.log('  the seed holds the auth key — delete it once the VM has joined the tailnet');
      break;
    }
    case 'egress': {
      const sub = positional[0];
      switch (sub) {
        case 'nodes': {
          const fleet = loadFleet();
          const pool = exitNodePool(fleet);
          if (!pool.length) {
            console.log('No exit nodes configured. Add one: npm run cli -- egress add-node server2 --ip <home-ip>');
            break;
          }
          const counts = assignmentCounts(fleet, loadTenants());
          const online = tailscaleOnline();
          console.log(`tenant tag: ${tenantTag(fleet)}`);
          for (const node of pool) {
            const live = online ? (online.get(node.name.toLowerCase()) === undefined ? 'not in tailnet' : online.get(node.name.toLowerCase()) ? 'online' : 'OFFLINE') : 'unknown (no tailscale CLI here)';
            console.log(`  ${node.name}\t${counts.get(node.name)} tenant(s)\t${live}${node.expectedIp ? `\tip ${node.expectedIp}` : ''}${node.location ? `\t${node.location}` : ''}`);
          }
          break;
        }
        case 'add-node': {
          const name = positional[1];
          if (!name) throw new Error('Usage: egress add-node <name> [--ip <expected-egress-ip>] [--location <note>]');
          const node = addExitNode(name, { expectedIp: str(flags, 'ip'), location: str(flags, 'location') });
          console.log(`Exit node ${node.name} saved${node.expectedIp ? ` (expected egress IP ${node.expectedIp})` : ''}. New desktop signups shard across the pool.`);
          break;
        }
        case 'remove-node': {
          const name = positional[1];
          if (!name) throw new Error('Usage: egress remove-node <name>');
          removeExitNode(name);
          console.log(`Exit node ${name} removed from the pool.`);
          break;
        }
        case 'assign': {
          const [, tenantId, node] = positional;
          if (!tenantId || !node) throw new Error('Usage: egress assign <tenant> <node>');
          const tenant = assignEgress(tenantId, node);
          console.log(`${tenantId} assigned to ${node} (recorded).`);
          if ((tenant.tier ?? 'container') !== 'desktop') {
            console.log('  note: container-tier egress is host-level; this takes effect only if the tenant moves to the desktop tier');
          } else {
            console.log(`  applies at the next seed render; for a live VM run: npm run cli -- egress migrate --tenant ${tenantId} --to ${node}`);
          }
          break;
        }
        case 'migrate': {
          const to = str(flags, 'to');
          if (!to) throw new Error('Usage: egress migrate --to <node> (--tenant <id> | --from <node>) [--dry-run]');
          const results = migrateEgress({
            tenantId: str(flags, 'tenant'),
            from: str(flags, 'from'),
            to,
            dryRun: flags.has('dry-run'),
          });
          if (!results.length) console.log('Nothing to migrate.');
          for (const r of results) console.log(`  ${r.ok ? 'ok' : 'FAILED'}\t${r.tenant}\t${r.detail}`);
          if (results.some((r) => !r.ok)) process.exitCode = 1;
          break;
        }
        case 'check': {
          const result = checkEgress();
          if (!result.nodes.length) {
            console.log('No exit nodes configured — nothing to check.');
            break;
          }
          if (!result.tailscaleAvailable) {
            console.log('note: no tailscale CLI on this host — skipping tailnet online checks, probing via tenant VMs only');
          }
          for (const n of result.nodes) {
            const bits = [
              `${n.assigned} tenant(s)`,
              n.online === undefined ? (result.tailscaleAvailable ? 'not in tailnet' : 'online: unknown') : n.online ? 'online' : 'OFFLINE',
              n.observedIp ? `egress ip ${n.observedIp} (via ${n.probeTenant})${n.ipMatch === false ? ' MISMATCH' : ''}` : 'no probe',
            ];
            console.log(`  ${n.node.name}\t${bits.join('\t')}`);
          }
          if (result.problems.length) {
            console.error('PROBLEMS:');
            for (const p of result.problems) console.error(`  - ${p}`);
            const down = result.nodes.filter((n) => n.errors.length && n.assigned > 0);
            const up = result.nodes.filter((n) => !n.errors.length);
            if (down.length && up.length) {
              console.error(`Failover is deliberate — when you're sure, run: npm run cli -- egress migrate --from ${down[0].node.name} --to ${up[0].node.name}`);
            }
            process.exitCode = 1;
          } else {
            console.log('All egress healthy.');
          }
          break;
        }
        default:
          throw new Error('Usage: egress <nodes|add-node|remove-node|assign|migrate|check>');
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
