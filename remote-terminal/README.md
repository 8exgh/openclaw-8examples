# Remote terminal canary

The owner asks **“Open a remote terminal”** in private chat. The installed helper
creates `https://8examples.com/remote-terminal/<uuid>`, a six-digit one-time code,
and an expiry. The viewer opens a real interactive Bash PTY as **node (uid 1000)**
inside the owner's existing container at `/home/node/.openclaw/workspace`.
It starts a dedicated shell; it does not attach to an existing agent exec process.

The same files and saved CLI authentication are available to the Claw afterward.
**End terminal** closes the PTY shell and discards retained output. Files remain.
Programs the owner deliberately detaches can outlive that shell. The owner replies
in chat and the agent checks `node remote-terminal/session.mjs status` before
continuing. Ending a terminal does not establish that a command/login succeeded.

## Implementation

- `broker.mjs`: authenticated, private HTTP service with in-memory sessions.
- `transport.mjs` and `pty-bridge.py`: Docker exec stdio into a fixed container;
  Python's standard-library PTY, terminal resize, UTF-8 bytes and control keys.
  No published SSH, WebSocket, Docker, or shell port. Host/container names,
  startup command and working directory are fixed. The owner can choose the
  Claw user or the enabled administrator shell for that same container.
- Website `/remote-terminal/[id]`: xterm.js with fit-to-window, physical/mobile
  keyboard, paste, composition, and touch controls for Tab/Esc/arrows/Ctrl+C.
- Website `/api/remote-terminal/[...path]`: HTTPS same-origin proxy, distinct
  terminal cookies, restricted routes, body limits and Origin checks.
- `workspace.mjs`, `instructions.md`, `session.mjs`, `plugin/`: install only for
  an explicitly enabled tenant. The native plugin handles recognized private
  requests directly and supplies current context in older conversations. Group
  requests move to private chat; unknown channel routes use the agent's normal
  private-chat rules. Subsequent tenant renders preserve an existing terminal
  credential and instructions; other tenants do not gain the capability.

The dedicated broker listens on the fleet's private Tailscale address, port 18882.
It shares the existing **server-only** `REMOTE_CONNECT_SERVICE_TOKEN` with the
website, but uses separate per-tenant `.remote-terminal-key` credentials and
an explicit `REMOTE_TERMINAL_TENANTS` allowlist. The initial deployment script
enables **openclaw1 only**. It does not restart the browser broker or other Claws.
Installing the native plugin allows openclaw1's gateway to reload when idle.

## Session and data controls

- Random UUID plus six-digit code, redeemed once; five incorrect attempts lock
  and terminate the session. Concurrent redemption has one winner.
- Hard lifetime 15 minutes; three minutes without viewer requests ends a connected
  session. A visible page polls and keeps that idle timer alive. Closing/suspending
  the tab allows it to expire; reopening the same browser can reconnect before then.
- One active terminal per Claw. Replacement, revocation, expiry, completion and
  broker shutdown close the PTY. Offboarding/key rotation is rechecked on requests
  and during the broker's periodic sweep.
- HttpOnly, Secure, SameSite=Strict viewer cookie scoped to this session's API.
  UUID+code in the same chat is **not** two independent factors. Keep destination
  account 2FA enabled; complete CLI/website verification yourself.
- Ordered input sequence numbers deduplicate retries. The viewer does not resend
  input after a network failure, drops queued input, and synchronizes the last
  acknowledged sequence before allowing more typing. Output polling is replayable.
  If the PTY itself fails, it never silently replaces it with a new shell.
- At most 1 MiB of recent output is retained in broker memory, with bounded
  responses. Reload/reconnect replays it; if old output was dropped the viewer
  resets and says so. This is not a durable terminal transcript.
- Terminal pages and API requests are excluded from site analytics, request logs
  and session recording, with no-store/no-referrer headers. The feature does not
  write typed input or output to disk. Bash reads the owner's interactive startup
  file and defaults history to /dev/null; owner startup settings take precedence. Commands can still write files, and CLI applications can have
  their own logging. The remote host and proxy handle input/output and are trusted.

This is full shell access under the Claw's existing container permissions. It can
change that Claw's files, accounts and processes. The agent is instructed to pause
the related task and not inspect the terminal; this is not a process-level lock
against every agent tool. The privileged host broker can invoke Docker and must
remain private. The enabled admin shell runs as root inside the owner’s container,
with a bounded set of Linux capabilities. The host Docker socket is not mounted.

## Owner control and recovery

The owner can use **Open admin shell** for system administration, or **New Claw
shell** for ordinary work. Both open a new shell and close the previous one. The
`openclaw` function in the root shell uses `runuser -u node`, preserving the file
ownership required by the running agent. Other commands, including package
installation, run as container root. Normal `.bashrc` configuration is loaded.

The signed-in owner can also create a connection at
`/remote-terminal/owner/<tenant>` from their account page. The website checks the
current assignment, account cookie, and Origin before calling the private broker;
a historical assignment or an administrator account alone does not confer access.
This does not depend on the Claw replying in chat. The container must be running;
a container that cannot start at all still requires hosting recovery.

See [owner-state/README.md](../owner-state/README.md) for configuration preservation,
owner backups, system-image checkpoints and the canary rollout.

## Verify and deploy

```sh
npm test
npm run typecheck
E2E_TEST_BUILD=1 npm --prefix ../8examples run build
REMOTE_TERMINAL_SITE_DIR=../8examples node remote-terminal/e2e.mjs
```

The integration test starts an isolated OpenClaw-image container and production
Next.js server with synthetic credentials, then uses Chromium and iPad-mode WebKit
over local HTTPS. It checks authentication, secure cookies, CSRF, real PTY keyboard
input, Unicode, interruption, network recovery without duplicate execution, browser
reload, saved files and completion. `verify-hooks.mjs` also boots an isolated real
OpenClaw gateway with a mock provider; it never uses live chat/provider credentials.

The devops `deploy-openclaw-remote-terminal.yml` workflow installs reviewed source
on the fleet host and verifies private connectivity from the actual website
container. The website deployment adds
`REMOTE_TERMINAL_BROKER_URL=http://100.97.6.94:18882` alongside its existing service
credential. Run the terminal workflow again with `verify_only=true`,
`verify_public=true`, and `verify_agent=true` after the website is live.
That check uses a separate private-chat turn with no chat delivery, opens a real
terminal, checks `id -un` and `test -t 0` through public HTTPS, and closes it.
It refuses to replace an owner who is already connected.

Push control-plane changes with `[skip ci]` during this canary rollout: its ordinary
main-push workflow updates the entire fleet. Use the dedicated terminal workflow
for this feature. Push the website normally to run its tests/build/deployment.

Rollback: stop `openclaw-remote-terminal.service` to revoke terminal access and
terminate its shells. Browser connections continue. Disable the
`managed-remote-terminal` plugin and remove the marked instruction block, its
skill/helper and `.remote-terminal-key` from openclaw1 to remove the offering.
Restore the previous website image if needed. Do not delete the Claw workspace.
