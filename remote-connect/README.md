# Remote browser login

When a Claw reaches a login or verification step, it opens that page in its
managed `openclaw` browser profile and runs:

```sh
node remote-connect/session.mjs create <targetId>
```

The installed helper returns an actual `https://8examples.com/remote-connect/<uuid>`
link, six-digit code (including leading zeroes), and expiry. The owner opens the
link, enters the code, and interacts with that same browser. **Done — return
control** detaches the connection; the browser, profile, and login cookies remain.
The owner replies in the original chat, and the Claw checks `session.mjs status`
before verifying login and continuing. It can also `session.mjs revoke`.

## Components

- `templates/workspace/remote-connect/` and `skills/remote-login/`: installed
  helper and contextual instructions, included in every container tenant render.
  The instructions explicitly replace obsolete VNC/portal links in older
  conversations and prohibit loopback or private addresses as login links.
- `remote-connect/plugin/` adds this capability to native runtime system
  context. Explicit takeover requests in private conversations create the
  session directly through the helper, so stale conversation history cannot
  substitute a local VNC link. Shared rooms first move to private chat;
  other requests use the normal agent. A browser that is not running is left
  to the agent to start and open to the intended site.
  An outbound reply check also catches follow-ups such as “I'm confused” when
  the model repeats obsolete private-server/Control UI advice. In a private
  chat it replaces that advice with a real helper-created connection. An
  already connected viewer keeps control. Named LinkedIn requests select the
  existing LinkedIn tab instead of an unrelated foreground tab.
  `AGENTS.md` tells the Claw to offer this for login, password, MFA, or CAPTCHA,
  share both link and code, then stop inspecting/controlling the browser until
  control is returned. Pausing other automation is an agent instruction, not a
  process-level browser lock.
- `server.mjs` / `broker.mjs`: host service next to Docker. It checks a distinct
  credential for each tenant and live assignment/offboarding state, resolves the
  fixed `openclaw-<tenant>` container, and proves the tab is reachable before
  issuing a link. No client can specify a container, CDP host, or CDP command.
- `transport.mjs` / `browser-bridge.mjs` / `browser-client.mjs`: trusted code passed into that container
  through `docker exec` stdio. It attaches to the existing browser's local CDP
  endpoint. Only page pixels, tab selection, and a restricted input vocabulary
  cross this channel. Chrome's debugging port is never published.
- `8examples/src/app/api/remote-connect/[...path]/route.ts`: same-origin HTTP
  proxy. A broker service credential is server-only; per-tenant helper tokens
  authorize creation/status/revocation. A successful code redemption issues an
  HttpOnly, Secure, SameSite=Strict cookie scoped to that session's API path.
- `8examples/src/app/remote-connect/[id]/`: responsive browser viewer with
  clicking, keyboard/paste/Unicode input, scrolling, tab selection, and Done.
  Pixels are fetched while the page is visible. No WebSocket proxy or new public
  domain is required; the existing Cloudflare → Next.js HTTPS route is used.

Sessions live only in broker memory. Restarting it revokes all sessions. Links
last 15 minutes; connected viewers expire after 3 minutes without activity.
Codes redeem once and lock after five failures. One session per Claw; creating
a replacement closes the previous attachment. Input and frames are never written
to logs, databases, or disk by this feature. The page excludes site analytics,
session recording, and request logging; responses use no-store and no-referrer.
Only credential-free connection status is written into the Claw's workspace.
Temporary CDP/image/network failures retain the viewer cookie and allow a
30-second recovery window. A lost bridge is recreated against the existing
browser; a closed login popup returns to its surviving opener. Failed input is
never replayed, and the viewer drops queued typing until a fresh frame arrives.
Only fixed error categories and tenant/action names enter operational logs.

This supports browser content, including web login popups. Native desktop
dialogs, file pickers, browser chrome, and owner-device passkeys are outside this
implementation. It does not automatically send a chat message on Done.

## Deployment

1. Set a random 32-byte-or-longer `REMOTE_CONNECT_SERVICE_TOKEN` GitHub secret
   in the **remote-connect environment of 8exgh/devops** (its repository secret
   slots are full). Both broker and website deployment jobs use that environment.
   No shared fleet administration or telemetry token is given to a tenant.
