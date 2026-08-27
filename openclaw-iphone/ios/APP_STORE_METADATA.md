# App Store metadata for My Claw

Everything App Store Connect asks for lives in `tools/submit.py` (categories,
subtitle, description, keywords, URLs, age rating answers, review notes, demo
account) and is pushed with:

```bash
export ASC_KEY_ID=F83792G38S ASC_ISSUER_ID=<issuer uuid>     # key in ~/.private_keys
python3 tools/submit.py            # all steps, idempotent
python3 tools/submit.py screenshots review                      # or single steps
```

| Field | Value |
|---|---|
| App record | https://appstoreconnect.apple.com/apps/6805721460 |
| Bundle ID | `com.8examples.openclaw` (project) — must match the record |
| Name | My Claw |
| Subtitle | Talk to your OpenClaw assistant |
| Category | Productivity / Business |
| Price | Free, no IAP |
| Privacy policy | https://8examples.com/openclaw/privacy |
| Terms | https://8examples.com/openclaw/terms (linked in description + review notes) |
| Support | https://8examples.com/contact · Marketing: https://8examples.com/openclaw |
| Age rating | 4+ (nothing declared) |
| Demo account | openclaw1 (a live claw) |

## Not automatable (web UI only)

- **App Privacy** (nutrition labels): Location (precise) — app functionality, linked to user;
  User content (messages) — app functionality, linked to user; User ID (username) —
  app functionality, linked to user. No tracking.
- Availability / pricing tier (Free, all territories) if not already set.

## Build

```bash
xcodebuild -project OpenClaw.xcodeproj -scheme OpenClaw -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/OpenClaw.xcarchive -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/OpenClaw.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/out -allowProvisioningUpdates   # uploads
```

## Regenerating screenshots

`OPENCLAW_DEMO=1` answers every API call locally (`Models/DemoMode.swift`);
`OPENCLAW_DEMO_TAB` / `OPENCLAW_DEMO_SCREEN` choose the screen. On an
iPhone 17 Pro Max simulator (1320×2868):

```bash
xcrun simctl create "MyClaw ProMax" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max com.apple.CoreSimulator.SimRuntime.iOS-26-0
xcodebuild -project OpenClaw.xcodeproj -scheme OpenClaw -sdk iphonesimulator -configuration Release CODE_SIGNING_ALLOWED=NO -derivedDataPath build/dd build
xcrun simctl install booted build/dd/Build/Products/Release-iphonesimulator/OpenClaw.app
SIMCTL_CHILD_OPENCLAW_DEMO=1 SIMCTL_CHILD_OPENCLAW_DEMO_TAB=claws SIMCTL_CHILD_OPENCLAW_DEMO_SCREEN=chat xcrun simctl launch booted com.8examples.openclaw
xcrun simctl io booted screenshot Screenshots/iphone-6.9/01-chat.png
```
