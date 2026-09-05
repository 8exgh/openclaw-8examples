import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function vault(hexKey) {
  if (!/^[a-f0-9]{64}$/i.test(hexKey ?? '')) throw new Error('SESSION_ENCRYPTION_KEY must be 32 random bytes in hex');
  const key = Buffer.from(hexKey, 'hex');
  return {
    seal(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    open(value) {
      const bytes = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

export function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(
    createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest(),
  );
}

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function mobileIdentity(baseURL, fetchImpl = fetch) {
  const base = new URL(baseURL);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('IDENTITY_URL must be HTTPS');
  return async (token) => {
    if (!/^mob_[a-f0-9]{64}$/.test(token ?? '')) throw httpError(401, 'Sign in again');
    const response = await fetchImpl(new URL('/api/mobile/queries/me', base), {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if ([401, 403].includes(response.status)) throw httpError(401, 'Sign in again');
    if (!response.ok) throw httpError(503, 'Account service unavailable');
    const data = await response.json();
    if (typeof data.username !== 'string' || !Array.isArray(data.claws) ||
        !data.claws.every((c) => typeof c.clawId === 'string' && /^[a-z0-9-]{1,64}$/.test(c.clawId))) {
      throw httpError(503, 'Invalid account response');
    }
    return { username: data.username, claws: data.claws };
  };
}
