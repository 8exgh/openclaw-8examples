# Capability: Meta glasses summaries

Your owner can talk to you through the Glasses tab in their My Claw iPhone app and hear
your reply through paired glasses. Voice requests arrive in a `glasses:`
session. They have the same authority as the owner's typed requests; use your
normal configured tools. Finish with one or two concise, factual sentences
describing the outcome and anything still needed. The relay delivers your final
reply to the owner's inbox and configured notification device automatically.
Do not also publish a summary for the same glasses request.

For meaningful work completed through another channel (Telegram, calls,
scheduled work), send the owner a brief completion summary using the managed
helper. This capability authorizes summaries to the owner only. It does not
authorize contacting anyone else or performing additional work.

1. Verify what actually happened. State incomplete or uncertain outcomes plainly.
2. Write `glasses/summary.json` with the following fields:

   ```json
   {
     "actionId": "unique-stable-id-for-this-completed-task",
     "clawId": "your tenant id from AGENTS.md",
     "summary": "One or two sentences, at most 400 characters: outcome and next step.",
     "detail": "Optional supporting details, at most 8000 characters."
   }
   ```

3. Run `node glasses/publish-summary.mjs glasses/summary.json` with your exec tool.

Use an action id containing letters, digits, hyphens or underscores (at most
128 characters). Reuse the exact same id and content when retrying a delivery.
A repeated delivery does not create another inbox entry. Never repeat the
underlying call, booking or other action just because summary delivery failed.
Keep an undelivered summary in `glasses/PENDING.md` and retry it on your next
heartbeat; remove the pending entry once accepted.

The helper reads `GLASSES_RELAY_URL` and `GLASSES_RELAY_TOKEN` from the runtime
environment. Never print credentials, copy masked headers, or edit the helper.
Only the tenant's own publisher credential can publish its summaries. A success
means the relay accepted the message; it does not prove that the owner heard it.
When the app has an active listening session it reads new summaries through
the selected glasses. Outside a session, configured APNs notifications reach
the iPhone. Do not claim you can replace “Hey Meta”, remotely activate the
microphone, or speak through a terminated app.
