function getApiUrl(): string {
  return (process.env.BACKEND_API_URL || 'https://8examples.com').replace(/\/$/, '');
}

function getAccessToken(): string {
  return process.env.BACKEND_ACCESS_TOKEN || '';
}

export interface ClawReplyTask {
  userId: string;
  clawId: string;
  messageId: string;
  text: string;
  attemptNumber: number;
}

const headers = () => ({ Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' });

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${getApiUrl()}${path}`, { headers: headers() });
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${getApiUrl()}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST ${path} failed: ${response.status} ${text.slice(0, 200)}`);
  }
}

// Query
export async function getMessagesAwaitingClawReply(): Promise<ClawReplyTask[]> {
  return (await get<{ tasks: ClawReplyTask[] }>('/api/mobile/queries/messages-awaiting-claw-reply')).tasks;
}

// Commands
export async function recordClawReply(task: ClawReplyTask, text: string): Promise<void> {
  const { userId, clawId, messageId } = task;
  await post('/api/mobile/commands/record-claw-reply', { userId, clawId, messageId, text });
}

export async function recordClawReplyFailed(task: ClawReplyTask, errorMessage: string): Promise<void> {
  const { userId, clawId, messageId, attemptNumber } = task;
  await post('/api/mobile/commands/record-claw-reply-failed', { userId, clawId, messageId, errorMessage, attemptNumber });
}
