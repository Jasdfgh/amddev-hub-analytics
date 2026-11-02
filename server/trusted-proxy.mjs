import { createHash } from 'node:crypto';
import {
  PROXY_HEADERS, PROXY_HEADER_PREFIX, PROXY_APP_HEADERS, PROXY_MAX_AGE_SECONDS,
  proxyRoutePolicy, verifyProxyRequest
} from '../shared/proxy-protocol.mjs';

export const PROXY_NONCE_OWNER_PREFIX = 'proxy-nonce:v1:';
export const PROXY_NONCE_IDENTITY = 'proxy-nonce:v1';

function fail(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode; error.code = code;
  throw error;
}

// UUIDv8, domain-separated from browser event UUIDv4 and from other key IDs.
// Only this hash is used as the receipt key; the raw nonce is never an event ID.
export function proxyNonceId(keyId, nonce) {
  const bytes = createHash('sha256').update('hub-proxy-nonce:v1\0').update(keyId).update('\0').update(nonce).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function signedHeaders(request) {
  const names = new Set([...Object.values(PROXY_HEADERS), ...PROXY_APP_HEADERS]);
  const seen = new Set();
  for (let index = 0; index < (request.rawHeaders?.length || 0); index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    if (name.startsWith(PROXY_HEADER_PREFIX) && !names.has(name)) fail(401, 'proxy_unauthorized');
    if (!names.has(name)) continue;
    if (seen.has(name)) fail(401, 'proxy_unauthorized');
    seen.add(name);
  }
  const headers = new Headers();
  for (const name of names) {
    const value = request.headers[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') fail(401, 'proxy_unauthorized');
    headers.set(name, value);
  }
  for (const name of Object.values(PROXY_HEADERS)) if (!headers.get(name)) fail(401, 'proxy_unauthorized');
  return headers;
}

async function rawBody(request, limit) {
  const length = request.headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length))) fail(400, 'invalid_body_length');
  if (length !== undefined && Number(length) > limit) fail(413, 'body_too_large');
  if (request.headers['content-encoding']) fail(415, 'unsupported_content_encoding');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { request.resume(); fail(413, 'body_too_large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * All routes except exact GET /healthz require this verifier in hmac-v1 mode.
 * Replay protection is durable: receipt reserve uses a PostgreSQL unique key.
 * The local cleanup clock is only an optimization, never a replay authority.
 */
export function createTrustedProxy({ config, receipts, now = () => Date.now() }) {
  if (config.proxy?.mode !== 'hmac-v1') throw new Error('Trusted proxy verifier requires hmac-v1 configuration.');
  let lastCleanup = -Infinity;
  let requestsSinceCleanup = 0;
  return {
    async authenticate(request) {
      const headers = signedHeaders(request);
      const policy = proxyRoutePolicy(headers.get(PROXY_HEADERS.scope), request.method, request.url);
      if (!policy) fail(404, 'proxy_route_not_allowed');
      const body = await rawBody(request, policy.maxBodyBytes);
      const current = now();
      const context = await verifyProxyRequest({ method: request.method, target: request.url, body, headers,
        keys: config.proxy.keys, nowSeconds: Math.floor(current / 1000) });
      if (context.scope === 'collect') {
        if (context.publicHost !== config.proxy.hubHost) fail(421, 'host_not_allowed');
        if (context.origin !== config.proxy.hubOrigin || !config.allowedOrigins.has(context.origin)) fail(403, 'origin_not_allowed');
        if (request.method === 'POST' && !context.userAgent) fail(400, 'missing_client_context');
      } else {
        if (context.publicHost !== config.proxy.viewerHost) fail(421, 'host_not_allowed');
        if (context.origin && context.origin !== config.publicOrigin || request.method === 'POST' && context.origin !== config.publicOrigin) fail(403, 'origin_not_allowed');
      }
      // Bounded, awaited, nonce-only cleanup: no timer or response-after work.
      // Cleanup failure cannot bypass the mandatory durable reservation below.
      requestsSinceCleanup++;
      if (requestsSinceCleanup >= 20 || current - lastCleanup >= 60000) {
        lastCleanup = current;
        requestsSinceCleanup = 0;
        try { await receipts.pruneProxyNonces(50); } catch { /* Reservation remains fail-closed. */ }
      }
      try {
        const reserved = await receipts.reserve({
          eventId: proxyNonceId(context.keyId, context.nonce),
          ownerHash: PROXY_NONCE_OWNER_PREFIX + context.keyId,
          payloadHash: createHash('sha256').update(context.canonical).digest('hex'),
          identityId: PROXY_NONCE_IDENTITY,
          expiresAt: new Date((context.timestamp + PROXY_MAX_AGE_SECONDS + 1) * 1000).toISOString()
        });
        if (!reserved.created) fail(409, 'proxy_replay');
      } catch (error) {
        if (error.code === 'proxy_replay' || error.code === 'receipt_conflict') fail(409, 'proxy_replay');
        if (error.code === 'receipt_expired') fail(401, 'proxy_expired');
        fail(503, 'proxy_replay_unavailable');
      }
      return { ...context, body, client: { ip: context.clientIp, userAgent: context.userAgent } };
    }
  };
}
