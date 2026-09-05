import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

export function apnsPayload(item) {
  return { aps: { alert: { title: 'OpenClaw', body: item.summary }, sound: 'default',
    'thread-id': item.claw_id }, clawId: item.claw_id, eventSeq: item.event_seq };
}

export function createAPNs({ teamId, keyId, privateKey, topic, environment, connectImpl = connect }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? '') || !/^[A-Z0-9]{10}$/.test(keyId ?? '') ||
      !/^[a-zA-Z0-9.-]+$/.test(topic ?? '') || !['sandbox', 'production'].includes(environment)) {
    throw new Error('Configure APNS_TEAM_ID, APNS_KEY_ID, APNS_TOPIC, and APNS_ENVIRONMENT');
  }
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires a P-256 signing key');
  let cached;
  function token() {
    const now = Math.floor(Date.now() / 1000);
    if (cached && now - cached.at < 3000) return cached.value;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString('base64url');
    const message = `${header}.${payload}`;
    const signature = sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { at: now, value: `${message}.${signature}` };
    return cached.value;
  }
  const origin = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  return (item) => new Promise((resolve, reject) => {
    const session = connectImpl(origin);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      session.destroy();
      error ? reject(error) : resolve();
    }
    session.on('error', () => finish(new Error('APNs connection failed')));
    session.setTimeout(15_000, () => finish(new Error('APNs timeout')));
    const req = session.request({ ':method': 'POST', ':path': `/3/device/${item.token}`,
      authorization: `bearer ${token()}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-id': item.apns_id, 'apns-collapse-id': `glasses-${item.event_seq}`,
      'apns-expiration': String(Math.floor(item.created_at / 1000) + 86400), 'content-type': 'application/json' });
    let status = 0, body = '';
    req.on('response', (headers) => { status = Number(headers[':status']); });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
    req.on('error', () => finish(new Error('APNs request failed')));
    req.on('end', () => {
      if (status === 200) return finish();
      let reason;
      try { reason = JSON.parse(body).reason; } catch { /* No response body. */ }
      finish(Object.assign(new Error(`APNs rejected notification (${status})`), {
        invalidDevice: status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic',
      }));
    });
    req.end(JSON.stringify(apnsPayload(item)));
  });
}
