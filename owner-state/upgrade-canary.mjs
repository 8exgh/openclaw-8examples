// Explicit owner-requested release upgrade. Never runs the fleet provisioner.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statfsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOwnerIdle, assertSafePath } from './index.mjs';
import { checkpointOwnerImage } from './docker.mjs';

const root = process.env.MOC_ROOT;
const version = process.env.OPENCLAW_STABLE_VERSION;
if (!root || !/^\d{4}\.\d+\.\d+(?:-\d+)?$/.test(version || '')) throw new Error('Set the live checkout and an exact stable release.');
const dir = path.join(root, 'tenants/openclaw1'), container = 'openclaw-openclaw1';
const apply = process.env.OPENCLAW_UPGRADE_APPLY === '1';
// Qualified stable manifest, verified against both official registries.
const releases = { '2026.9.4': 'sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101' };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(root, 'owner-upgrade-backups', `openclaw1-${version}-${stamp}`);
let stage = 'inspection', stopped = false, activated = false, oldImage, oldState, oldCompose, rehearsal;
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const docker = (args, options) => run('docker', args, options);
const privateWrite = (file, body) => { writeFileSync(file, body, { mode: 0o600 }); chmodSync(file, 0o600); };
function step(name) { stage = name; console.log(`${new Date().toISOString()} ${name}`); }
function saveFailure(error) {
  privateWrite(path.join(backup, 'failure.log'), [stage, error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
}
function composeImage(text, image) {
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Invalid image digest');
  const matches = [...text.matchAll(/^    image:.*$/gm)];
  if (matches.length !== 1) throw new Error('Expected exactly one canary service image');
  return text.replace(/^    image:.*$/m, `    image: "${image}"`);
}
function repairSchema(image, mounts, envFile, logFile) {
  const helper = fileURLToPath(new URL('./repair-agent-schema-2026.9.4.mjs', import.meta.url));
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--env-file', envFile,
    '--env', 'OPENCLAW_UPGRADE_OFFLINE=1', '--mount', `type=bind,src=${helper},dst=/tmp/owner-upgrade-repair.mjs,readonly`,
    ...mounts, image, 'node', '/tmp/owner-upgrade-repair.mjs'], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  privateWrite(logFile, (result.stdout || '') + (result.stderr || ''));
  if (result.status !== 0) throw new Error(`Native database-only repair failed; private diagnostics: ${logFile}`);
  console.log(result.stdout.trim());
}
async function waitHealthy(name, logDir = backup) {
  for (let n = 0; n < 90; n++) {
    try {
      docker(['exec', name, 'node', '-e', "Promise.all(['/healthz','/readyz'].map(p=>fetch('http://127.0.0.1:18789'+p,{signal:AbortSignal.timeout(1500)}))).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1));"], { timeout: 6000 });
      return;
    } catch {
      try { const state = JSON.parse(docker(['inspect', name]))[0].State; if (!state.Running && !state.Restarting) break; } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const logs = spawnSync('docker', ['logs', '--tail', '250', name], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  privateWrite(path.join(logDir, `${name}.log`), (logs.stdout || '') + (logs.stderr || ''));
  throw new Error(`${name} failed health/readiness checks`);
}
function validate(name) {
  const installed = docker(['exec', name, 'openclaw', '--version']);
  if (!installed.includes(`OpenClaw ${version} `) && installed !== `OpenClaw ${version}`) throw new Error('Wrong installed release');
  const result = JSON.parse(docker(['exec', name, 'openclaw', 'config', 'validate', '--json']));
  if (result.valid !== true) throw new Error('Configuration validation failed');
  console.log(JSON.stringify({ container: name, installedVersion: installed, configurationValid: true }));
}

assertSafePath(dir); assertOwnerIdle(dir);
const tenant = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8')).find(t => t.id === 'openclaw1');
if (!tenant || tenant.offboardedAt || tenant.modelAccess === 'suppressed' || tenant.tier === 'desktop') throw new Error('Canary is not eligible');
const current = JSON.parse(docker(['inspect', container]))[0];
const installedVersion = docker(['exec', container, 'openclaw', '--version']);
console.log(JSON.stringify({ tenant: tenant.id, requestedVersion: version, installedVersion, node: docker(['exec', container, 'node', '--version']), image: current.Image, running: current.State.Running, health: current.State.Health?.Status, ownerAdministration: existsSync(path.join(dir, '.owner-admin')) }));
if (!apply) {
  const backups = path.join(root, 'owner-upgrade-backups');
  const latest = existsSync(backups) && readdirSync(backups).filter(p => p.startsWith(`openclaw1-${version}-`)).sort().at(-1);
  if (latest) {
    const folder = path.join(backups, latest);
    const secrets = new Set(current.Config.Env.map(value => value.slice(value.indexOf('=') + 1)).filter(value => value.length >= 4));
    const collect = value => { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) { if (/token|key|password|secret|authorization/i.test(key) && typeof item === 'string' && item.length >= 4) secrets.add(item); else collect(item); } };
    collect(JSON.parse(readFileSync(path.join(dir, 'config/openclaw.json'), 'utf8')));
    const redact = line => {
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) line = line.replaceAll(secret, '[REDACTED]');
      return line.replace(/https?:\/\/[^\s<>"']+/g, '[URL]').replace(/\b(?:sk-|pgw_)[A-Za-z0-9._-]+/g, '[REDACTED]').replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    };
    for (const file of readdirSync(folder).filter(p => p === 'failure.log' || /^openclaw-upgrade-rehearsal-.*\.log$/.test(p))) {
      const lines = readFileSync(path.join(folder, file), 'utf8').split('\n').filter(line => /error|fail|invalid|requir|doctor|migration|plugin|schema|listen|readiness|timed out/i.test(line)).slice(-45);
      console.log(JSON.stringify({ diagnosticFile: file, lines: lines.map(redact) }));
    }
    // Reproduce startup only on the retained isolated copy, capturing stderr
    // as well as stdout. No live mount, network, channel, or host port is used.
    const copied = path.join(folder, 'rehearsal-native-only');
    if (existsSync(path.join(folder, 'rehearsal'))) {
      if (!existsSync(copied)) {
        mkdirSync(copied, { mode: 0o700 });
        run('tar', ['--extract', '--file', path.join(folder, 'tenant.tar'), '--directory', copied], { timeout: 300000 });
      }
      const image = `openclaw-owner/openclaw1:stable-${version}-${latest.slice(`openclaw1-${version}-`.length).toLowerCase()}`;
      const name = `openclaw-upgrade-diagnostic-${process.pid}`;
      const mounts = current.Mounts.flatMap(m => ['--mount', `type=bind,src=${m.RW ? path.join(copied, path.relative(dir, m.Source)) : m.Source},dst=${m.Destination}${m.RW ? '' : ',readonly'}`]);
      const output = spawnSync('docker', ['run', '--rm', '--name', name, '--network', 'none', '--env-file', path.join(folder, 'runtime.env'), '--env', 'OPENCLAW_SKIP_CHANNELS=1', ...mounts, image, 'node', 'openclaw.mjs', 'gateway'], { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
      try { docker(['rm', '-f', name]); } catch {}
      const raw = (output.stdout || '') + (output.stderr || '');
      privateWrite(path.join(folder, 'isolated-diagnostic.log'), raw);
      console.log(JSON.stringify({ isolatedStartupExit: output.status, lines: raw.split('\n').slice(-50).map(redact) }));
      if (/SQLite schema is incomplete or noncanonical/.test(raw)) {
        const common = ['run', '--rm', '--network', 'none', '--env-file', path.join(folder, 'runtime.env'), '--env', 'OPENCLAW_SKIP_CHANNELS=1', ...mounts, image];
        const countScript = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite',{readOnly:true});const counts={};for(const table of ['session_nodes','session_windows','transcript_events'])counts[table]=db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;console.log(JSON.stringify(counts));db.close();";
        const before = JSON.parse(docker([...common, 'node', '-e', countScript]));
        const originalConfig = readFileSync(path.join(copied, 'config/openclaw.json'), 'utf8');
        repairSchema(image, mounts, path.join(folder, 'runtime.env'), path.join(folder, 'isolated-schema-repair.log'));
        const after = JSON.parse(docker([...common, 'node', '-e', countScript]));
        console.log(JSON.stringify({ beforeRepair: before, afterRepair: after, countsPreserved: JSON.stringify(before) === JSON.stringify(after), configurationUnchanged: readFileSync(path.join(copied, 'config/openclaw.json'), 'utf8') === originalConfig }));
        {
          const check = `openclaw-upgrade-repaired-${process.pid}`;
          try {
            docker(['run', '-d', '--name', check, '--network', 'none', '--env-file', path.join(folder, 'runtime.env'), '--env', 'OPENCLAW_SKIP_CHANNELS=1', ...mounts, image, 'node', 'openclaw.mjs', 'gateway']);
            await waitHealthy(check, folder); validate(check);
            console.log('PASS: the repaired copied state starts successfully on the new version.');
          } finally { try { docker(['rm', '-f', check]); } catch {} }
        }
      }
    }
  }
  process.exit(0);
}
if (!existsSync(path.join(dir, '.owner-admin'))) throw new Error('This upgrade requires the owner-preserving canary');
if (installedVersion.includes(`OpenClaw ${version} `) || installedVersion === `OpenClaw ${version}`) { await waitHealthy(container); validate(container); console.log('Already running the requested stable release.'); process.exit(0); }
const registry = await (await fetch('https://registry.npmjs.org/openclaw/latest', { signal: AbortSignal.timeout(15000) })).json();
if (registry.version !== version) throw new Error('Requested version is no longer npm latest; recheck the stable release');
const disk = statfsSync(root);
if (disk.bavail * disk.bsize < 12 * 1024 ** 3) throw new Error('At least 12 GiB free is required for owner backups and the candidate image');
mkdirSync(backup, { recursive: true, mode: 0o700 });
// Never expose config, environment values, transcripts, or plugin output in CI.
privateWrite(path.join(backup, 'container.json'), JSON.stringify(current));
const fleetBefore = JSON.parse(docker(['inspect', ...docker(['ps', '-aq', '--filter', 'name=openclaw-']).split('\n').filter(Boolean)]))
  .filter(c => c.Name !== '/' + container).map(c => ({ name: c.Name, id: c.Id, startedAt: c.State.StartedAt }));
let brokerActive = false;
try { brokerActive = run('systemctl', ['is-active', 'openclaw-remote-terminal.service']) === 'active'; } catch {}
try {
  step('Pulling and checking the official stable application image');
  if (!releases[version]) throw new Error('Verify and record the official release manifest before upgrading');
  // The official Docker Hub mirror has identical manifests. Pull by the
  // reviewed digest so registry timing and mutable tags cannot change it.
  const releaseTag = `openclaw/openclaw@${releases[version]}`;
  privateWrite(path.join(backup, 'pull.log'), docker(['pull', releaseTag], { timeout: 600000 }));
  const release = JSON.parse(docker(['image', 'inspect', releaseTag]))[0];
  if (release.Config.Labels?.['org.opencontainers.image.version'] !== version) throw new Error('Release image label does not match');
  const releaseDigest = release.RepoDigests.find(d => d === releaseTag);
  if (!releaseDigest) throw new Error('Release image is missing its immutable registry digest');
  const metadata = JSON.parse(docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', releaseDigest, '-e', 'console.log(JSON.stringify({version:require("/app/package.json").version,node:process.version}));']));
  if (metadata.version !== version || metadata.node !== docker(['exec', container, 'node', '--version'])) throw new Error('Application-only upgrade requires the same qualified Node runtime');
  console.log(JSON.stringify({ stableRelease: version, releaseImage: releaseDigest, qualifiedNode: metadata.node }));
  assertOwnerIdle(dir);
  if (brokerActive) run('systemctl', ['stop', 'openclaw-remote-terminal.service']);
  step('Stopping only openclaw1 for a consistent full backup');
  docker(['stop', '--time', '30', container]); stopped = true;
  oldImage = checkpointOwnerImage(dir, 'openclaw1');
  const rollbackTag = `openclaw-owner/openclaw1:before-${version}-${stamp.toLowerCase()}`;
  docker(['tag', oldImage, rollbackTag]);
  oldState = readFileSync(path.join(dir, '.owner-image.json'), 'utf8');
  oldCompose = readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  run('tar', ['--create', '--file', path.join(backup, 'tenant.tar'), '--directory', dir, '.'], { timeout: 300000 });
  run('tar', ['--list', '--file', path.join(backup, 'tenant.tar')], { maxBuffer: 32 * 1024 * 1024 });
  console.log(`Full state and system rollback checkpoint saved at ${backup}`);
  step('Building the new application on the owner’s existing system filesystem');
  const recipe = `FROM ${releaseDigest} AS release\nFROM ${rollbackTag}\nUSER root\nRUN rm -rf /app\nCOPY --from=release --chown=1000:1000 /app/ /app/\nLABEL org.opencontainers.image.version="${version}" org.opencontainers.image.revision="${release.Config.Labels['org.opencontainers.image.revision']}"\nUSER node\n`;
  privateWrite(path.join(backup, 'Dockerfile'), recipe);
  const candidateTag = `openclaw-owner/openclaw1:stable-${version}-${stamp.toLowerCase()}`;
  privateWrite(path.join(backup, 'build.log'), docker(['build', '--network', 'none', '--tag', candidateTag, '-'], { input: recipe, timeout: 600000 }));
  const candidate = JSON.parse(docker(['image', 'inspect', candidateTag]))[0].Id;
  const copied = path.join(backup, 'rehearsal'); mkdirSync(copied, { mode: 0o700 });
  run('tar', ['--extract', '--file', path.join(backup, 'tenant.tar'), '--directory', copied], { timeout: 300000 });
  const runtimeEnv = current.Config.Env;
  if (runtimeEnv.some(value => /[\r\n\0]/.test(value))) throw new Error('Unsupported multiline runtime environment');
  privateWrite(path.join(backup, 'runtime.env'), runtimeEnv.join('\n') + '\n');
  const mounts = [];
  for (const mount of current.Mounts) {
    if (mount.Type !== 'bind') throw new Error('Unsupported owner mount type');
    const relative = path.relative(dir, mount.Source);
    if (mount.RW && (relative.startsWith('..') || path.isAbsolute(relative))) throw new Error('Owner writable mount is outside the tenant');
    const source = mount.RW ? path.join(copied, relative) : mount.Source;
    mounts.push('--mount', `type=bind,src=${source},dst=${mount.Destination}${mount.RW ? '' : ',readonly'}`);
  }
  step('Repairing agent database schemas on the copied state, preserving owner choices');
  repairSchema(candidate, mounts, path.join(backup, 'runtime.env'), path.join(backup, 'rehearsal-schema-repair.log'));
  step('Rehearsing startup and migrations on copied state with networking disabled');
  rehearsal = `openclaw-upgrade-rehearsal-${process.pid}`;
  docker(['run', '-d', '--name', rehearsal, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    ...(current.HostConfig.CapAdd || []).flatMap(cap => ['--cap-add', cap]), '--memory', String(current.HostConfig.Memory || 4 * 1024 ** 3),
    '--env-file', path.join(backup, 'runtime.env'), '--env', 'OPENCLAW_SKIP_CHANNELS=1', ...mounts, candidate, 'node', 'openclaw.mjs', 'gateway']);
  await waitHealthy(rehearsal); validate(rehearsal);
  privateWrite(path.join(backup, 'rehearsal-plugins.json'), docker(['exec', rehearsal, 'openclaw', 'plugins', 'list', '--json']));
  docker(['rm', '-f', rehearsal]); rehearsal = undefined;
  step('Activating the verified candidate on openclaw1');
  // Update only this tenant's image reference. Rendering would introduce other
  // defaults and could checkpoint the old container over our selected image.
  const nextState = { ...JSON.parse(oldState), image: candidate, savedAt: new Date().toISOString(), openclawVersion: version, releaseImage: releaseDigest };
  privateWrite(path.join(dir, '.owner-image.json'), JSON.stringify(nextState) + '\n');
  run('chown', ['1000:1000', path.join(dir, '.owner-image.json')]);
  writeFileSync(path.join(dir, 'docker-compose.yml'), composeImage(oldCompose, candidate));
  activated = true;
  const liveMounts = current.Mounts.flatMap(m => ['--mount', `type=bind,src=${m.Source},dst=${m.Destination}${m.RW ? '' : ',readonly'}`]);
  repairSchema(candidate, liveMounts, path.join(backup, 'runtime.env'), path.join(backup, 'live-schema-repair.log'));
  privateWrite(path.join(backup, 'activation.log'), docker(['compose', 'up', '-d', '--no-deps', '--force-recreate', 'openclaw'], { cwd: dir }));
  await waitHealthy(container); validate(container);
  privateWrite(path.join(backup, 'installed-plugins.json'), docker(['exec', container, 'openclaw', 'plugins', 'list', '--json']));
  const fleetAfter = JSON.parse(docker(['inspect', ...fleetBefore.map(c => c.id)])).map(c => ({ name: c.Name, id: c.Id, startedAt: c.State.StartedAt }));
  if (JSON.stringify(fleetBefore) !== JSON.stringify(fleetAfter)) throw new Error('Another fleet container changed during the upgrade');
  console.log(`PASS: openclaw1 is healthy on ${version}; owner mounts, system filesystem and other Claws retained. Backup: ${backup}`);
} catch (error) {
  saveFailure(error);
  if (stage === 'Pulling and checking the official stable application image') {
    // This stage has only public image metadata, never owner configuration.
    console.error([error.code, error.message, error.stdout, error.stderr].filter(Boolean).join('\n').slice(-3000));
  }
  if (activated) {
    step('Restoring the pre-upgrade application and state');
    try { docker(['stop', '--time', '15', container]); } catch {}
    const failed = path.join(backup, 'failed-state'); mkdirSync(failed, { mode: 0o700 });
    for (const name of ['config', 'workspace', 'auth-profile-secrets', 'browser-cache']) {
      if (existsSync(path.join(dir, name))) renameSync(path.join(dir, name), path.join(failed, name));
    }
    run('tar', ['--extract', '--file', path.join(backup, 'tenant.tar'), '--directory', dir], { timeout: 300000 });
    writeFileSync(path.join(dir, 'docker-compose.yml'), composeImage(oldCompose, oldImage));
    privateWrite(path.join(backup, 'rollback.log'), docker(['compose', 'up', '-d', '--no-deps', '--force-recreate', 'openclaw'], { cwd: dir }));
    await waitHealthy(container);
    console.log('Rollback completed: the previous application and saved state are running. Failed-state files are retained privately.');
  } else if (stopped) { docker(['start', container]); await waitHealthy(container); console.log('The original canary is running; its saved state was not changed.'); }
  console.error(`Upgrade failed during ${stage}. Private diagnostics: ${backup}`);
  process.exitCode = 1;
} finally {
  if (rehearsal) { try { docker(['rm', '-f', rehearsal]); } catch {} }
  if (brokerActive) run('systemctl', ['start', 'openclaw-remote-terminal.service']);
}
