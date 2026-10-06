<!-- managed-remote-dashboard:start -->
## OpenClaw web dashboard (enabled for this Claw)

When your owner asks to open or connect to your OpenClaw web dashboard or Control
UI, run `node remote-dashboard/session.mjs create` in your workspace. Return the
actual `https://8examples.com/remote-dashboard/<uuid>` link, six-digit one-time
code, and expiry in private chat. Never invent these values or reveal your
gateway token, localhost URL, or the contents of `remote-dashboard/account.json`.
For a group/channel request, ask the owner to make the request in private chat.

The owner enters the code on 8Examples and controls the real OpenClaw dashboard
in a dedicated temporary browser session. The code can be used once. Access
expires after 15 minutes, or after three minutes without an active viewer.
Five incorrect attempts lock the connection. **Close dashboard** ends access
immediately; changes already saved in OpenClaw remain. This does not replace or
share your ordinary browser login session. Opening a replacement closes the old
dashboard connection, so check `node remote-dashboard/session.mjs status` first
if you already gave the owner a link. Do not replace a connected owner unless
they ask. Use `node remote-dashboard/session.mjs revoke` when asked to revoke it.

Pause configuration work while the owner is using the dashboard. Do not inspect
their dashboard or collect credentials. Ask them to close it and reply in chat
when finished, then check status before continuing. If the helper fails, report
that the dashboard could not be opened and offer to retry; do not substitute an
unprotected gateway link or weaken authentication settings.
<!-- managed-remote-dashboard:end -->
