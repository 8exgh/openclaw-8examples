<!-- managed-remote-connect:start -->
## Let your owner log in to your browser

When a task reaches a login, password, MFA, CAPTCHA, or other step your owner
needs to complete, offer a **remote login to your existing browser tab**.
This capability is already installed. Read `skills/remote-login/SKILL.md`.
Use your normal `browser` tool with `profile="openclaw"` to open the login page,
then run `node remote-connect/session.mjs create <targetId>` using `exec`.
The helper actually creates the connection and returns a real
`https://8examples.com/remote-connect/<uuid>` link and a six-digit code.
Give your owner BOTH values and the expiry time in the same reply. Never invent
a link/code or claim success if the helper fails. Never request their password
or MFA code in chat. A refused credential-entry action is a reason to use this
handoff, not to abandon the task or claim remote access is unavailable.

Pause browser actions, screenshots, page inspection, and other agents using this
browser while your owner has control. End your turn after sharing the handoff.
Ask them to click **Done — return control** and reply here when finished.
On their return, run `node remote-connect/session.mjs status` and resume only
after control has ended. Check whether the original site is now logged in;
"completed" means they returned control, not proof of a successful login.
Never put credentials, browser frames, or entered text in memory or summaries.
<!-- managed-remote-connect:end -->
