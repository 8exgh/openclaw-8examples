# Rocket.Chat ⇄ OpenClaw fleet

Gives issued people a web chat to talk to *their* openclaw(s) — with per-person
access control — without OpenClaw having native Rocket.Chat support.

```
  person's browser                  server7 (home)              datacenter box
  ────────────────    HTTPS    ┌──────────────────┐        ┌────────────────────┐
   chat.fusenv.com  ─────────► │ Rocket.Chat :3060│        │  bridge :8090      │
   (Cloudflare tunnel)         │  #openclaw1 ...  │──hook─► │  ├ docker exec ───►│ openclaw-openclaw1
                               │  #openclaw20     │◄─reply─ │  ├ ...             │ ...
                               └──────────────────┘  REST  │  └ openclaw agent  │ openclaw-openclaw20
```

## Pieces

- **Rocket.Chat** on server7:3060 (`devops` → `deploy-rocketchat.yml`). Admin
  `admin` / `openclaw-admin`.
- **provision.mjs** — creates 20 users (`openclaw1`..`openclaw20`, password =
  username), 20 **private** channels of the same name, a bridge bot, and one
  outgoing webhook covering all 20 channels.
- **bridge.mjs** — runs on the datacenter box (`deploy-bridge.sh` → systemd
  `openclaw-rc-bridge`). Receives the webhook, runs the matching container's
  `openclaw agent`, posts the reply back via the REST API.

## Access model (the "proper" way)

**Channel membership is the permission.** User `openclawK` is a member of only
`#openclawK`, so they can only reach container openclawK. To issue someone a
second assistant, add their account to that channel too:

```
POST /api/v1/groups.invite  { roomName: "openclaw13", userId: <their id> }
```

Nothing else changes — the bridge already serves every channel.

## Bring-up order

1. Deploy Rocket.Chat: `gh workflow run deploy-rocketchat.yml -R 8exgh/devops`.
2. **Cloudflare tunnel** (your Cloudflare dashboard): `chat.fusenv.com` →
   `192.168.4.56:3060`. Required so external people can reach the web UI.
3. Provision, from anywhere that can reach the Rocket.Chat API:
   ```
   RC_URL=https://chat.fusenv.com RC_ADMIN_PASS=openclaw-admin \
   BRIDGE_HOOK_URL=http://<datacenter-public-ip>:8090/hook \
   WEBHOOK_TOKEN=<secret> RC_BOT_PASS=<secret> node rocketchat/provision.mjs
   ```
4. On the datacenter box: fill `/etc/openclaw/rc-bridge.env` (matching
   `WEBHOOK_TOKEN` / `RC_BOT_PASS`), then `sudo bash rocketchat/deploy-bridge.sh`.
   Open the bridge port so Rocket.Chat can reach it: `sudo ufw allow 8090/tcp`.
5. Test: log into `chat.fusenv.com` as `openclaw1` / `openclaw1`, open `#openclaw1`,
   say hi — openclaw1 replies.

## Notes / caveats

- The bridge talks to each container with `docker exec … openclaw agent`, keyed by
  a per-(channel,user) session so conversations stay separate.
- The bridge posts as the bot and ignores its own messages (no reply loops).
- The bridge port (8090) is a public, token-checked endpoint on the datacenter box.
  Lock it to Rocket.Chat's egress IP with ufw when you know it, or front it with a
  reverse proxy.
- Default passwords (`openclawN`, admin) are for bring-up — rotate before real users.

## REST rate limiter

`set-rate-limit.mjs` raises Rocket.Chat's REST limiter defaults
(`API_Enable_Rate_Limiter_Limit_Calls_Default` per
`API_Enable_Rate_Limiter_Limit_Time_Default` ms, per endpoint per client IP;
stock default 10 per minute). Run it through the devops
`rc-rate-limit.yml` workflow (inputs `calls`, default 600, and `time_ms`). The
8examples squeeze-page demo chat tripped the stock limit for every visitor
from the site's single IP, which is why this exists.
