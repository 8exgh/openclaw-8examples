# Managed OpenClaw

Control plane for a fleet of **managed OpenClaw assistants** — one per customer.
The customer is a non-technical person who just messages "their assistant" on
WhatsApp/Telegram/Signal; you operate everything behind it: provisioning,
capabilities, secrets, updates, and the product's habit-building nudge loop.

```
                 ┌─────────────────────────────────────────┐
                 │ control plane (this repo)               │
  signup ──────► │  ops.ts        capability registry      │
  enable email ► │  nudge engine  fleet updater            │
                 └───────┬─────────────────────────────────┘
                         │ renders + docker compose up
        ┌────────────────┼──────────────────┐
        ▼                ▼                  ▼
  tenants/ana/      tenants/ben/       tenants/cho/
   openclaw.json     openclaw.json      openclaw.json     ← per-tenant config
   .env              .env               .env              ← per-tenant secrets
   workspace/        workspace/         workspace/        ← AGENTS/SOUL/nudges
   [container]       [container]        [container]       ← ghcr.io/openclaw/openclaw
        ▲                ▲                  ▲
      WhatsApp        Telegram           WhatsApp         ← the customer just texts
```

## Quickstart

```bash
npm install

# Provision a customer (renders tenants/<id>/ and starts their container if docker is up)
npm run cli -- signup --name "Ana Reyes" --phone +15555550123 --enable email,calendar

# See the fleet
npm run cli -- list
npm run cli -- status

# Toggle capabilities later — re-renders config + workspace and restarts the container
npm run cli -- enable ana-reyes sms
npm run cli -- disable ana-reyes sms

# Refresh the assistant's knowledge of its existing phone number (no restart)
npm run cli -- sync-phone <phone-enabled-tenant>

# Run the nudge engine (do this from cron, e.g. hourly)
npm run cli -- nudge

# Ship the newest OpenClaw + newest managed templates to every tenant
# (--canary updates that tenant first and halts if it comes up unhealthy)
npm run cli -- update --canary <your-own-tenant>

# Canary a specific release on ONE tenant without moving the fleet (e.g. a
# major version with one-way migrations); clear the pin once the fleet catches up
npm run cli -- pin openclaw1 ghcr.io/openclaw/openclaw:2026.8.1
npm run cli -- pin openclaw1 --fleet

# Offboarding: stop + reclaim the port; --purge-data also deletes everything
# stored about the person (the deletion-request path)
npm run cli -- offboard ana-reyes
npm run cli -- offboard ana-reyes --purge-data --yes

# Or drive everything over HTTP (for your signup form / admin UI)
MOC_ADMIN_TOKEN=secret npm run serve   # POST /signup, GET /tenants, POST /fleet/update, ...
```

`--no-start` (or `MOC_NO_START=1`) renders everything without touching Docker —
useful for dry runs and CI.

After signup, fill any `changeme` values in `tenants/<id>/.env` (the CLI lists
them) and run `apply <id>`.

## The three product ideas, and where they live

**1. Per-tenant capabilities** — `src/capabilities/registry.ts`.
Each capability (email, calendar, sms, phone, webdev, paperwork) declares:

- a `configPatch` deep-merged into that tenant's `openclaw.json` when enabled
- the secrets it needs in the tenant's `.env`
- a `workspaceDoc` of operating rules the agent gets (`workspace/capabilities/<id>.md`)
- its own **offer copy** (used while disabled) and **deepen copy** (used once enabled)

Adding a capability = adding one entry to that file. `paperwork` is on by default
so every customer gets value on day one with zero setup.