2. Run devops `deploy-openclaw-remote-connect.yml` against the reviewed source
   ref, initially with tenant `openclaw1`. It installs a systemd broker at
   `100.97.6.94:18880` and updates only the selected workspace. It does not
   restart Claws or update their model/browser configuration. The second job
   proves connectivity from inside the actual website container on Server7.
3. Deploy the website with the updated devops website workflow. Its environment:
   `REMOTE_CONNECT_BROKER_URL=http://100.97.6.94:18880`, the service token above,
   and `REMOTE_CONNECT_PUBLIC_ORIGIN=https://8examples.com`.
4. Run the broker workflow with `verify_public=true` to verify a real session
   through the public site. `verify_agent=true` also asks the actual canary agent
   to create the handoff from a normal login request (one model turn, no chat
   delivery; allows up to five minutes for the configured provider).
   To reproduce an old conversation repeating a broken portal link, pass its
   session key as `verify_session` with `verify_agent=true`. This adds a
   broken-link test turn to that conversation's history without delivering a
   chat message, uses only a new example.com tab, and closes the test handoff.
   Rerun the broker workflow with `all_tenants=true`
   to install instructions across the container fleet. Future
   tenant renders preserve the scoped credential and reinstall the helper.
   Use `workspace_only=true` for instruction/helper corrections: it leaves
   the broker and browser processes running, preserving active connections.
   Set `runtime_hooks=true` to install the native handoff plugin too. This
   changes the Claw's plugin configuration; OpenClaw reloads its gateway when
   idle. Start with the canary, then roll out with `all_tenants=true`.
   Plugin code updates use a content-addressed load path so an already-running
   gateway loads the new hooks. This also bypasses the old manifest cache;
   adding a revision property to plugin config can be rejected by that cache.

Server7 must be able to reach the fleet's private Tailscale address (including
from `nextjs-8examples`); the deployment verification fails if the route or tailnet
ACL is missing. No public VNC/CDP port, DNS change, or Cloudflare tunnel change
is needed. The broker binds only loopback or a Tailscale IPv4 address and rejects
every request without the service token.

Rollback: stop `openclaw-remote-connect.service` to revoke remote access
immediately. Existing browser logins remain. Restore the prior website image
if necessary. To remove the offering, remove the marked `managed-remote-connect`
block from tenant AGENTS.md and the `skills/remote-login` folder. Never remove
the tenant's browser profile as part of remote-connect rollback.

## Verification

```sh
npm test
npm run typecheck
E2E_TEST_BUILD=1 npm --prefix ../8examples run build
node remote-connect/e2e.mjs
```

`remote-connect/verify-hooks.mjs <plugin-directory>` runs inside an OpenClaw
container and boots an isolated gateway with a local mock model and helper. It
verifies that private takeover requests invoke the helper without a model call,
that ordinary prompts receive the runtime context, and that leading zeroes in
codes survive. It inherits no live channel tokens or provider credentials.

`remote-connect/verify-telegram.mjs <plugin-directory>` exercises actual Telegram
polling and outbound delivery through a loopback fake Bot API. It deliberately
makes the mock model repeat the observed private-server refusal on an iPad
follow-up, and asserts that Telegram receives a helper-created link and code.
The deployment workflow's `verify_telegram=true` runs this against the canary's
installed hook files with isolated state, synthetic credentials, and no calls
to the real Telegram service.

The last test boots an isolated **real OpenClaw graphical browser**, broker, and
production Next.js site, then drives the viewer through Playwright. It enters
synthetic credentials, submits a login, returns control, and asks OpenClaw for a
snapshot proving it sees the authenticated page. It also verifies wrong/reused
codes, authentication, CSRF, cookie flags, reconnect, popup switching and automatic
return after popup closure, and exclusion of analytics.
It cleans up its container and temporary credentials; its non-sensitive
screenshot is under ignored `artifacts/remote-connect/`.

Defaults: browser image `ghcr.io/openclaw/openclaw:2026.8.1-browser`, site checkout
`../8examples`, local ports 18881 and 3104. Override `REMOTE_CONNECT_TEST_IMAGE`
and `REMOTE_CONNECT_SITE_DIR` as needed. Install the site's Playwright Chromium
before running. No model call or external account is needed for this test.

Protocol references: [OpenClaw managed browser](https://docs.openclaw.ai/tools/browser),
[CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/).
