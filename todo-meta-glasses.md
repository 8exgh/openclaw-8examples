# Meta glasses: remaining setup and verification

The implementation is in the existing iPhone app, with one new backend in
`openclaw-meta-glasses/`. The source work is complete; the relay has not been
deployed, push credentials have not been configured, and the iOS build and
paired-glasses checks still need to be done. Backend/fleet validation passed
30 tests, TypeScript checking, and backend syntax checking on September 5, 2026.

Use the [backend README](openclaw-meta-glasses/README.md) for configuration details
and the [iPhone README](openclaw-iphone/README.md) for the existing app.

## 1. Build and test the existing app on a Mac

- [ ] Pull the committed changes on a Mac with Xcode and the iOS SDK.
- [ ] Open `openclaw-iphone/ios/OpenClaw.xcodeproj` and select the existing
  **OpenClaw** scheme. Keep the existing app identity:
  `ai-assistant.8examples.com`. There is no second app to register or install.
- [ ] Build for an iPhone simulator and fix any native build errors. This work
  was implemented on Linux, where Xcode was unavailable:

  ```bash
  cd openclaw-iphone
  xcodebuild -project ios/OpenClaw.xcodeproj -scheme OpenClaw \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    CODE_SIGNING_ALLOWED=NO build
  ```

- [ ] Select an available iPhone simulator in Xcode and run **Product → Test**
  for `OpenClawTests`. These tests cover shared login, assistant selection,
  request retries, sign-out, addressed speech, and demo mode. The test host
  uses demo mode to avoid real account traffic.
- [ ] Check the existing chat, location, website, phone, and connection screens
  still work. The Glasses tab is second; iOS puts overflow tabs under **More**.

## 2. Deploy the new backend on the fleet host

- [ ] Choose a public HTTPS hostname for the relay, point its DNS at the fleet
  host, and configure TLS with the existing reverse proxy. Replace
  `glasses.your-domain.example` below with that real hostname.
- [ ] Pull the committed source into `/home/openclaw/managed-openclaw` on the
  fleet host. Confirm Docker can access `openclaw-openclaw1` and the host has
  Node 22.18+ for the setup commands.
- [ ] Generate the private relay configuration:

  ```bash
  cd /home/openclaw/managed-openclaw/openclaw-meta-glasses
  node integration/configure.mjs openclaw1
  mkdir -p data secrets
  ```

  This creates `.env` and `config.local.json`, preserving keys on later runs.
  Leave `IDENTITY_URL=https://8examples.com` for the existing production login.
- [ ] Start the single relay service:

  ```bash
  docker compose up -d --build
  docker compose ps
  curl --fail http://127.0.0.1:8795/health
  ```

- [ ] Route the public HTTPS hostname to `127.0.0.1:8795`. For Caddy, the site
  configuration is:

  ```caddyfile
  glasses.your-domain.example {
      reverse_proxy 127.0.0.1:8795
  }
  ```

- [ ] Check `https://glasses.your-domain.example/health` from outside the host.
  Keep the relay port bound to loopback and Docker access local to the host.
- [ ] Arrange private backups of `.env`, `config.local.json`, the APNs key,
  and `data/`. Back up SQLite using its backup facilities or with the relay
  stopped. Keep the encryption key with the database backup so queued sessions
  can be recovered. Run only one relay process per database.

## 3. Configure iPhone push notifications

Push is needed for completion notifications while the app is inactive; the
inbox and active listening session can be tested before push is configured.

- [ ] In the Apple Developer account, enable Push Notifications on the existing
  App ID `ai-assistant.8examples.com` and refresh its provisioning profile.
- [ ] Create or reuse an APNs signing key authorized for that App ID. Place its
  `.p8` file on the fleet host at `openclaw-meta-glasses/secrets/AuthKey.p8`.
  Keep the key and generated relay configuration out of Git.
- [ ] Fill in the relay's private `.env`:

  ```dotenv
  APNS_KEY_FILE=/app/secrets/AuthKey.p8
  APNS_KEY_ID=YOUR_KEY_ID
  APNS_TEAM_ID=YOUR_TEAM_ID
  APNS_TOPIC=ai-assistant.8examples.com
  APNS_ENVIRONMENT=sandbox
  ```

  The key path above is inside the Compose container. Use the actual local path
  if running the relay directly with Node.
