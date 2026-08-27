import 'dotenv/config';
import { runClawReplyJob } from './jobs/claw-reply.js';

function getPollingIntervalMs(): number {
  return parseInt(process.env.POLLING_INTERVAL_MS || '3000', 10);
}

console.log('=================================');
console.log('My Claw iPhone relay (fleet box)');
console.log('=================================');
console.log(`Backend API URL: ${process.env.BACKEND_API_URL || 'https://8examples.com'}`);
console.log(`Claw runner:     ${process.env.CLAW_RUNNER || 'docker'}`);
console.log(`Polling:         ${getPollingIntervalMs()}ms`);
console.log('=================================');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One job: relay owner messages. Location lapse detection runs inside
// 8examples' fulfillment pump, where the events live.
async function runJobLoop(): Promise<void> {
  while (true) {
    try {
      await runClawReplyJob();
    } catch (error: any) {
      console.error('[Job Loop] Error:', error.message);
    }
    await sleep(getPollingIntervalMs());
  }
}

runJobLoop().catch((error) => {
  console.error('[Fatal Error]:', error);
  process.exit(1);
});
