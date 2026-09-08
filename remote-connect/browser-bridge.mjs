// Runs INSIDE the selected tenant via docker exec. The trusted transport embeds
// the client source; no browser URLs, page contents, or input are logged.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { createBrowserClient } from './browser-client.mjs';

const config = JSON.parse(readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const profile = config.browser?.profiles?.openclaw;
const cdp = new URL(profile?.cdpUrl || `http://127.0.0.1:${profile?.cdpPort || 18800}`);
if (!['localhost', '127.0.0.1', '[::1]'].includes(cdp.hostname) || cdp.protocol !== 'http:') throw new Error('A local managed browser is required');
const client = createBrowserClient(cdp);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', line => {
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      emit({ id: request.id, result: await client.handle(request.action, request.data || {}) });
    } catch (error) {
      emit({ id: request?.id, error: 'Browser connection interrupted', code: error.code || 'browser_interrupted', retryable: true });
    }
  });
}).on('close', () => { client.close(); process.exit(0); });
setTimeout(() => process.exit(0), 16 * 60 * 1000).unref();
