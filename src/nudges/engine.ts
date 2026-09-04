import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, isCapabilityEnabled } from '../capabilities/registry.js';
import { tenantDir } from '../store.js';
import type { NudgeRecord, Tenant } from '../types.js';

/** Don't re-offer the same capability more often than this. */
const OFFER_COOLDOWN_MS = 72 * 60 * 60 * 1000;
/** At most one offer nudge per tenant per day — nudging must never feel like spam. */
const GLOBAL_OFFER_GAP_MS = 24 * 60 * 60 * 1000;
/** Deepen nudges rotate slowly. */
const DEEPEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function lastNudgeAt(tenant: Tenant, predicate: (n: NudgeRecord) => boolean): number {
  let last = 0;
  for (const n of tenant.nudgeLog) {
    if (predicate(n)) last = Math.max(last, Date.parse(n.createdAt));
  }
  return last;
}

/**
 * Decide the single best nudge for this tenant right now, or null if we should
 * stay quiet. Strategy: sell the next capability on the ladder first; when
 * everything relevant is on (or on cooldown), deepen usage of what they have.
 */
export function pickNudge(tenant: Tenant, now: Date = new Date()): NudgeRecord | null {
  const ts = now.getTime();

  if (ts - lastNudgeAt(tenant, (n) => n.kind === 'offer') >= GLOBAL_OFFER_GAP_MS) {
    const candidates = CAPABILITIES.filter(
      (c) =>
        c.offerNudges.length > 0 &&
        !isCapabilityEnabled(tenant, c.id) &&
        ts - lastNudgeAt(tenant, (n) => n.capability === c.id) >= OFFER_COOLDOWN_MS,
    ).sort((a, b) => a.priority - b.priority);

    const cap = candidates[0];
    if (cap) {
      const timesOffered = tenant.nudgeLog.filter(
        (n) => n.kind === 'offer' && n.capability === cap.id,
      ).length;
      const text = cap.offerNudges[timesOffered % cap.offerNudges.length];
      return {
        id: `offer:${cap.id}`,
        kind: 'offer',
        capability: cap.id,
        text,
        createdAt: now.toISOString(),
      };
    }
  }

  const deepenCandidates = CAPABILITIES.filter(
    (c) =>
      c.deepenNudges.length > 0 &&
      isCapabilityEnabled(tenant, c.id) &&
      ts - lastNudgeAt(tenant, (n) => n.kind === 'deepen' && n.capability === c.id) >=
        DEEPEN_COOLDOWN_MS,
  ).sort((a, b) => a.priority - b.priority);

  const cap = deepenCandidates[0];
  if (cap) {
    const timesDeepened = tenant.nudgeLog.filter(
      (n) => n.kind === 'deepen' && n.capability === cap.id,
    ).length;
    return {
      id: `deepen:${cap.id}`,
      kind: 'deepen',
      capability: cap.id,
      text: cap.deepenNudges[timesDeepened % cap.deepenNudges.length],
      createdAt: now.toISOString(),
    };
  }

  return null;
}

/**
 * Append the nudge to the tenant workspace where the agent's heartbeat picks
 * it up (see templates/workspace/HEARTBEAT.md). Append-only so we never
 * clobber the agent's own edits to the file.
 */
export function deliverToWorkspace(tenant: Tenant, nudge: NudgeRecord): void {
  const dir = path.join(tenantDir(tenant.id), 'workspace', 'nudges');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'PENDING.md');
  if (!existsSync(file)) {
    appendFileSync(
      file,
      '# Pending nudges\n\nDeliver at most one per day, conversationally. Move delivered lines to DELIVERED.md.\n\n',
    );
  }
  const date = nudge.createdAt.slice(0, 10);
  appendFileSync(file, `- [ ] (${date}, ${nudge.id}) ${nudge.text}\n`);
}
