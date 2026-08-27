import { getMessagesAwaitingClawReply, recordClawReply, recordClawReplyFailed } from '../utils/api-client.js';
import { runClawAgent } from '../utils/claw-runner.js';

/**
 * Job 1: Claw replies
 *
 * 1. Polls for owner messages no claw has answered (across every user)
 * 2. Runs the claw's agent with the message
 * 3. Records ClawReplied — or ClawReplyFailed, up to 5 attempts (the backend
 *    stops handing the message out once it flips to `failed`)
 */
export async function runClawReplyJob(): Promise<void> {
  const tasks = await getMessagesAwaitingClawReply();
  if (tasks.length === 0) return;
  console.log(`[claw-reply] ${tasks.length} message(s) awaiting a reply`);

  // One claw at a time per container keeps `openclaw agent` sessions sane;
  // different claws can run concurrently.
  const byClaw = new Map<string, typeof tasks>();
  for (const t of tasks) byClaw.set(t.clawId, [...(byClaw.get(t.clawId) || []), t]);

  await Promise.all(
    [...byClaw.values()].map(async (clawTasks) => {
      for (const task of clawTasks) {
        try {
          const reply = await runClawAgent(task.clawId, task.userId, task.text);
          await recordClawReply(task, reply);
          console.log(`[claw-reply] ${task.clawId} -> ${task.userId}: replied ${reply.length} chars`);
        } catch (error: any) {
          console.error(`[claw-reply] ${task.clawId} attempt ${task.attemptNumber} failed: ${error.message}`);
          try {
            await recordClawReplyFailed(task, String(error.message || error).slice(0, 2000));
          } catch (recordError: any) {
            console.error(`[claw-reply] could not record failure: ${recordError.message}`);
          }
        }
      }
    }),
  );
}
