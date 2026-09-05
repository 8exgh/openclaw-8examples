# openclaw-iphone — the "My Claw" iPhone app + fleet-box relay

The SwiftUI app for people who own a claw, and the one worker that has to run
next to the containers. **The backend lives in 8examples**
(`src/app/lib/mobile.ts`, `src/app/api/mobile/*`, table `mobile_phone_events`)
— that repo is already the system of record for credentials, assignments,
phone numbers, domains and the Alexa skill, so the app reads them from there
instead of duplicating them.

```
   iPhone (SwiftUI, ios/)              8examples.com                          fleet box
 ┌───────────────────┐  mob_ token ┌──────────────────────────────┐        ┌────────────────────────────┐
 │ Claws  (chat/claw)│ ──────────► │ /api/mobile/*                │        │ background-processor/       │
 │ Location (5 min)  │             │  events: sessions, telegram  │ ◄───── │  poll messages-awaiting-…   │──docker exec──► openclaw-openclaw1
 │ Website           │             │  mobile_phone_events:        │ oct_   │  → record-claw-reply        │                 …
 │ Phone             │             │   consent · fixes · chats    │ token  │                            │                 openclaw-openclaw100
 │ Connect (TG/Alexa)│             │  pump: mark quiet phones     │        └────────────────────────────┘
 └───────────────────┘             │        lapsed                │
                                   └──────────────▲───────────────┘
                                                  │ oct_ token (the claw's own telemetry token)
                                   openclawN: GET /api/mobile/queries/owner-location?clawId=openclawN
```

| Dir | What |
| --- | --- |
| `ios/` | The single SwiftUI app "My Claw" (`OpenClaw.xcodeproj`, iOS 17+, bundle `ai-assistant.8examples.com`). Tabs: Assistants, Glasses, Location, Website, Phone, Connect (Telegram + Alexa); iOS places overflow tabs under More. |
| `background-processor/` | Relay worker for the fleet box: polls 8examples for unanswered owner messages, runs `docker exec openclaw-<id> openclaw agent …` (same as `rocketchat/bridge.mjs`, own `iphone:` session key), records the reply; 5 retries then `failed`. `CLAW_RUNNER=echo` for local dev. |
| `http/` | JetBrains HTTP-client walkthrough of the API. |
| `../templates/workspace/capabilities/iphone.md` | Rendered into every tenant workspace by the provisioner: how a claw asks where its owner is, how it records its Telegram bot. |

## Auth

- **App**: `POST /api/mobile/login` with the claw's own Rocket.Chat
  username/password (`claw_added`; assigned and not retired). Returns a
  `mob_…` session token (30 days, Keychain). Cancelling a claw invalidates it.
- **Claws + relay worker**: the per-claw telemetry access token (`oct_…`)
  the fleet already has — no new key to distribute.

## Run

```bash
# backend: 8examples (npm run dev there)

# relay worker, on the fleet box
cd background-processor && cp .env.example .env   # BACKEND_ACCESS_TOKEN=oct_…
npm install && npm run dev                          # or: docker compose up -d --build
```

Every tenant gets `workspace/capabilities/iphone.md` from the provisioner
(`npm run cli -- update` / `apply <tenant>`); it uses the `OPENCLAW_TELEMETRY_TOKEN`
the tenant already has.

## iPhone app notes

- Server URL: `Info.plist → OPENCLAW_API_BASE_URL` (https://8examples.com),
  overridable on the login screen for local dev.
- **Location**: yes → `give-location-consent` → iOS permission (When-in-use,
  then the "Always" upgrade) → Core Location with the `location` background
  mode posts the newest fix every 5 minutes (`AppConfig.locationReportInterval`).
  Shows the last fix on a map, "stale" once lapsed, Stop = revoke.
- **Website**: domain + `<slug>.fusenv.com` from the claw's provisioning,
  opens in Safari, edit hints drop into the chat.
- **Phone**: the number from `phone_number_provisioned`, Call/Text buttons,
  tips ("check my SMS every 15 minutes", "phone 555-555-1234 and reserve the
  next appointment", "call `<number>` while you drive").
- **Connect**: Telegram (BotFather steps, `@bot` once recorded) and Alexa
  ("My Claw" — store link = `openclaw.alexaSkill.storeUrl`, pairing steps,
  utterances).

Build check: `xcodebuild -project ios/OpenClaw.xcodeproj -scheme OpenClaw -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`.

## Glasses in this app

The **Glasses** tab shares this app's existing login, Keychain and assistant
picker. It supports spoken requests through paired Meta glasses, spoken replies,
and a summary inbox. Signing out stops listening and disconnects the notification
subscription. Notification taps open the Glasses inbox for an owned assistant;
receiving a notification does not change the selected assistant by itself.

Its one new backend is [openclaw-meta-glasses](../openclaw-meta-glasses/README.md).
Deploy that relay on the fleet host, then set `OPENCLAW_GLASSES_RELAY_URL` in
`Info.plist` or use **Glasses → Connection settings**. The tab uses the same `mob_`
session as the rest of the app. No second app registration or password flow is
needed. Existing chat and location traffic still uses `/api/mobile/*`.

Enable Push Notifications on the existing App ID `ai-assistant.8examples.com`.
The project keeps that bundle identifier, signing team and app icon. The new
backend's `APNS_TOPIC` must match it. Debug uses development/sandbox push;
Release/TestFlight uses production. The app retains its `location` background
mode and adds `audio` for a listening session the owner starts explicitly.

`OpenClawTests` is included in the existing Xcode scheme. Its tests cover shared
session use, assistant selection, request retries, sign-out, addressed speech,
and screenshot mode; the test host runs with `OPENCLAW_DEMO=1` to avoid real
account traffic. Run them on an available iPhone simulator in Xcode. Native
build, signing, and paired-device checks require a Mac with the iOS SDK.