**2. Nudging / habit building** — `src/nudges/engine.ts` + the workspace templates.
The engine picks at most one nudge per tenant per day: first *offer* nudges that
sell the next capability on the ladder ("Want to give me access to your email — or
want me to set up a fresh one just for us?"), then *deepen* nudges that push more
offloading of what's already on. Cooldowns (72h per capability, 7d for deepen)
keep it from feeling like spam. Nudges are appended to the tenant's
`workspace/nudges/PENDING.md`; the agent's **heartbeat** (`HEARTBEAT.md`) delivers
them conversationally at a natural moment and moves them to `DELIVERED.md`.
The `offload-radar` skill covers the reactive side: spotting busywork in
conversation and offering to take it — including capability unlocks at the exact
moment they'd be useful.

**3. Everyone on the newest version** — `src/ops.ts#updateFleet`.
`npm run cli -- update` pulls the newest OpenClaw image, pins its digest so the
whole fleet runs the identical build, re-renders every tenant from the newest
templates, and rolling-restarts the containers. The "managed version" is a hash of
the templates + code version, so `list`/`status` show exactly who is behind
(`update pending`). New signups always provision on the current release. Run it
from cron for continuous updates.

## Residential egress (exit-node pool)

Desktop-tier tenant VMs join the tailnet at first boot and route **all** traffic
through a residential tailscale exit node, so tenants never present a
datacenter IP to WhatsApp/Google/etc. Design choices, deliberately:

- **Sticky, sharded, per-tenant.** A tailscale client uses exactly one exit
  node at a time, and messaging platforms treat IP flapping as an account-risk
  signal — so there is no per-connection load balancing. Instead each desktop
  signup takes the least-loaded node from the pool and keeps it. Sharding also
  spreads accounts across residential IPs (many accounts on one IP is itself a
  ban signal).
- **Fail closed.** If a tenant's exit node goes down, that tenant's traffic
  blackholes rather than leaking the datacenter IP. `egress check` is the alarm.
- **Failover is a decision, not a reflex.** `egress check` alerts; a human runs
  `egress migrate`. Moving a tenant changes its public IP — do it knowingly,
  and move tenants back deliberately after recovery.

Per exit node (a Pi at a residence works; needs a **distinct ISP connection**
to add real IP diversity):

```bash
echo -e 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
sudo tailscale up --advertise-exit-node --hostname=server2 --advertise-tags=tag:residential-exit
tailscale set --auto-update
```

And in the tailnet policy file:

```jsonc
"tagOwners": {
  "tag:residential-exit": ["autogroup:admin"],
  "tag:dc-egress":        ["autogroup:admin"]   // tenant VMs
},
"autoApprovers": { "exitNode": ["tag:residential-exit"] },
"acls": [{ "action": "accept", "src": ["tag:dc-egress"], "dst": ["autogroup:internet:*"] }]
```

Then, on the control plane:

```bash
npm run cli -- egress add-node server2 --ip <that-home's-public-ip> --location "parents' place"
npm run cli -- signup --name "Ana" --tier desktop        # gets the least-loaded node, sticky
MOC_TS_AUTHKEY=tskey-... npm run cli -- seed ana-reyes   # first-boot NoCloud seed (join + exit node)
npm run cli -- egress nodes                              # pool, assignments, online state
npm run cli -- egress check                              # cron this; non-zero exit on problems
npm run cli -- egress migrate --from server1 --to server2  # deliberate failover/rebalance
```

The seed's pre-auth key should be tagged `tag:dc-egress`. `egress migrate` and
the `egress check` probe reach VMs as `openclaw@openclaw-<tenant>` over the
tailnet (key-based SSH; the seed passes `--operator=openclaw` so no sudo is
needed for `tailscale set`). Expect a Pi 4-class node to top out around
150–300 Mbps of WireGuard — the real ceiling is usually the home connection's
**upload** bandwidth.

## What's managed vs. owned per tenant

| Path in `tenants/<id>/` | On re-render/update |
| --- | --- |
| `config/openclaw.json`, `docker-compose.yml` | overwritten (managed) |
| `workspace/AGENTS.md`, `HEARTBEAT.md`, `skills/`, `capabilities/` | overwritten (managed) |
| `.env` | merged — filled values always preserved |
| `workspace/SOUL.md` | seeded once, then the tenant's/agent's own |
| `auth-profile-secrets/` | never touched — **back this up**; it holds the encryption key for the tenant's stored OAuth tokens, and losing it invalidates every connected credential |
| `browser-cache/` | never touched (Playwright/Chromium downloads) |
| `workspace/nudges/`, `memory/`, everything else | never touched |

## Honest starting-point caveats

- **Plugin ids are integration points.** The `configPatch` for sms/phone/email
  references plugin/hook names (`twilio-sms`, `voice`, gmail hook) that you should
  align with the concrete OpenClaw plugins/providers you actually deploy — the
  registry is deliberately declarative so this is a one-line change per capability.
- **Enable flow is operator-driven.** When a customer says "enable it", the agent
  tells them it'll be switched on shortly; you run `enable <tenant> <cap>` (or wire
  the API to your signup/billing flow). Automating this end-to-end is the obvious
  next step.
