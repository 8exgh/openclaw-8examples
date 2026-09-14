// Explicit owner-requested release upgrade. Never runs the fleet provisioner.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { assertOwnerIdle } from './index.mjs';

const root = process.env.MOC_ROOT;
const version = process.env.OPENCLAW_STABLE_VERSION;
if (!root || !/^\d{4}\.\d+\.\d+(?:-\d+)?$/.test(version || '')) throw new Error('Set the live checkout and an exact stable release.');
const dir = path.join(root, 'tenants/openclaw1');
const container = 'openclaw-openclaw1';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
assertOwnerIdle(dir);
const tenant = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8')).find(t => t.id === 'openclaw1');
if (!tenant || tenant.offboardedAt || tenant.modelAccess === 'suppressed' || tenant.tier === 'desktop') throw new Error('Canary is not eligible.');
const current = JSON.parse(docker(['inspect', container]))[0];
console.log(JSON.stringify({ tenant: tenant.id, requestedVersion: version, installedVersion: docker(['exec', container, 'openclaw', '--version']), node: docker(['exec', container, 'node', '--version']), image: current.Image, running: current.State.Running, health: current.State.Health?.Status, ownerAdministration: existsSync(path.join(dir, '.owner-admin')), mounts: current.Mounts.map(m => ({ source: m.Source, destination: m.Destination, writable: m.RW })) }));
console.log('System filesystem changes (paths only):\n' + docker(['diff', container]));
console.log(execFileSync('du', ['-sh', ...['config', 'workspace', 'auth-profile-secrets', 'browser-cache'].map(p => path.join(dir, p))], { encoding: 'utf8' }));
console.log(docker(['exec', container, 'node', '-e', `const fs=require('fs'),p='/home/node/.openclaw/openclaw.json',c=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify({plugins:Object.keys(c.plugins?.entries||{}),paths:c.plugins?.load?.paths,browserExecutable:c.browser?.executablePath,channelNames:Object.keys(c.channels||{})}));`]));
if (process.env.OPENCLAW_UPGRADE_APPLY === '1') throw new Error('Inspection complete; upgrade activation is not implemented in this revision.');
