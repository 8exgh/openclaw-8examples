# Temporary native OpenClaw dashboard

In private chat, ask **“Let me connect to the OpenClaw web dashboard.”** The
plugin returns an actual `https://8examples.com/remote-dashboard/<uuid>` link,
a six-digit one-time code, and an expiry. Recognized requests use the helper
without a model round trip.

After code entry, the native OpenClaw Control UI opens directly in the owner's
browser. HTTP assets, uploads/downloads and the gateway WebSocket stream through
8Examples and the private fleet broker to that tenant's gateway. No Chromium,
screenshots, simulated input, or remote-browser session is involved. Native text
selection, browser rendering, responsive layout and file controls are available.
The dashboard retains its normal owner administration capabilities.

Each session uses `https://dashboard-<uuid>.8examples.com`, isolating executable
tenant content and browser storage from the public website and other dashboards.
A separate one-use, 60-second ticket is exchanged by POST; credentials never
appear in URLs. The dashboard cookie is Secure, HttpOnly, SameSite=Strict,
`__Host-` prefixed, and bound to its exact hostname. Origin checks protect writes
and WebSocket upgrades, including requests from sibling tenant origins.

The fleet broker reaches the fixed tenant container's gateway through a streaming
Docker stdin/stdout TCP connection. No new tenant port is opened. The broker
adds gateway credentials on the server and authenticates as a local backend
client; the browser receives neither the permanent token nor a device credential.
The gateway's existing authentication, configuration and other clients stay intact.

Codes redeem once; five wrong guesses lock the session. Hard expiry is 15 minutes;
three minutes without an active viewer also ends it. Close, revocation,
replacement, offboarding and broker restart terminate access, including existing
WebSockets and in-flight proxy streams. Saved OpenClaw changes remain. Portal
responses are not cached; service workers, analytics and session recording are
excluded. Browser and terminal handoffs remain independent.

## Install and verify

The site needs `REMOTE_DASHBOARD_BROKER_URL=http://100.97.6.94:18884`, the existing
`REMOTE_CONNECT_SERVICE_TOKEN`, and `REMOTE_CONNECT_PUBLIC_ORIGIN=https://8examples.com`.
The website's `portal-server.mjs` fronts its existing standalone Next server and
handles native HTTP/WebSocket proxying. Exact website hosts still go to Next;
unrecognized wildcard hosts return 404. Cloudflare wildcard DNS/ingress uses the
same website origin and preserves all existing exact host routes.

The dedicated broker requires `.remote-dashboard-key` per tenant and an explicit
`REMOTE_DASHBOARD_TENANTS` list. Normal tenant rendering preserves the enabled
helper/plugin; it does not enable additional tenants automatically.

```sh
npm ci
npm ci --prefix remote-dashboard
node --test remote-connect/*.test.mjs remote-dashboard/*.test.mjs
npm run typecheck
CLAW_TEST_MODE=1 E2E_TEST_BUILD=1 npm --prefix ../8examples run build
REMOTE_DASHBOARD_SITE_DIR=../8examples node remote-dashboard/e2e.mjs
```

The real integration test starts an isolated OpenClaw gateway with its managed
browser disabled. It verifies native UI authentication over HTTPS/WebSockets,
credentials, origin isolation, refresh, close and expiry. The test uses local
loopback addresses under `127.0.0.1.nip.io` to exercise same-site host isolation.
No model calls or messages are delivered.

Deploy with devops `deploy-openclaw-remote-dashboard.yml`, the website workflow,
and `configure-dashboard-proxy.yml`. The route workflow checks first and refuses
to overwrite any conflicting wildcard. Enable only the selected tenants.

For rollback, restore the previous broker systemd release and website image
together. Stopping `openclaw-remote-dashboard.service` immediately revokes all
native dashboard sessions. Older browser-view source files remain available for
rollback but are not used by the deployed broker.
