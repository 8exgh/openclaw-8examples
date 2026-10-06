# Temporary OpenClaw dashboard

In private chat, ask **“Let me connect to the OpenClaw web dashboard.”** The
installed plugin returns an actual `https://8examples.com/remote-dashboard/<uuid>`
link, a six-digit one-time code, and an expiry. Recognized requests use the helper
directly without a model round trip. Runtime instructions also advertise the
helper for contextual requests in existing conversations.

The website shows the real OpenClaw Control UI through the existing remote-browser
controls. This is a remote browser view, rather than a separately reimplemented
dashboard. Keyboard, clicks, scrolling, and paste work; native local downloads,
file pickers, and copying text out of the remote page are not provided by this
viewer. The dashboard has its normal owner administration capabilities.

The broker creates a **dedicated incognito context** inside the selected tenant's
managed Chromium. It opens only that tenant's fixed local gateway and waits for
the UI's successful gateway handshake before returning a link. The permanent
gateway token stays inside the tenant. The website receives pixels and input,
never executable tenant-hosted HTML or the gateway token. Tab selection and
reconnection cannot escape into ordinary browser tabs. No gateway authentication
settings, network ports, or browser login profiles are weakened or exposed.

The six-digit code is redeemed once into a Secure, HttpOnly, SameSite=Strict
cookie scoped to this dashboard's API. Refresh uses that cookie. Five wrong codes
lock the session. Hard expiry is 15 minutes; three minutes without an active viewer
also ends it. Close, revocation, replacement, credential rotation/offboarding,
broker shutdown, and bridge loss dispose the private browser context. Saved
OpenClaw changes remain. A dead bridge requires a new handoff; it cannot silently
open a fresh authenticated dashboard for an old viewer. Browser and terminal
handoffs use separate credentials and cookies. Pages and API traffic exclude
analytics, request logs, recording, and caches.

## Install and verify

The site needs `REMOTE_DASHBOARD_BROKER_URL=http://100.97.6.94:18884` and its
existing `REMOTE_CONNECT_SERVICE_TOKEN` and `REMOTE_CONNECT_PUBLIC_ORIGIN`.
The dedicated broker uses `.remote-dashboard-key` per tenant and requires an
explicit `REMOTE_DASHBOARD_TENANTS` list. Normal rendering preserves an enabled
dashboard helper and plugin; it does not enable new tenants on its own.

```sh
node --test remote-connect/*.test.mjs remote-dashboard/*.test.mjs
npm run typecheck
CLAW_TEST_MODE=1 E2E_TEST_BUILD=1 npm --prefix ../8examples run build
node remote-dashboard/e2e.mjs
# Fleet host, with the existing service secret supplied through the environment:
sudo --preserve-env=MOC_ROOT,REMOTE_CONNECT_SERVICE_TOKEN,REMOTE_DASHBOARD_HOST,REMOTE_DASHBOARD_TENANTS bash remote-dashboard/deploy.sh
```

The real integration test boots an isolated OpenClaw gateway and Chromium, opens
the authenticated dashboard through public-style HTTPS, and checks OTP replay,
cookie scope, CSRF, refresh, input, secret exclusion, and browser-context cleanup.
Ordinary browser tabs must survive completion unchanged. No real model, chat,
email, or customer credentials are used.

Deploy with devops `deploy-openclaw-remote-dashboard.yml` and the website workflow.
Stop `openclaw-remote-dashboard.service` to revoke dashboard access on rollback.
To remove the offering from a tenant, disable `managed-remote-dashboard` and
remove its helper/skill/instruction block and `.remote-dashboard-key`. Preserve
the owner's other settings, browser profile, workspace, and conversations.
