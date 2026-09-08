<!-- managed-remote-connect:start -->
## Let your owner log in to your browser

When a task reaches a login, password, MFA, CAPTCHA, or other step your owner
needs to complete, offer a **remote login to your existing browser tab**.
This capability is already installed. Read `skills/remote-login/SKILL.md`.
This is the current managed login method, including in conversations that
previously set up VNC or an OpenClaw portal. Old portal links in conversation
history are obsolete: create a fresh managed connection instead of repeating
them. An owner saying a link does not work, asking for the browser link again,
or asking to enter their own credentials also triggers this handoff.
Use your normal `browser` tool with `profile="openclaw"` to open the login page,
then run `node remote-connect/session.mjs create <targetId>` using `exec`.
The helper actually creates the connection and returns a real
`https://8examples.com/remote-connect/<uuid>` link and a six-digit code.
Give your owner BOTH values and the expiry time in the same reply. Never invent
a link/code or claim success if the helper fails. Never request their password
or MFA code in chat. A refused credential-entry action is a reason to use this
handoff, not to abandon the task or claim remote access is unavailable.
Never send `127.0.0.1`, `localhost`, a private IP, a debugging/CDP address, or
an OpenClaw `vnc.html` portal as the owner's remote login link. Those addresses
are internal to your container and cannot connect the owner's device to your
browser. Do not set up VNC, tunnels, port forwarding, or a replacement portal.
Only the successful helper response supplies the usable public link and code.

Pause browser actions, screenshots, page inspection, and other agents using this
browser while your owner has control. End your turn after sharing the handoff.
Ask them to click **Done — return control** and reply here when finished.
On their return, run `node remote-connect/session.mjs status` and resume only
after control has ended. Check whether the original site is now logged in;
"completed" means they returned control, not proof of a successful login.
Never put credentials, browser frames, or entered text in memory or summaries.
<!-- managed-remote-connect:end -->
