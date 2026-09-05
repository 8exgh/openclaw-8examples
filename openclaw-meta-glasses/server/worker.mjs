import { execFile } from 'node:child_process';

export function spokenSummary(text) {
  const clean = text.replace(/```[\s\S]*?```/g, ' Code is included in the app. ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length <= 400 ? clean : `${clean.slice(0, 397).trimEnd()}…`;
}

export function parseAgentOutput(stdout) {
  const data = JSON.parse(stdout);
  if (data.status !== 'ok') throw new Error('Agent did not report success');
  const payloads = data.result?.payloads ?? data.payloads;
  const text = Array.isArray(payloads) ? payloads.map((p) => typeof p.text === 'string' ? p.text : '').filter(Boolean).join('\n\n').trim() : '';
  if (!text) throw new Error('Agent returned no text');
  return text.slice(0, 8000);
}

export function dockerRunner({ timeout = 180_000, execute = execFile } = {}) {
  return (job) => new Promise((resolve, reject) => {
    if (!/^[a-z0-9-]{1,64}$/.test(job.claw_id) || !/^[a-z0-9-]{1,64}$/.test(job.username)) return reject(new Error('Invalid account id'));
    const message = `The owner is speaking through their glasses. Fulfill the following request using your configured capabilities. End with a short, factual spoken summary of what happened and anything still needed. Verify outcomes before claiming completion. The glasses relay will deliver your final reply automatically; do not also publish a glasses summary for this request.\n\nOwner request:\n${job.text}`;
    execute('docker', ['exec', `openclaw-${job.claw_id}`, 'openclaw', 'agent', '--agent', 'main',
      '--session-key', `glasses:${job.claw_id}:${job.username}`, '--message', message, '--json',
      '--timeout', String(Math.floor(timeout / 1000) - 10)], { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      // A timeout can happen after a real action. Never retry a task from an ambiguous result.
      if (error) return reject(new Error('Agent run did not finish cleanly'));
      try { resolve(parseAgentOutput(stdout)); } catch (error) { reject(error); }
    });
  });
}

export async function runOne({ store, authenticate, vault, runAgent }) {
  const job = store.claim();
  if (!job) return false;
  try {
    const user = await authenticate(vault.open(job.credential));
    if (user.username !== job.username || !user.claws.some((c) => c.clawId === job.claw_id)) throw new Error('Access no longer available');
  } catch {
    store.finish(job, 'failed', 'This request was not started because account access could not be verified. Sign in and try again.', 'Request not started. Account access could not be verified.');
    return true;
  }
  try {
    const text = await runAgent(job);
    store.finish(job, 'replied', text, spokenSummary(text));
  } catch {
    store.finish(job, 'uncertain', 'OpenClaw did not return a verified result. It may already have acted. Check the outcome before repeating the request.',
      'The result needs checking. Your request was not repeated automatically.');
  }
  return true;
}

export async function deliverPushes({ store, authenticate, vault, push }) {
  for (const item of store.pendingPushes()) {
    try {
      const user = await authenticate(vault.open(item.credential));
      if (user.username !== item.device_username || !user.claws.some((c) => c.clawId === item.claw_id) ||
          (item.event_username !== null && item.event_username !== user.username) || Date.now() - item.created_at > 86400_000) {
        store.pushDone(item); continue;
      }
      if (!store.deviceIsCurrent(item)) continue;
      await push(item);
      store.pushDone(item);
    } catch (error) {
      if (error.statusCode === 401 || error.invalidDevice) {
        if (store.deviceIsCurrent(item)) store.removeDevice(item.device_id, item.device_username);
      }
      else store.pushRetry(item);
    }
  }
}