- **State is JSON on disk** (`data/`), tenants are directories, containers run on
  one host. The *architecture* holds to ~50 customers; swap `store.ts` for a real DB
  and the provisioner for your orchestrator when you outgrow it. But the **compute
  ceiling arrives first**: tenants run with hard resource caps (4 GB text-only,
  6 GB once a browser capability is on — see `src/provisioner/resources.ts`), so a
  64 GB host realistically carries **12–15 mixed tenants**, not 50. Plan hosts
  against that number.
- **Secrets live in `.env` files** (mode 0600, tenant dirs 0700) and are injected as
  container environment — anyone with Docker access on the host can read them via
  `docker inspect`. The operator and host are trusted by every tenant; resistance to
  a compromised host is a non-goal at this stage. Say that honestly in your customer
  terms, and revisit a secret manager before the fleet is big enough to be a target.
- **Browser sandboxing**: the default image is browser-capable
  (`latest-browser`). Before relying on it for untrusted web content, verify
  Chromium launches with its own sandbox intact under `cap_drop: ALL` +
  `no-new-privileges` — if it silently falls back to `--no-sandbox`, treat that as
  the trigger to move browser workloads to stronger isolation (gVisor/Kata or the
  desktop-VM tier).
- **Model access**: Anthropic is the primary, followed by
  `openai/gpt-5.6-sol`, `kimi/k3`, and (when `MINIMAX_API_KEY` is present)
  `minimax/MiniMax-M3`. Each tenant's `.env` gets `ANTHROPIC_API_KEY` (inherited
  from your environment at render time if set). Install OpenAI authentication
  separately in each tenant's persistent auth store; do not copy one ChatGPT
  OAuth refresh token across containers because token rotation will cause the
  tenants to invalidate each other. For a shared fleet-wide backup, prefer a
  Platform API key with appropriate project budgets and spend limits.
- The gateway of each tenant publishes only on `127.0.0.1:<port>` — put your
  reverse proxy / tailnet in front for remote admin access.

## iPhone app ("My Claw")

`openclaw-iphone/` holds the SwiftUI app people use to chat with their claw(s),
share their location every 5 minutes (opt-in — the claws ask
`GET https://8examples.com/api/mobile/queries/owner-location?clawId=…`), and get
set-up pages for their website, phone number, Telegram bot and the Alexa "My
Claw" skill — plus the fleet-box relay worker that runs their messages through
`docker exec … openclaw agent`. The event-sourced backend lives in the
8examples repo (`src/app/lib/mobile.ts`). See
[openclaw-iphone/README.md](openclaw-iphone/README.md).

## Suggested cron

```cron
0 * * * *  cd /path/to/repo && npm run cli -- nudge      # hourly nudge pass
0 5 * * *  cd /path/to/repo && npm run cli -- update --canary <your-own-tenant>
15 * * * * cd /path/to/repo && npm run cli -- egress check  # exit nodes up + IPs right (fails loud)
```

Run your own instance as tenant zero and let it eat the bad releases: with
`--canary`, the nightly update stops before touching customers if the new image
comes up unhealthy, and `fleet.previousImageRef` records the rollback target.
