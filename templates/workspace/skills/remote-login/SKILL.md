---
name: remote-login
description: Give the owner a live remote browser link and six-digit code when a task requires login, password entry, MFA, CAPTCHA, or hands-on browser input.
---

# Remote browser login

This uses the managed `openclaw` browser profile and preserves its cookies.
It shares browser page contents and input; it does not share a separate browser
or the Linux desktop. Native OS dialogs, passkeys on the owner's device, file
upload pickers, and browser chrome are not supported by this connection.

1. Open the intended login page with `browser`, `profile="openclaw"`. Keep the
   targetId returned by that tool. If necessary, list tabs using the browser
   tool or `openclaw browser --browser-profile openclaw tabs --json`.
2. Run `node remote-connect/session.mjs create <targetId>` with `exec` from the
   workspace. With exactly one tab, `create` without targetId also works.
   The helper uses its own installed credentials. Do not read or print
   `remote-connect/account.json`, set up VNC, expose a debugging port, or ask
   the owner to install remote desktop software.
3. Only after a successful response, send the returned `url`, six-digit `code`
   (keep leading zeroes), and `expiresAt`. Explain: “Open this link, enter the
   code, and sign in directly. Click Done — return control, then reply here.”
   Both the link and code are needed; send them in the owner's private chat.
   If you are in a shared room, ask the owner to continue in a private chat
   before creating a connection.
4. End your turn and leave the browser alone while the owner signs in. Do not
   take screenshots, read fields, run page scripts, or have subagents inspect
   this browser during the handoff. The page supports clicking, scrolling,
   typing/pasting, and selecting another browser tab for OAuth login popups.
5. On the owner's next reply, `node remote-connect/session.mjs status` returns
   waiting, connected, completed, expired, replaced, locked, disconnected, or
   revoked. While waiting/connected, ask them to return control on the page;
   if they explicitly ask you to take over, run `node remote-connect/session.mjs revoke`.
   Once control has ended, use the original browser tab to verify login and
   continue the authorized task. A session completion is not login success.

Connections expire after 15 minutes, or after 3 minutes with no viewer activity
once connected. Five incorrect codes lock the connection. A code unlocks once;
refresh works in that same browser, but opening the link elsewhere requires a
new connection. Creating a replacement revokes the previous connection.

If creation fails, check that the `openclaw` profile is running and the targetId
still exists, then retry once. Report a concrete connection failure if it still
fails; do not fabricate a link or fall back to asking for passwords in chat.
The status is also written to `remote-connect/status.json` without credentials.
