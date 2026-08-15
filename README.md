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

# Run the nudge engine (do this from cron, e.g. hourly)
npm run cli -- nudge

# Ship the newest OpenClaw + newest managed templates to every tenant
# (--canary updates that tenant first and halts if it comes up unhealthy)
npm run cli -- update --canary <your-own-tenant>

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
- **Model access**: Anthropic is the primary and `openai/gpt-5.6-sol` is the
  managed fallback. Each tenant's `.env` gets `ANTHROPIC_API_KEY` (inherited
  from your environment at render time if set). Install OpenAI authentication
  separately in each tenant's persistent auth store; do not copy one ChatGPT
  OAuth refresh token across containers because token rotation will cause the
  tenants to invalidate each other. For a shared fleet-wide backup, prefer a
  Platform API key with appropriate project budgets and spend limits.
- The gateway of each tenant publishes only on `127.0.0.1:<port>` — put your
  reverse proxy / tailnet in front for remote admin access.

## Suggested cron

```cron
0 * * * *  cd /path/to/repo && npm run cli -- nudge      # hourly nudge pass
0 5 * * *  cd /path/to/repo && npm run cli -- update --canary <your-own-tenant>
```

Run your own instance as tenant zero and let it eat the bad releases: with
`--canary`, the nightly update stops before touching customers if the new image
comes up unhealthy, and `fleet.previousImageRef` records the rollback target.
