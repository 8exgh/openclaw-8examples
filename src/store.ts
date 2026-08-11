import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fleet, Tenant } from './types.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const TENANTS_DIR = path.join(ROOT, 'tenants');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');

const FLEET_FILE = path.join(DATA_DIR, 'fleet.json');
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');

const DEFAULT_FLEET: Fleet = {
  releaseChannel: 'latest',
  image: 'ghcr.io/openclaw/openclaw:latest-browser',
  nextPort: 19001,
};

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadFleet(): Fleet {
  return { ...DEFAULT_FLEET, ...readJson<Partial<Fleet>>(FLEET_FILE, {}) };
}

export function saveFleet(fleet: Fleet): void {
  writeJson(FLEET_FILE, fleet);
}

export function loadTenants(): Tenant[] {
  return readJson<Tenant[]>(TENANTS_FILE, []);
}

export function saveTenants(tenants: Tenant[]): void {
  writeJson(TENANTS_FILE, tenants);
}

export function getTenant(id: string): Tenant {
  const tenant = loadTenants().find((t) => t.id === id);
  if (!tenant) throw new Error(`Unknown tenant: ${id}`);
  return tenant;
}

export function upsertTenant(tenant: Tenant): void {
  const tenants = loadTenants();
  const i = tenants.findIndex((t) => t.id === tenant.id);
  if (i >= 0) tenants[i] = tenant;
  else tenants.push(tenant);
  saveTenants(tenants);
}

export function tenantDir(id: string): string {
  return path.join(TENANTS_DIR, id);
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'tenant';
  const taken = new Set(loadTenants().map((t) => t.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
