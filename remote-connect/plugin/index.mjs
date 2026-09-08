import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);

// Operator-owned runtime context, deliberately independent of writable memory
// and old VNC instructions in the conversation. Never reads account credentials.
export const instructions = `Managed 8Examples runtime capability: public remote browser login is INSTALLED and AUTHORIZED for this Claw. You do not need a public container IP, portal publishing, a tunnel, or another infrastructure approval.
When your owner needs to enter credentials themselves, or asks for a working browser link, use the existing managed openclaw browser tab. Read skills/remote-login/SKILL.md, then use exec to run node remote-connect/session.mjs create <targetId> from your workspace. This contacts the already deployed service and returns the real https://8examples.com/remote-connect/<uuid> URL, six-digit code, and expiry. Return all three to the owner in private chat and end your turn. Never invent these values.
Older VNC/noVNC/OpenClaw portal setups and claims that public access is unavailable are obsolete. Do not reuse them. Never offer localhost, 127.0.0.1, a private IP, a CDP address, or a vnc.html portal as the owner's login link. If the helper fails, check the managed profile and tab, retry once, then report its actual error.
Do not ask for passwords or MFA codes in chat. While the owner has control, pause browser actions, screenshots, page inspection, and other agents using that browser. Ask them to click Done — return control and reply in chat. Run node remote-connect/session.mjs status before resuming and verify the site's login afterward. Read the skill's private-chat and control-return rules.`;

