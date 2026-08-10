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

export interface Tenant {
  id: string;
  name: string;
  contact: { phone?: string; email?: string };
  /** Which messaging channel this person reaches their assistant on. */
  channel: ChannelId;
  /** Host port the tenant's gateway is published on (container always 18789). */
  gatewayPort: number;
  createdAt: string;
  capabilities: Partial<Record<CapabilityId, CapabilityState>>;
  nudgeLog: NudgeRecord[];
  applied?: AppliedRelease;
}

export interface Fleet {
  releaseChannel: 'latest' | 'stable';
  /** Image every tenant should run, e.g. ghcr.io/openclaw/openclaw:latest */
  image: string;
  /** Digest-pinned ref resolved at the last `update`, so the whole fleet runs the same build. */
  pinnedImageRef?: string;
  nextPort: number;
}
