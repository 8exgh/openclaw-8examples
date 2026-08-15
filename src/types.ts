import type { Resources } from './provisioner/resources.js';

export type CapabilityId =
  | 'email'
  | 'calendar'
  | 'sms'
  | 'phone'
  | 'webdev'
  | 'paperwork';

export type ChannelId = 'whatsapp' | 'telegram' | 'signal';

export interface CapabilityState {
  enabled: boolean;
  enabledAt?: string;
}

export type NudgeKind = 'offer' | 'deepen';

export interface NudgeRecord {
  /** e.g. "offer:email" or "deepen:calendar" */
  id: string;
  kind: NudgeKind;
  capability: CapabilityId;
  text: string;
  createdAt: string;
}

export interface AppliedRelease {
  imageRef: string;
  managedVersion: string;
  appliedAt: string;
}

export interface OpenAIAuth {
  /** Auth profile id, e.g. "openai-codex:default". */
  profileId: string;
  enabledAt: string;
}

export type Tier = 'container' | 'desktop';

export interface Tenant {
  id: string;
  name: string;
  contact: { phone?: string; email?: string };
  /** Which messaging channel this person reaches their assistant on. */
  channel: ChannelId;
  /** Host port the tenant's gateway is published on (container always 18789). */
  gatewayPort: number;
  /** Runtime substrate; absent means 'container'. */
  tier?: Tier;
  /** Operator override; omitted means derived from enabled capabilities. */
  resources?: Partial<Resources>;
  /** Telegram peers allowed to reach this bot (e.g. ["telegram:123"]); empty/absent = open to anyone. */
  telegramAllowFrom?: string[];
  createdAt: string;
  capabilities: Partial<Record<CapabilityId, CapabilityState>>;
  nudgeLog: NudgeRecord[];
  applied?: AppliedRelease;
  /** Set when the tenant is offboarded; excluded from rollouts and nudging. */
  offboardedAt?: string;
  /** ChatGPT / OpenAI Codex OAuth profile applied by the operator. */
  openaiAuth?: OpenAIAuth;
}

export interface Fleet {
  releaseChannel: 'latest' | 'stable';
  /** Image every tenant should run, e.g. ghcr.io/openclaw/openclaw:latest-browser */
  image: string;
  /** Digest-pinned ref resolved at the last `update`, so the whole fleet runs the same build. */
  pinnedImageRef?: string;
  /** What the fleet ran before the last update — the one-command rollback target. */
  previousImageRef?: string;
  nextPort: number;
  /** Ports reclaimed from offboarded tenants, reused before nextPort advances. */
  freePorts?: number[];
}