export function requestsHandoff(prompt) {
  if (typeof prompt !== 'string') return false;
  if (/\b(?:explain|document|design|implement|write (?:code|tests|docs))\b|\b(?:don't|do not|never|cancel|avoid)\s+(?:\w+\s+){0,3}(?:creat|connect|remote|shar|browser|handoff)/i.test(prompt)) return false;
  return /(?:sign|log)\s*in\s+(?:by\s+)?myself|enter\b.{0,100}\b(?:password|credentials)\b.{0,60}\b(?:myself|directly|your browser)|(?:give|send|get|set up|open|want|need|connect).{0,80}(?:remote browser|browser (?:login|link|control)|remote (?:login|connection))|(?:browser|127\.0\.0\.1|localhost).{0,60}link.{0,60}(?:won't|doesn't|not work|broken)|(?:linkedin|login tab|browser tab).{0,100}(?:fresh|new|working)\s+link/is.test(prompt);
}

export function misleadingHandoff(text) {
  if (typeof text !== 'string' || /https:\/\/8examples\.com\/remote-connect\/[0-9a-f-]{36}/i.test(text)) return false;
  // Ignore quoted examples and code in technical explanations. Match the
  // assistant's own browser/login directions, not ordinary localhost advice.
  const body = text.replace(/```[\s\S]*?```/g, '').replace(/^>.*$/gm, '').replace(/[*_`]/g, '');
  if (/https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])[^\s]*\/(?:vnc\.html|remote-connect)/i.test(body)) return true;
  const login = /my browser|your browser|browser I|browser.{0,30}(?:use|run|lives)|sign in yourself|log in yourself|LinkedIn.{0,40}login/is.test(body);
  const wrongRoute = /(?:need|look|check|open|use|through|via|proper way|turns? on).{0,100}(?:control ui|live view|tailscale|portal)|(?:only|no).{0,60}(?:public (?:address|ip)|links?.{0,35}(?:server|container|host))|private server/is.test(body);
  return login && wrongRoute;
}

export async function createHandoff(workspaceDir, prompt, config) {
  const profile = config.browser?.profiles?.openclaw;
  const cdp = new URL(profile?.cdpUrl || `http://127.0.0.1:${profile?.cdpPort || 18800}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(cdp.hostname) || cdp.protocol !== 'http:') return;
  let tabs;
  try {
    const response = await fetch(new URL('/json/list', cdp), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    tabs = (await response.json()).filter(tab => tab.type === 'page' && /^[A-Za-z0-9-]{1,128}$/.test(tab.id));
  } catch { return; } // The normal agent can first start the browser/open the site.
  if (!tabs.length) return;
  // Chromium lists the foreground tab first. An explicitly named existing tab
  // wins; the viewer also lets the owner select another tab for login popups.
  const namedSite = /\blinkedin\b/i.test(prompt) ? 'linkedin.com' : undefined;
  const tab = tabs.find(tab => prompt.includes(tab.id)) || (namedSite && tabs.find(tab => {
    try { const host = new URL(tab.url).hostname; return host === namedSite || host.endsWith('.'+namedSite); } catch { return false; }
  })) || tabs[0];
  try {
    const { stdout } = await exec(process.execPath, [path.join(workspaceDir, 'remote-connect/session.mjs'), 'create', tab.id], { cwd: workspaceDir, timeout: 30000, maxBuffer: 65536 });
    const session = JSON.parse(stdout);
    const url = new URL(session.url);
    if (url.origin !== 'https://8examples.com' || !/^\/remote-connect\/[0-9a-f-]{36}$/.test(url.pathname) || !/^\d{6}$/.test(session.code)) throw new Error('Invalid handoff response');
    return { handled: true, reply: { text: `Open your browser: ${session.url}\n\nCode: **${session.code}**\nExpires: ${session.expiresAt}\n\nSign in directly on that page. When finished, click **Done — return control**, then reply here. I will leave the browser alone while you are in control.` } };
  } catch {
    return { handled: true, reply: { text: 'The managed remote login service could not create this connection. Ask me to retry the remote login; your browser remains open.' } };
  }
}

export default {
  id: 'managed-remote-login',
  name: '8Examples browser login handoff',
  register(api) {
    api.logger?.info(`managed-remote-login active ${createHash('sha256').update(readFileSync(new URL('./index.mjs', import.meta.url))).digest('hex')}: public login handoff and reply delivery correction`);
    const workspaceFor = ctx => {
      const agentId = ctx.agentId || ctx.sessionKey?.match(/^agent:([^:]+):/)?.[1] || 'main';
      const agent = api.config?.agents?.list?.find(agent => agent.id === agentId);
      const workspace = ctx.workspaceDir || agent?.workspace || (agentId === 'main' && (api.config?.agents?.defaults?.workspace || '/home/node/.openclaw/workspace'));
      return typeof workspace === 'string' && existsSync(path.join(workspace, 'remote-connect/session.mjs')) ? workspace : undefined;
    };
    api.on('before_prompt_build', (_event, ctx) => {
      if (workspaceFor(ctx)) return { appendSystemContext: instructions };
    });
    api.on('before_agent_reply', async (event, ctx) => {
      const workspace = workspaceFor(ctx);
      if (!workspace || !requestsHandoff(event.cleanedBody)) return;
      if (/:(?:group|channel):/.test(ctx.sessionKey || '')) return { handled: true, reply: { text: 'Continue with me in private chat so I can give you the browser connection link and code there.' } };
      // Unknown/custom channel routes use the normal agent and its private-chat
      // rules. Do not assume a Rocket.Chat room or unscoped CLI turn is private.
      if (!/:(?:direct|iphone):/.test(ctx.sessionKey || '')) return;
      return createHandoff(workspace, event.cleanedBody, api.config);
    }, { eligibleTriggers: ['user'], timeoutMs: 35000 });
    api.on('reply_payload_sending', async (event, ctx) => {
      if (!/:(?:direct|iphone):/.test(ctx.sessionKey || '') || !misleadingHandoff(event.payload?.text)) return;
      const workspace = workspaceFor(ctx);
      if (!workspace) return;
      // A confused follow-up must not disconnect somebody currently signing in.
      try {
        const status = JSON.parse(readFileSync(path.join(workspace, 'remote-connect/status.json'), 'utf8'));
        if (status.status === 'connected' && Date.parse(status.expiresAt) > Date.now()) return { payload: { ...event.payload, text: 'Your remote browser connection is active. Continue signing in on that page, then click Done — return control and reply here.' } };
      } catch { /* No active handoff yet. */ }
      const handoff = await createHandoff(workspace, event.payload.text, api.config);
      return { payload: { ...event.payload, text: handoff?.reply.text || 'The public browser login service is available, but I could not attach to the browser tab. Ask me to open the login page and create a fresh browser login connection.' } };
    }, { timeoutMs: 35000 });
  },
};
