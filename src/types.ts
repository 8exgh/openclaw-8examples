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

export interface ExitNode {
  /** Tailscale machine name (e.g. "server2") — used verbatim as --exit-node. */
  name: string;
  /** Expected public egress IP; `egress check` flags drift when set. */
  expectedIp?: string;
  /** Operator note: where the box lives / whose ISP it rides. */
  location?: string;
}

export interface FleetEgress {
  /** Residential exit nodes desktop-tier tenant VMs are sharded across. */
  exitNodes: ExitNode[];
  /** Tailnet tag tenant VMs advertise; the ACL must let it use exit nodes. */
  tenantTag?: string;
}

export interface TenantEgress {
  /** Exit-node name (from the fleet pool) this tenant's VM egresses through. */
  exitNode: string;
  assignedAt: string;
}

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
  /** Interactive agent-run limit. Omitted uses OpenClaw's default (600 seconds). */
  agentTimeoutSeconds?: number;
  /** Telegram peers allowed to reach this bot (e.g. ["telegram:123"]); empty/absent = open to anyone. */
  telegramAllowFrom?: string[];
  createdAt: string;
  /** Per-tenant release pin (e.g. canarying a major upgrade); overrides the fleet pin until cleared. */
  pinnedImageRef?: string;
  /**
   * Route this tenant's Anthropic-protocol model calls through the shared
   * model-gateway (github.com/8exgh/model-gateway) at this URL, e.g.
   * http://model-gateway:8790 on the openclaw-model-gateway docker network.
   * The cutover only takes effect once the tenant's .env holds a real
   * MODEL_GATEWAY_KEY (minted on the gateway box); until then the render
   * keeps the direct provider wiring so a half-configured tenant never
   * loses its models.
   */
  modelGatewayUrl?: string;
  /** Provider credentials are available only after 8examples assigns this inventory slot. */
  modelAccess?: 'assigned' | 'suppressed';
  capabilities: Partial<Record<CapabilityId, CapabilityState>>;
  nudgeLog: NudgeRecord[];
  applied?: AppliedRelease;
  /** Set when the tenant is offboarded; excluded from rollouts and nudging. */
  offboardedAt?: string;
  /** Residential egress assignment (desktop tier; consumed by the VM seed). */
  egress?: TenantEgress;
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
  /**
   * Fleet-wide model-gateway URL. When set, new tenants inherit it at signup
   * (so the whole fleet is gateway-routed by default); existing tenants adopt
   * it on the next `model-gateway <tenant> --fleet` or a fleet backfill.
   */
  modelGatewayUrl?: string;
  nextPort: number;
  /** Ports reclaimed from offboarded tenants, reused before nextPort advances. */
  freePorts?: number[];
  /** Residential exit-node pool + tailnet settings for tenant VM egress. */
  egress?: FleetEgress;
}
