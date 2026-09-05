import Fastify from 'fastify';
import { httpError, sameSecret } from './security.mjs';

const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };
const claw = { type: 'string', pattern: '^[a-z0-9-]{1,64}$' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export function createApp({ store, authenticate, vault, publishers = {}, pushEnabled = false }) {
  const app = Fastify({ bodyLimit: 24_000, logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.code(status).send({ error: status >= 500 ? 'Service unavailable; try again shortly' : error.message });
  });
  async function owner(req) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const user = await authenticate(token);
    return { ...user, token };
  }
  function owns(user, clawId) {
    if (!user.claws.some((c) => c.clawId === clawId)) throw httpError(403, 'This OpenClaw is not on your account');
  }
  app.get('/health', async () => ({ ok: true }));
  app.get('/v1/me', async (req) => {
    const { token: _token, ...user } = await owner(req);
    return { ...user, pushEnabled };
  });
  app.post('/v1/requests', { schema: { body: object({ requestId: id, clawId: claw, text: { type: 'string', minLength: 1, maxLength: 8000 } }) } }, async (req, reply) => {
    const user = await owner(req);
    owns(user, req.body.clawId);
    if (!req.body.text.trim()) throw httpError(400, 'Say or type a request');
    const result = store.enqueue({ id: req.body.requestId, username: user.username, clawId: req.body.clawId,
      text: req.body.text.trim(), credential: vault.seal(user.token) });
    return reply.code(202).send(result);
  });
  app.get('/v1/events', { schema: { querystring: object({ clawId: claw, after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, ['clawId']) } }, async (req) => {
    const user = await owner(req);
    owns(user, req.query.clawId);
    return store.events(user.username, req.query.clawId, req.query.after);
  });
  app.post('/v1/devices', { schema: { body: object({ installationId: id, deviceToken: { type: 'string', pattern: '^[a-f0-9]{32,512}$' } }) } }, async (req) => {
    const user = await owner(req);
    if (!pushEnabled) throw httpError(503, 'Push notifications have not been configured');
    store.registerDevice({ id: req.body.installationId, username: user.username, token: req.body.deviceToken,
      credential: vault.seal(user.token) });
    return { ok: true };
  });
  app.delete('/v1/devices/:id', { schema: { params: object({ id }) } }, async (req) => {
    const user = await owner(req);
    store.removeSessionDevice(req.params.id, user.username, user.token, vault);
    return { ok: true };
  });
  app.post('/v1/summaries', { schema: { body: object({ actionId: id, clawId: claw,
    summary: { type: 'string', minLength: 1, maxLength: 400 }, detail: { type: 'string', maxLength: 8000 } }, ['actionId', 'clawId', 'summary']) } }, async (req, reply) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!sameSecret(token, publishers[req.body.clawId])) throw httpError(401, 'Invalid publisher credential');
    if (!req.body.summary.trim()) throw httpError(400, 'Summary cannot be empty');
    const event = store.transaction(() => store.append({ eventId: `summary:${req.body.clawId}:${req.body.actionId}`,
      clawId: req.body.clawId, kind: 'completed', summary: req.body.summary.trim(), text: req.body.detail || req.body.summary.trim() }));
    return reply.code(201).send({ eventId: event.event_id, seq: event.seq });
  });
  return app;
}