- [ ] Match the relay's APNs environment to the installed app: `sandbox` for a
  Debug device build, `production` for Release/TestFlight. The current relay uses
  one APNs environment at a time. Recreate it after changing `.env` with
  `docker compose up -d --force-recreate`.
- [ ] Confirm signing uses the existing team and the app has Push Notifications,
  microphone/speech usage descriptions, and both `audio` and `location`
  background modes. These are already represented in the project source.

## 4. Connect openclaw1 and the iPhone

- [ ] Enable summaries from tasks completed in other channels. On the fleet
  host, substitute the real HTTPS origin and run:

  ```bash
  cd /home/openclaw/managed-openclaw/openclaw-meta-glasses
  node integration/connect-tenant.mjs \
    /home/openclaw/managed-openclaw/tenants/openclaw1 \
    https://glasses.your-domain.example
  cd ..
  npm ci
  npm run cli -- enable openclaw1 glasses
  ```

  The enable command installs the managed summary helper/instructions and
  restarts `openclaw1` with the two glasses environment variables.
- [ ] Build and install the updated existing app on the iPhone. Sign in with the
  existing 8examples account and select `openclaw1`.
- [ ] Open **Glasses → Connection settings**, enter the relay's HTTPS origin,
  and connect. Alternatively, set `OPENCLAW_GLASSES_RELAY_URL` in the existing
  `Info.plist` before building. There is no separate glasses login.
- [ ] Enable **Notify me when work is done** and allow iOS notifications after
  the relay has APNs configured.
- [ ] Pair the glasses through the Meta app and iPhone Bluetooth settings.
  Allow microphone, speech recognition, and any requested Bluetooth access.
  Select the glasses microphone in the Glasses tab and start a listening session.

## 5. Verify on the real iPhone and glasses

- [ ] Say **“OpenClaw, tell me which assistant I selected.”** Confirm it reaches
  `openclaw1`, produces one inbox reply, and speaks through the glasses.
- [ ] Verify speech without an OpenClaw address is ignored and the spoken reply
  does not trigger another request. Test **“OpenClaw, stop listening.”**
- [ ] Test with the phone locked, then test a Bluetooth disconnect and an audio
  interruption. Confirm the app stops or recovers as shown in its UI and the
  explicit listening session stops after 15 minutes.
- [ ] Ask for a harmless task in another channel, such as a short explanation
  through Telegram. Confirm its completion summary appears in the Glasses inbox
  and produces an iPhone notification with the app backgrounded or terminated.
- [ ] Tap a summary notification and confirm it opens the correct assistant's
  Glasses inbox. Receiving a banner alone should not change the selected assistant.
- [ ] Disconnect the network during a harmless request, reconnect, and retry the
  saved request. Confirm the same request is recovered without repeating work.
  If it is marked uncertain, inspect the outcome before issuing a new request.
- [ ] Switch assistants if the account owns more than one. Confirm queued speech,
  inbox results, and retry requests stay associated with the original assistant.
- [ ] Sign out while listening and confirm listening stops. Sign back in and
  confirm shared chat and Glasses access work, including notification registration.
- [ ] Before a TestFlight release, switch the relay to production APNs and verify
  a push using the TestFlight build. Distribute the updated existing app once
  the native tests and device checks pass.

## Current audio limits

Listening must be started in the iPhone app. **“Hey Meta” remains Meta's wake
phrase**; this integration does not wake a terminated app from the glasses.
Spoken summaries are supported during an active session. Outside a session,
the app sends iPhone notifications; automatic spoken glasses announcements are
not guaranteed. Confirm locked-phone behavior on your exact glasses/iPhone pair.

This audio integration uses Bluetooth microphone/speaker routing and does not
need a Meta Device Access Toolkit binary. Camera/display access or a different
activation experience would be separate follow-up work. See
[Meta's wearable access FAQ](https://developers.meta.com/wearables/faq/).
