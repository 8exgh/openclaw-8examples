import Fastify from 'fastify';
import { z } from 'zod';
import { isCapabilityId } from './capabilities/registry.js';
import { assignmentCounts, exitNodePool, tenantTag } from './egress.js';
import { offboardTenant, runNudgesAll, setCapability, signup, summarize, updateFleet } from './ops.js';
import { getTenant, loadFleet, loadTenants } from './store.js';

const SignupBody = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  channel: z.enum(['whatsapp', 'telegram', 'signal']).optional(),
  enable: z.array(z.string()).optional(),
});

export async function startServer(port: number): Promise<void> {
  const app = Fastify({ logger: true });
  const adminToken = process.env.MOC_ADMIN_TOKEN;

  app.addHook('onRequest', async (req, reply) => {
    if (adminToken && req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/fleet', async () => ({ fleet: loadFleet(), tenants: loadTenants().length }));

  app.get('/egress', async () => {
    const fleet = loadFleet();
    const counts = assignmentCounts(fleet, loadTenants());
    return {
      tenantTag: tenantTag(fleet),
      exitNodes: exitNodePool(fleet).map((n) => ({ ...n, assigned: counts.get(n.name) ?? 0 })),
    };
  });

  app.get('/tenants', async () => loadTenants().map(summarize));

  app.get('/tenants/:id', async (req) => {
    const { id } = req.params as { id: string };
    const tenant = getTenant(id);
    return { ...summarize(tenant), nudgeLog: tenant.nudgeLog, contact: tenant.contact };
  });

  app.post('/signup', async (req, reply) => {
    const body = SignupBody.parse(req.body);
    const enable = (body.enable ?? []).filter(isCapabilityId);
    const result = signup({ ...body, enable });
    return reply.code(201).send({
      tenant: summarize(result.tenant),
      missingEnv: result.missingEnv,
      started: result.started,
    });
  });

  app.post('/tenants/:id/capabilities/:capability', async (req) => {
    const { id, capability } = req.params as { id: string; capability: string };
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    if (!isCapabilityId(capability)) throw new Error(`Unknown capability: ${capability}`);
    const result = setCapability(id, capability, enabled);
    return { tenant: summarize(result.tenant), missingEnv: result.missingEnv, started: result.started };
  });

  app.post('/nudges/run', async () => runNudgesAll());

  app.post('/fleet/update', async (req) => {
    const { canary } = z.object({ canary: z.string().optional() }).parse(req.body ?? {});
    return updateFleet({ canary });
  });

  app.post('/tenants/:id/offboard', async (req) => {
    const { id } = req.params as { id: string };
    const { purge } = z.object({ purge: z.boolean().optional() }).parse(req.body ?? {});
    return offboardTenant(id, { purge });
  });

  await app.listen({ port, host: '127.0.0.1' });
}
