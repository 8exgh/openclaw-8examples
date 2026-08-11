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
    env: [
      { key: 'OPENCLAW_GMAIL_CREDENTIALS', description: 'Path or JSON for the Gmail OAuth credentials used by the email integration' },
    ],
    configPatch: () => ({
      hooks: {
        enabled: true,
        mappings: [
          {
            match: { path: 'gmail' },
            action: 'agent',
            sessionKey: 'hook:gmail',
            sessionMode: 'persistent',
          },
        ],
      },
    }),
    workspaceDoc: `# Capability: Email

You have access to this person's email.

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
      { key: 'OPENCLAW_VOICE_PROVIDER_KEY', description: 'API key for the outbound voice provider (e.g. Twilio Voice / Vapi)' },
    ],
    // Same schema-safety rule as sms: no config until a real voice provider is wired.
    configPatch: () => ({}),
    workspaceDoc: `# Capability: Phone calls

You can place outbound calls on this person's behalf.

- Great for: booking appointments, checking on orders, support lines, restaurant reservations.
- Always agree the goal and any personal info you may share before dialing.
- After the call, report the outcome in two sentences: what happened, what's next.
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
    configPatch: () => ({
      agents: { defaults: { sandbox: { mode: 'all', scope: 'agent' } } },
    }),
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
