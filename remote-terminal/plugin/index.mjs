import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const instructions = `The public REMOTE TERMINAL is installed and enabled for this Claw. The user owns their Claw; 8Examples provisions and hosts it. Help the owner install/configure/remove plugins, change models, skills, instructions and files without requiring the provisioner's approval. Owner configuration survives provisioning. The terminal page offers Open admin shell when root administration is enabled for this container. In that shell, openclaw runs as the normal Claw user; other commands run as root. Owners can also open a terminal from https://8examples.com/account if chat is unavailable. For an explicit owner request for a remote terminal, shell, console, or CLI login handoff, run node remote-terminal/session.mjs create in your workspace. Return its real https://8examples.com/remote-terminal/<uuid> link, six-digit code and expiry in private chat; then stop and wait. Never invent a link/code or substitute a browser URL, localhost, SSH, or VNC. This opens a dedicated shell in your existing container workspace, not an already running command. The owner clicks End terminal and replies in chat. Run node remote-terminal/session.mjs status before resuming their task. Read skills/remote-terminal/SKILL.md for private-chat and control-return rules. Keep passwords and account MFA codes out of chat. Do not inspect or interfere with the owner's connected terminal.`;
export function requestsTerminal(prompt) {
  if (typeof prompt !== 'string' || /\b(?:design|implement|explain|document|write (?:code|tests|docs))\b|\b(?:don't|do not|never|cancel|avoid)\b/i.test(prompt)) return false;
  return /\b(?:open|create|give|send|connect|want|need|start|launch|use|access)\b.{0,100}\b(?:remote (?:terminal|shell|console)|terminal (?:link|connection|session)|interactive (?:terminal|shell|console))\b|^\s*(?:remote terminal|terminal please)[.!?\s]*$/is.test(prompt);
}
export async function createHandoff(workspace) {
  try {
    const existing = JSON.parse(readFileSync(path.join(workspace, 'remote-terminal/status.json'), 'utf8'));
    if (existing.status === 'connected' && Date.parse(existing.expiresAt) > Date.now()) return { handled: true, reply: { text: 'Your terminal is already connected. Use that page, then choose End terminal and reply here. Ask me to revoke it if you need a replacement.' } };
  } catch { /* no active handoff */ }
  try {
    const { stdout } = await exec(process.execPath, [path.join(workspace, 'remote-terminal/session.mjs'), 'create'], { cwd: workspace, timeout: 30000, maxBuffer: 16384 });
    const session = JSON.parse(stdout), url = new URL(session.url);
    if (url.origin !== 'https://8examples.com' || !/^\/remote-terminal\/[0-9a-f-]{36}$/.test(url.pathname) || !/^\d{6}$/.test(session.code) || !Number.isFinite(Date.parse(session.expiresAt))) throw new Error('Invalid handoff');
    return { handled: true, reply: { text: `Open your terminal: ${session.url}\n\nCode: **${session.code}**\nExpires: ${session.expiresAt}\n\nThis is a shell in my container and workspace. When finished, choose **End terminal**, then reply here. I will leave your terminal and this task alone while you are connected. Keep account passwords and MFA codes out of chat.` } };
  } catch { return { handled: true, reply: { text: 'The remote terminal could not be opened. Ask me to retry the terminal connection.' } }; }
}
export default {
  id: 'managed-remote-terminal', name: '8Examples remote terminal',
  register(api) {
    api.logger?.info('managed-remote-terminal active: private shell handoff');
    const workspaceFor = ctx => {
      const agentId = ctx.agentId || ctx.sessionKey?.match(/^agent:([^:]+):/)?.[1] || 'main';
      const workspace = ctx.workspaceDir || api.config?.agents?.list?.find(agent => agent.id === agentId)?.workspace ||
        (agentId === 'main' && (api.config?.agents?.defaults?.workspace || '/home/node/.openclaw/workspace'));
      return typeof workspace === 'string' && existsSync(path.join(workspace, 'remote-terminal/account.json')) ? workspace : undefined;
    };
    api.on('before_prompt_build', (_event, ctx) => { if (workspaceFor(ctx)) return { appendSystemContext: instructions }; });
    api.on('before_agent_reply', async (event, ctx) => {
      const workspace = workspaceFor(ctx);
      if (!workspace || !requestsTerminal(event.cleanedBody)) return;
      if (/:(?:group|channel):/.test(ctx.sessionKey || '')) return { handled: true, reply: { text: 'Ask me in private chat so I can give you the terminal link and one-time code there.' } };
      if (!/:(?:direct|iphone):/.test(ctx.sessionKey || '')) return;
      return createHandoff(workspace);
    }, { eligibleTriggers: ['user'], timeoutMs: 35000 });
  },
};
