import { readFileSync } from 'node:fs';
import { browserStdioTransport } from '../remote-connect/transport.mjs';

const source = readFileSync(new URL('../remote-connect/browser-client.mjs', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('./dashboard-client.mjs', import.meta.url), 'utf8').replace("import { createBrowserClient } from '../remote-connect/browser-client.mjs';", '') + '\n' +
  readFileSync(new URL('./dashboard-bridge.mjs', import.meta.url), 'utf8').replace("import { createDashboardClient } from './dashboard-client.mjs';", '');

export function dashboardTransport(tenant) { return browserStdioTransport(tenant, source); }
