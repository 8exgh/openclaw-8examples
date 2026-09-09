# Phone conversation handoff

The `managed-phone-handoff` runtime plugin imports this tenant's completed phone
calls from the existing authenticated phone gateway. It polls every 30 seconds
and refreshes before owner replies. Recent calls from before installation become
reference context without replaying historical notifications.

New calls produce one private owner notice, then a delivery mirror through
OpenClaw's session transcript SDK. Before-prompt hooks attach pending calls,
recent references and verified outcomes even after chat resets or restarts.
Phone hooks can enrich the factual summary with the caller, requested action,
proposed date/time and timezone using `phone_handoff publish`.

`phone_handoff callback` records an attempt in SQLite before asking the gateway
to call. Repeated confirmations return that attempt. An uncertain network result
is never retried blindly; `reconcile` links it to a matching owned outbound call.
`complete` requires a recorded outcome and an ended callback with a response,
or an explicit explanation that no callback was needed. The agent must inspect
the transcript to determine whether the requested action actually succeeded.

Only the uniquely allowlisted private owner and the same agent's `hook:phone`
sessions can read the inbox. Callback and completion actions require the owner
conversation. Multiple pending calls require the owner to select a call, such
as replying to its notification. Callers' words never authorize an action.
Storage is scoped to the phone credential, gateway and owner route, preventing
an owner reassignment from inheriting another owner's inbox.

`renderTenant` installs a content-addressed plugin generation; the running
gateway reloads it through OpenClaw's normal configuration reload. Unpaired or
disabled chat channels only receive staged files until there is a verified
owner route. No arbitrary recent conversation is selected as the recipient.

Deploy using devops `deploy-claw-phone-handoff.yml`: run inventory, then canary
with the reviewed full source SHA, then fleet. Native verification uses isolated
state and synthetic Telegram, phone and model endpoints inside the installed
runtime. Production verification checks the loaded generation, gateway health
and recent authenticated history synchronization, exposing counts only.

Transport delivery with an uncertain acknowledgment is deliberately not resent;
the pending context still reaches the next owner reply. A confirmed notice whose
transcript mirror fails is mirrored later without sending the notice again.
To disable, remove this plugin's entry and load path from the tenant config;
keep its inbox for recovery. Existing phone gateway live-call hooks stay intact.
