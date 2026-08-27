import { execFile } from 'node:child_process';

/**
 * Talks to a claw the same way rocketchat/bridge.mjs does: `docker exec
 * openclaw-<clawId> openclaw agent …` with a per-(claw, owner) session key so
 * the iPhone conversation is its own thread, separate from Rocket.Chat's.
 */
export async function runClawAgent(clawId: string, userId: string, message: string): Promise<string> {
  const runner = process.env.CLAW_RUNNER || 'docker';
  if (runner === 'echo') return `(${clawId} echo) ${message}`;
  if (runner !== 'docker') throw new Error(`Unknown CLAW_RUNNER: ${runner}`);

  const container = `${process.env.CONTAINER_PREFIX || 'openclaw-'}${clawId}`;
  const sessionKey = `iphone:${clawId}:${userId}`;
  const timeout = Number(process.env.AGENT_TIMEOUT_MS || 150000);

  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['exec', container, 'openclaw', 'agent', '--agent', 'main', '--session-key', sessionKey, '--message', message],
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        if (out) return resolve(out);
        reject(new Error((stderr || err?.message || 'agent produced no output').slice(0, 500)));
      },
    );
  });
}
