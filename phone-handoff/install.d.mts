import type { Tenant } from '../src/types.js';
export const pluginId: string;
export function revision(): string;
export function privateOwner(tenant: Tenant, config: Record<string, any>): { channel: string; peer: string; accountId: string } | undefined;
export function installPhoneHandoff(dir: string, tenant: Tenant): { tenant: string; enabled: boolean; changed: boolean; revision: string; channel?: string; reason?: string };
