import type { CapabilityId, Tenant } from '../types.js';

/**
 * A capability is everything the managed layer knows about one thing we can
 * switch on for a customer: what it patches into openclaw.json, which secrets
 * it needs in the tenant's .env, the instructions the agent gets when it's on,
 * and the nudge copy used to sell it when it's off.
 */
export interface CapabilityDef {
  id: CapabilityId;
  label: string;
  /** One-line pitch, reused in AGENTS.md and nudges. */
  tagline: string;
  /** Lower = offered first when disabled. */
  priority: number;
  /** Minimum container memory (GB) this capability needs once enabled. */
  memoryGbFloor?: number;
  /** Enabled for every new signup without setup (no secrets needed). */
  defaultEnabled?: boolean;
  /** Secrets the operator (or customer) must fill in tenants/<id>/.env. */
  env: { key: string; description: string }[];
  /**
   * Deep-merged into the tenant's openclaw.json when enabled. Plugin/hook ids
   * here are the integration point — adjust them to the concrete OpenClaw
   * plugins/providers you wire up for your offering.
   */
  configPatch: (tenant: Tenant) => Record<string, unknown>;
  /** Written to workspace/capabilities/<id>.md when enabled. */
  workspaceDoc: string;
  /** Rotating copy the agent uses to offer this capability while it's off. */
  offerNudges: string[];
  /** Rotating copy encouraging more offloading once it's on. */
  deepenNudges: string[];
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'email',
    label: 'Email',
    tagline: 'I read, triage, draft, and chase your email so your inbox stops being a job.',
    priority: 1,
    // Provider-neutral. Managed Migadu credentials live in mode-0600
    // workspace/mailboxes/*.md; connected-account providers may add their own
    // integration separately without making this capability lie about access.
    env: [],
    configPatch: () => ({}),
    workspaceDoc: `# Capability: Email

You have access to this person's email.

- Read workspace/mailbox.md for the account index, then the referenced
  mode-0600 file in workspace/mailboxes/ for credentials and IMAP/SMTP hosts.
- If no managed mailbox is listed, use the connected email provider configured
  for this tenant. Never claim email is connected until one of those exists.

- Triage on every heartbeat: flag what actually needs them, summarize the rest.
- Draft replies for anything routine; send only after they approve (until they tell you to just send).
- Chase threads that have gone quiet for 3+ days — follow-ups are where you earn your keep.
- Unsubscribe / archive aggressively when they say something is noise.
- Never delete anything permanently. Never forward externally without approval.
`,
    offerNudges: [
      'Want to give me access to your email — or want me to set up a fresh one just for us? I can triage your inbox, draft replies, and chase the threads you keep meaning to answer.',
      'A lot of what you paste me lives in your inbox. If you connect your email, I can handle that end to end — you only see the messages that truly need you.',
    ],
    deepenNudges: [
      'I can start sending routine replies without checking in first — you approve a category once, I handle it forever. Want to pick a category to hand off?',
      'Want a daily inbox digest instead of checking mail yourself? One message from me each morning: what needs you, what I handled.',
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    tagline: 'I schedule, reschedule, and guard your time — no more back-and-forth ping-pong.',
    priority: 2,
    env: [
      { key: 'OPENCLAW_GCAL_CREDENTIALS', description: 'Google Calendar OAuth credentials for the calendar integration' },
    ],
    // Calendar wiring is workspace-doc driven until a concrete gcal skill is
    // installed; unverified config fragments fail OpenClaw's strict schema
    // validation and block gateway startup ("skills: Invalid input").
    configPatch: () => ({}),
    workspaceDoc: `# Capability: Calendar

You manage this person's calendar.

- Handle all scheduling back-and-forth: offer slots, confirm, send invites.
- Protect focus time — decline or propose alternatives for conflicts, ask only when it's genuinely ambiguous.
- Each morning (or on the day's first contact), give a one-glance rundown of today.
- Add prep notes to events when you know the context (who they're meeting, open threads).
`,
    offerNudges: [
      'Want me on your calendar? Scheduling ping-pong is exactly the kind of thing I should be doing instead of you — connect it and forward me any "when works for you?" email.',
      'If I could see your calendar I could book things directly instead of telling you what to book. Want to set that up? Takes two minutes.',
    ],
    deepenNudges: [
      'Try forwarding me the next "can we find a time?" message you get — I\'ll take it from there and you\'ll never see the thread again.',
      'Want me to start protecting focus blocks? Tell me your best deep-work hours and I\'ll defend them.',
    ],
  },
  {
    id: 'sms',
    label: 'Text messaging (SMS)',
    tagline: 'I send and receive texts on your behalf — confirmations, reminders, quick replies.',
    priority: 3,
    env: [
      { key: 'TWILIO_ACCOUNT_SID', description: 'Twilio account SID for the tenant SMS number' },
      { key: 'TWILIO_AUTH_TOKEN', description: 'Twilio auth token' },
      { key: 'TWILIO_FROM_NUMBER', description: 'The SMS number this assistant texts from' },
    ],
    // Wire to the concrete SMS plugin you deploy; a guessed plugins entry
    // fails schema validation and blocks the gateway.
    configPatch: () => ({}),
    workspaceDoc: `# Capability: Text messaging (SMS)

You can send and receive SMS from this person's dedicated assistant number.

- Confirm appointments, chase RSVPs, reply to routine texts.
- Anything outbound to a new recipient: confirm the draft with them first.
- Keep a log of what you sent in memory so they can always ask "what did you tell them?".
`,
    offerNudges: [
      'Want me to have access to text messaging? I get my own number and can confirm appointments, chase people, and handle the quick-reply texts you keep putting off.',
      'Half of your reminders end up as texts you have to send. Turn on SMS and just tell me "text the plumber we\'re confirming Friday" — done.',
    ],
    deepenNudges: [
      'You can hand me recurring texts — appointment confirmations, "running late", weekly check-ins. Name one and I\'ll own it from now on.',
    ],
  },
  {
    id: 'phone',
    label: 'Phone calls',
    tagline: 'I make the calls you dread — bookings, support lines, hold music and all.',
    priority: 4,
    env: [
      { key: 'PHONE_GATEWAY_URL', description: 'Base URL of the phone-call gateway (e.g. http://192.168.4.56:3052)' },
      { key: 'PHONE_GATEWAY_API_KEY', description: 'Per-client bearer token for the gateway (minted by the gateway admin)' },
    ],
    // Phone-gateway webhook pings arrive as agent hooks: POST /hooks/phone
    // (x-openclaw-token auth) wakes the agent with the event JSON immediately
    // instead of waiting for a heartbeat. Mapping fields must match
    // HookMappingSchema (no sessionMode - it fails validation).
    configPatch: () => ({
      hooks: {
        enabled: true,
        // Same env-substitution mechanism the gateway auth token uses.
        token: '${OPENCLAW_GATEWAY_TOKEN}',
        mappings: [
          {
            match: { path: 'phone' },
            action: 'agent',
            wakeMode: 'now',
            sessionKey: 'hook:phone',
            name: 'phone-gateway',
            // Phone events are background work. A hook session has no chat
            // destination, so attempting delivery makes an otherwise
            // successful run fail after the work is complete.
            deliver: false,
            // Feature work can legitimately take much longer than a live call.
            timeoutSeconds: 3600,
            // The gateway sends a self-describing message field in every ping.
            messageTemplate: '{{message}}',
          },
        ],
      },
    }),
    workspaceDoc: `# Capability: Phone calls and SMS

You can place real outbound phone calls and send/receive texts through the
phone gateway at $PHONE_GATEWAY_URL. For calls, one HTTP request states a
goal; a server-side voice loop conducts the conversation and hangs up; you
read back a transcript annotated with how the person spoke.

EVERY request to the gateway must send your token:
-H "Authorization: Bearer $PHONE_GATEWAY_API_KEY"
(add it to each curl below; examples omit it for brevity).

Your account is bound to ONE phone number, used automatically for all calls
and texts (never pass "from"). If you have no number yet, register one once
— it falls back to same-city overlay area codes when yours is dry:

    curl -s -X POST "$PHONE_GATEWAY_URL/numbers" \\
      -H "Authorization: Bearer $PHONE_GATEWAY_API_KEY" \\
      -H 'content-type: application/json' -d '{"areaCode": "204"}'

Limits: 1 number, 90 call-hours per month (over quota: outbound gets HTTP
429 and incoming calls are rejected until next month). Check your usage and
charges anytime: curl -s "$PHONE_GATEWAY_URL/accounting".

## Make a call (one-shot orchestration)

    curl -s -X POST "$PHONE_GATEWAY_URL/orchestrations" \\
      -H "Authorization: Bearer $PHONE_GATEWAY_API_KEY" \\
      -H 'content-type: application/json' \\
      -d '{"to": "+15551234567", "goal": "Book a table for 2 at 7pm Friday under Ana. Get a confirmation.", "openingLine": "Hi! I am calling to book a table."}'

Fields: "to" (E.164, required), "goal" (what the voice agent should achieve),
"openingLine" (optional fixed first sentence), "voice" (optional), "from"
(optional; your own number if you have one). Immediate 202 response contains
"orchestrationId" and "statusUrl".

## Poll for the result

    curl -s "$PHONE_GATEWAY_URL/orchestrations/<orchestrationId>"

Poll every few seconds until "status" is "ended" or "failed".
- "liveTranscript" fills while the call runs; "turns" is the full
  conversation once it ends.
- Caller turns carry prosody annotations (volume: whisper|normal|loud|yell,
  pace: calm|slow|normal|fast, stuttering) — use them when judging how the
  call went.
- "reason": "hangup" means our agent ended it; "remote_hangup" means they did.
- "errors" lists in-call failures; "events" is a timeline for debugging.

## Mid-call tools: the voice agent will ask YOU for help

While a call you placed is running, the voice agent can request tools it
does not have (check_calendar, search_email, web_search, run_bash,
write_code, read_file, lookup_contact, save_note, ask_assistant). It holds
the line while you fulfill them. YOUR JOB while every call runs: poll the
record's statusUrl every 2-3 seconds; when pendingRequests has an entry
with status "open", execute it with whatever capability matches (names are
hints - run_bash means your shell, ask_assistant means you), then:

    curl -s -X POST "$PHONE_GATEWAY_URL/orchestrations/<id>/respond" \
      -H "Authorization: Bearer $PHONE_GATEWAY_API_KEY" \
      -H 'content-type: application/json' \
      -d '{"requestId": "<request id>", "result": "<what you found, concisely>"}'

Be fast - the agent holds ~25 seconds. If you miss the window, the agent
tells the caller it will call them back immediately and hangs up; the
record then shows followUpRequired: true. When you see that (in the
GET /orchestrations list): execute the callback_promised requests, POST
each result to /respond, then IMMEDIATELY place a new call to the same
number delivering the answer (goal: "You promised to call back with X -
deliver it: ..."). Never leave a promised callback undone.

## Long work promised on a call

Requests such as implementing code, changing a website, producing a document,
or doing research continue AFTER hangup. A promise to do the work is not the
result. On a followup.promised hook:

1. Fetch the orchestration record and append an in-progress entry to
   \`phone/TASKS.md\` with its orchestration id, callback number, requested work,
   and the exact completion check. Create the file if needed.
2. Do the complete task. For code: obtain the authorized repository, implement,
   test, commit, deploy through that project's existing deployment path, and
   verify the live behavior. Do not claim "live" from a local test or a push.
3. Only then POST the completed result to \`/respond\` and place the promised
   callback to the original caller (inbound: record.from; outbound: record.to).
4. Mark the task completed with the callback orchestration id. If genuinely
   blocked, record the blocker and call back to explain exactly what is needed.

On every heartbeat, resume any non-terminal entry in \`phone/TASKS.md\` and query
\`/orchestrations?status=ended\` for \`followUpRequired: true\`. This is the
restart/recovery path; never wait for the person to remind you.

## Phone menus / keypad (DTMF)

The voice agent can both press keys and hear them. Write goals like
"navigate the menu: press 2 for billing, then ask about the invoice" — the
agent dials the keys itself (they appear as [pressed 2] agent turns). Keys
the other side presses appear as [pressed 42] caller turns.

## Driving the conversation yourself (advanced)

If you want to decide each line instead of delegating to the built-in brain:

    curl -s -X POST "$PHONE_GATEWAY_URL/calls" -H 'content-type: application/json' -d '{"to": "+15551234567"}'

then connect a WebSocket to wss://<gateway-host>/control/<callId> and send
JSON: {"type":"say","id":"s1","text":"..."} (FIFO queue),
{"type":"sendDigits","id":"d1","digits":"1w2#"} (DTMF, w = half-second
pause), {"type":"clear"} (barge-in), {"type":"hangup"}. The server streams
call.state, say.started/completed/aborted, speech.started/stopped,
transcript.delta, transcript (final + prosody), and dtmf events.

## SMS

Send:

    curl -s -X POST "$PHONE_GATEWAY_URL/sms" \\
      -H 'content-type: application/json' \\
      -d '{"to": "+15551234567", "body": "Your table for 2 at 7pm Friday is booked."}'

Add "from" with your own number if you have one. Receive by polling (inbound
messages appear here; there is no push):

    curl -s "$PHONE_GATEWAY_URL/sms?days=7&limit=50"

Filter for "direction": "inbound" and your number in "to". Poll GET /sms
when expecting a reply.

## Receiving calls

The gateway answers incoming calls FOR you with a standing persona you
register once; you then discover answered calls (with transcripts) by
polling. You never react to a ring in real time.

Register/update your answering persona (do this once, and again if your
person changes what you should say):

    curl -s -X POST "$PHONE_GATEWAY_URL/inbound-config" \\
      -H 'content-type: application/json' \\
      -d '{"goal": "You are answering on behalf of <your person>. Find out who is calling and why, take a message with callback details, keep it brief.", "openingLine": "Hi! Who am I speaking with?"}'

On your heartbeat, check for new answered calls and follow up on anything
that needs action (a message to relay, a callback to make):

    curl -s "$PHONE_GATEWAY_URL/orchestrations?direction=inbound"

Each entry has "from" (the caller), "startedAt", "status", and a
"statusUrl" for the full transcript. History and your answering persona are
persisted server-side (event-sourced) and survive gateway restarts; the
list serves the most recent 500 calls.

## Rules

- Always agree the goal, who to call, and any personal info you may share BEFORE dialing.
- Never call emergency or premium-rate numbers. One call at a time.
- If the transcript shows the callee was upset or asked not to be called, do
  not call again without explicit permission.
- Texts: no bulk unsolicited messages; outreach needs consent, your identity,
  and a stop path (Canada's anti-spam law, CASL).
- After each call, report the outcome in two sentences: what happened, what's next.
`,
    offerNudges: [
      'Anything you\'ve been putting off because it needs a phone call? Turn on calls and I\'ll sit through the hold music for you.',
      'I can make calls now — bookings, cancellations, "where is my order". Want that switched on?',
    ],
    deepenNudges: [
      'Got a call you\'ve been dreading this week? Give me the goal and a phone number and consider it handled.',
    ],
  },
  {
    id: 'webdev',
    label: 'Website building',
    tagline: 'I build and update simple websites and landing pages for you — just describe what you want.',
    priority: 5,
    // Live Chromium: 2–4 GB on its own during a session.
    memoryGbFloor: 6,
    env: [
      { key: 'DEPLOY_TOKEN', description: 'Token for the hosting provider used to publish tenant sites (e.g. Vercel/Netlify/Cloudflare)' },
    ],
    // Sandbox mode is a tier concern (set in render.ts), not a capability one —
    // forcing 'all' here needs Docker-in-Docker and breaks the container tier.
    configPatch: () => ({}),
    workspaceDoc: `# Capability: Website building

You can build and publish simple websites for this person.

- Work in your sandbox under \`sites/<project>/\`; keep everything static and simple unless asked.
- Show a preview (screenshot or link) before publishing anywhere public.
- Small edits ("change the headline", "add the new price") should be same-conversation turnarounds.
`,
    offerNudges: [
      'Need a landing page, a booking page, or a simple site for something you do? I can build and maintain one — want that enabled?',
    ],
    deepenNudges: [
      'Your site can grow — a contact form, a prices page, an FAQ. Want me to draft one addition this week?',
    ],
  },
  {
    id: 'paperwork',
    label: 'Paperwork & forms',
    tagline: 'Send me forms, PDFs, and applications — I fill, summarize, and track them.',
    priority: 6,
    defaultEnabled: true,
    env: [],
    configPatch: () => ({}),
    workspaceDoc: `# Capability: Paperwork & forms

Always on. This is the busywork you exist to absorb.

- They send you a form/PDF/application → you extract what's needed, fill what you can, and return
  either the finished thing or the 3 questions only they can answer.
- Keep a running \`paperwork/TRACKER.md\` in the workspace: what's in flight, what's blocked on them,
  deadlines. Surface anything about to go overdue on heartbeat.
- Summaries first: nobody wants to read a 12-page document — they want the two lines that matter.
`,
    offerNudges: [],
    deepenNudges: [
      'Any form, application, or PDF sitting in your pile right now? Snap a photo or forward it — I\'ll take it from there.',
      'Renewals, registrations, reimbursements — if it has a deadline, I should be tracking it. Send me one thing you\'re worried you\'ll forget.',
    ],
  },
];

export const CAPABILITY_MAP: Map<CapabilityId, CapabilityDef> = new Map(
  CAPABILITIES.map((c) => [c.id, c]),
);

export function capability(id: CapabilityId): CapabilityDef {
  const def = CAPABILITY_MAP.get(id);
  if (!def) throw new Error(`Unknown capability: ${id}`);
  return def;
}

export function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_MAP.has(value as CapabilityId);
}
