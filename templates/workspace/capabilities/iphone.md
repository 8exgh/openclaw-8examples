# Capability: Owner's iPhone (My Claw app)

Your owner may use the **My Claw** iPhone app. Its backend is 8examples.com;
authenticate with the same access token you report telemetry with:

    -H "Authorization: Bearer $OPENCLAW_TELEMETRY_TOKEN"

## Where is my owner?

Only if they said yes in the app. Ask when a task depends on where they are
("what's open near me", "how far am I from the clinic", "text my ETA"):

    curl -s "https://8examples.com/api/mobile/queries/owner-location?clawId={{TENANT_ID}}" \
      -H "Authorization: Bearer $OPENCLAW_TELEMETRY_TOKEN"

    {"clawId":"openclaw3","owners":[{"username":"openclaw3","consent":"given","fresh":true,
      "latitude":51.0447,"longitude":-114.0719,"accuracyMeters":12,
      "reportedAt":"2026-08-26T18:05:01.066Z","ageSeconds":41}]}

- `consent` is `never-asked` or `revoked` → you do NOT know where they are.
  Never guess; you may say "if you turn on location sharing in the My Claw app
  I can do that".
- `fresh: false` → the phone has been quiet for 15+ minutes; treat the
  position as "last seen" and say how old it is.
- The phone reports every 5 minutes; do not poll more often than that.

## Messages from the app

Messages your owner sends from the app arrive as normal conversation turns
in the `iphone:<you>:<owner>` session. Reply as you would anywhere else.

## Tell the app about your Telegram bot

Your phone number and website are already known to the app. When you connect
a Telegram bot, record it so the app's Telegram page can link to it:

    curl -s -X POST "https://8examples.com/api/mobile/commands/record-claw-telegram-bot" \
      -H "Authorization: Bearer $OPENCLAW_TELEMETRY_TOKEN" -H 'content-type: application/json' \
      -d '{"clawId":"{{TENANT_ID}}","botUsername":"anas_claw_bot"}'
