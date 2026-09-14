export function reconcile(base: unknown, current: unknown, desired: unknown, location?: string): unknown;
export function updateConfig(dir: string, name: string, build: (current: Record<string, any>) => Record<string, any>, options?: { adoptExisting?: boolean }): Record<string, any>;
export function updateText(dir: string, name: string, file: string, desired: string | null): void;
export function updateBlock(dir: string, name: string, file: string, desired: string): void;
export function updateAgentBody(dir: string, desired: string): void;
export function assertOwnerIdle(dir: string): void;
export function assertSafePath(file: string): void;
