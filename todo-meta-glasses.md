# Meta glasses: remaining setup and verification

The implementation is in the existing iPhone app, with one new backend in
`openclaw-meta-glasses/`. The relay is live at **https://glasses.fusenv.com** with
verified daily backups and public HTTPS routing. Section 2 is complete.
Push credentials, the iOS build, and paired-glasses checks still need to be done.
Backend/fleet validation passed 30 tests, TypeScript checking, and backend syntax
checking on September 5, 2026; two additional backup tests now pass as well.

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

- [x] Choose `glasses.fusenv.com` as the public hostname. The fleet host uses
  Cloudflare Tunnel; its connector runs with host networking, so the relay
  origin is `http://127.0.0.1:8795`.
- [x] Pull the committed integration into `/home/openclaw/managed-openclaw` on
  the fleet host (`72.251.7.26`). Verified Node `v22.23.2`, Docker `29.1.3`, and
  access to the running `openclaw-openclaw1` from inside the relay container.
- [x] Generate the private relay configuration for `openclaw1`:

  ```bash
  cd /home/openclaw/managed-openclaw/openclaw-meta-glasses
  node integration/configure.mjs openclaw1
  mkdir -p data secrets
  ```

  This creates `.env` and `config.local.json`, preserving keys on later runs.
  Leave `IDENTITY_URL=https://8examples.com` for the existing production login.
- [x] Start the single relay service. `openclaw-meta-glasses-relay-1` is healthy,
  configured to restart automatically, and bound only to `127.0.0.1:8795`.
  Its local `/health` returns HTTP 200 with `{"ok":true}`.

  ```bash
  docker compose up -d --build
  docker compose ps
  curl --fail http://127.0.0.1:8795/health
  ```

- [x] Update the backend to patched Fastify `5.12.3` and fast-uri dependencies.
  All ten relay tests pass on the fleet host, and the installed dependencies
  report zero vulnerabilities in `npm audit`.
- [x] Install and verify daily private backups. `openclaw-glasses-backup.timer`
  runs at 03:30 fleet-host time with up to 15 minutes of jitter, retains 14 days,
  and catches up after downtime. Archives are in
  `/home/openclaw/openclaw-backups/meta-glasses` (root-owned, directory 0700,
  archives 0600). A production archive was restored to a temporary database
  and passed integrity and checksum checks. Archives contain `.env`,
  `config.local.json`, and a consistent SQLite snapshot. APNs keys will be
  included automatically once added to `secrets/` in step 3. Only one relay
  process uses the database. See the [operations runbook](openclaw-meta-glasses/deploy/README.md).
- [x] Publish and run the [Cloudflare workflow](https://github.com/8exgh/devops/actions/workflows/configure-openclaw-glasses-cloudflare.yml)
  in `8exgh/devops`. It uses that repository's existing DNS and tunnel secrets to
  add a proxied CNAME and ingress rule on tunnel
  `a96d6a4a-940c-47e2-bd82-479bbfc07884`, preserving all existing routes.
  [Successful DNS and HTTPS verification](https://github.com/8exgh/devops/actions/runs/33992007669).
- [x] Verify `https://glasses.fusenv.com/health` from outside the fleet host
  returns HTTP 200 and `/v1/me` rejects an unauthenticated request with HTTP 401.
  Both checks passed from a GitHub-hosted runner and from the relay's Node HTTP
  client. The deployment probe identifies itself as
  `OpenClaw-Glasses-Deployment/1.0`; Cloudflare rejects Python's default user-agent.
- [x] Publish the [manual backend deployment workflow](https://github.com/8exgh/devops/actions/workflows/deploy-openclaw-glasses.yml)
  in `8exgh/devops`, where the existing `openclaw-dc` fleet runner is registered.
  It deploys the glasses backend, validates it, and installs the backup timer.
  The workflow shares the existing fleet deployment lock.
  [Successful backend deployment and verification](https://github.com/8exgh/devops/actions/runs/33992009013).

Completed September 5, 2026. Use `https://glasses.fusenv.com` as the relay origin
in the remaining app and tenant setup steps. Push credentials and enabling the
tenant's glasses capability remain in sections 3 and 4.

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
  host, run:

  ```bash
  cd /home/openclaw/managed-openclaw/openclaw-meta-glasses
  node integration/connect-tenant.mjs \
    /home/openclaw/managed-openclaw/tenants/openclaw1 \
    https://glasses.fusenv.com
  cd ..
  npm ci
  npm run cli -- enable openclaw1 glasses
  ```

  The enable command installs the managed summary helper/instructions and
  restarts `openclaw1` with the two glasses environment variables.
- [ ] Build and install the updated existing app on the iPhone. Sign in with the
  existing 8examples account and select `openclaw1`.
- [ ] Open **Glasses → Connection settings**, enter `https://glasses.fusenv.com`,
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
