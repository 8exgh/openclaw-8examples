import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export const instructions = `The OPENCLAW WEB DASHBOARD is installed for this Claw. When the owner asks to connect to your OpenClaw dashboard or Control UI, run node remote-dashboard/session.mjs create from your workspace. Return its actual https://8examples.com/remote-dashboard/<uuid> link, six-digit one-time code, and expiry in private chat. Never invent these values or share a gateway token or localhost address. The owner controls the real dashboard in a dedicated temporary browser session, separate from ordinary browser logins. Access lasts 15 minutes; Close dashboard revokes it. Saved changes remain. Pause configuration work while the owner is connected. Use node remote-dashboard/session.mjs status before resuming, or revoke if asked. Read skills/remote-dashboard/SKILL.md for the private-chat and lifecycle rules.`;

export function requestsDashboard(prompt) {
  if (typeof prompt !== 'string' || /\b(?:design|implement|build|explain|document|write (?:code|tests|docs)|don't|do not|never|cancel|avoid)\b/i.test(prompt)) return false;
  const dashboard = /\b(?:(?:openclaw|my claw|your|claw(?:'s)?) (?:web )?(?:dashboard|control (?:ui|panel))|web dashboard|control ui)\b/i;
  return dashboard.test(prompt) && /\b(?:open|create|give|send|connect|want|need|start|launch|use|access|show)\b/i.test(prompt);
}

export async function createHandoff(workspace) {
  const helper = path.join(workspace, 'remote-dashboard/session.mjs');
  try {
    const { stdout } = await exec(process.execPath, [helper, 'status'], { cwd: workspace, timeout: 5000, maxBuffer: 16384 });
    const existing = JSON.parse(stdout);
    if (existing.status === 'connected' && Date.parse(existing.expiresAt) > Date.now()) return { handled: true, reply: { text: 'Your OpenClaw dashboard is already connected. Use that page, then choose Close dashboard. Ask me to revoke it if you need a replacement.' } };
  } catch { /* No previous connection, or it expired. Creation rechecks access. */ }
  try {
    const { stdout } = await exec(process.execPath, [helper, 'create'], { cwd: workspace, timeout: 30000, maxBuffer: 16384 });
    const session = JSON.parse(stdout), url = new URL(session.url);
    if (url.origin !== 'https://8examples.com' || !/^\/remote-dashboard\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(url.pathname) || url.search || url.hash || !/^\d{6}$/.test(session.code) || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new Error('Invalid handoff');
    return { handled: true, reply: { text: `Open your OpenClaw dashboard: ${session.url}\n\nOne-time code: **${session.code}**\nExpires: ${session.expiresAt}\n\nEnter the code on that page. When finished, choose **Close dashboard**, then reply here. Changes you save in the dashboard remain.` } };
  } catch { return { handled: true, reply: { text: 'The OpenClaw dashboard could not be opened. Ask me to retry the dashboard connection.' } }; }
}

export default {
  id: 'managed-remote-dashboard', name: '8Examples OpenClaw dashboard',
  register(api) {
    const workspaceFor = ctx => {
      const agentId = ctx.agentId || ctx.sessionKey?.match(/^agent:([^:]+):/)?.[1] || 'main';
      const workspace = ctx.workspaceDir || api.config?.agents?.list?.find(a => a.id === agentId)?.workspace ||
        (agentId === 'main' && (api.config?.agents?.defaults?.workspace || '/home/node/.openclaw/workspace'));
      return typeof workspace === 'string' && existsSync(path.join(workspace, 'remote-dashboard/account.json')) ? workspace : undefined;
    };
    api.on('before_prompt_build', (_event, ctx) => { if (workspaceFor(ctx)) return { appendSystemContext: instructions }; });
    api.on('before_agent_reply', async (event, ctx) => {
      const workspace = workspaceFor(ctx);
      if (!workspace || !requestsDashboard(event.cleanedBody)) return;
      if (/:(?:group|channel):/.test(ctx.sessionKey || '')) return { handled: true, reply: { text: 'Ask me in private chat so I can give you the dashboard link and one-time code there.' } };
      if (!/:(?:direct|iphone):/.test(ctx.sessionKey || '')) return;
      return createHandoff(workspace);
    }, { eligibleTriggers: ['user'], timeoutMs: 40000 });
  },
};
