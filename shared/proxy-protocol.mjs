// One wire protocol for the Makers WebCrypto signer and the Node gateway.
// No Node imports: this module is copied unchanged into the Edge Function bundle.
export const PROXY_VERSION = '1';
export const PROXY_MAX_AGE_SECONDS = 120;
export const PROXY_MAX_FUTURE_SECONDS = 10;
export const PROXY_HEADER_PREFIX = 'x-hub-proxy-';
export const PROXY_HEADERS = Object.freeze({
  version: 'x-hub-proxy-version', keyId: 'x-hub-proxy-key-id', scope: 'x-hub-proxy-scope',
  timestamp: 'x-hub-proxy-timestamp', nonce: 'x-hub-proxy-nonce',
  clientIp: 'x-hub-proxy-client-ip', publicHost: 'x-hub-proxy-public-host',
  signature: 'x-hub-proxy-signature'
});
export const PROXY_APP_HEADERS = Object.freeze([
  'origin', 'user-agent', 'cookie', 'content-type',
  'access-control-request-method', 'access-control-request-headers'
]);
const encoder = new TextEncoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const limits = [512, 512, 8192, 128, 16, 256];

function reject(code = 'proxy_unauthorized', statusCode = 401) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode32(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) reject();
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), char => char.charCodeAt(0)); }
  catch { reject(); }
  if (bytes.length !== 32 || encodeBase64Url(bytes) !== value) reject();
  return bytes;
}

export function validProxyKey(key) {
  try { decode32(key); return true; } catch { return false; }
}

export function normalizeClientIp(value) {
  if (typeof value !== 'string' || !value || value.length > 45 || value !== value.trim()) return '';
  const parts = value.split('.');
  if (parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) return value;
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return '';
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : '';
  } catch { return ''; }
}

export function proxyRoutePolicy(scope, method, target) {
  if (typeof target !== 'string' || target.length > 4096 || !/^\/[\x21-\x7e]*$/.test(target) ||
      target.startsWith('//') || target.includes('\\') || target.includes('#')) return null;
  const separator = target.indexOf('?');
  const path = separator === -1 ? target : target.slice(0, separator);
  const hasQuery = separator !== -1;
  if (scope === 'collect' && path === '/api/collect' && !hasQuery && ['POST', 'OPTIONS'].includes(method)) {
    return { path, maxBodyBytes: method === 'POST' ? 12288 : 0 };
  }
  if (scope !== 'dashboard') return null;
  if (['/api/login', '/api/logout'].includes(path) && !hasQuery && method === 'POST') return { path, maxBodyBytes: 1024 };
  if (['/api/session', '/api/catalog'].includes(path) && !hasQuery && method === 'GET') return { path, maxBodyBytes: 0 };
  if (['/api/report', '/api/outbound/daily'].includes(path) && method === 'GET') return { path, maxBodyBytes: 0 };
  return null;
}

function publicHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || !/^[a-z0-9.-]+$/.test(value)) reject();
  try {
    const url = new URL(`https://${value}/`);
    if (url.host !== value || url.hostname !== value) reject();
  } catch { reject(); }
  return value;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]{9,11}$/.test(value)) reject();
  return value;
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function canonicalRequest(input) {
  const { keyId, scope, method, target, nonce } = input;
  if (!KEY_ID.test(keyId || '') || !UUID_V4.test(nonce || '')) reject();
  const policy = proxyRoutePolicy(scope, method, target);
  if (!policy) reject('proxy_route_not_allowed', 404);
  const body = input.body ?? new Uint8Array();
  if (!(body instanceof Uint8Array)) reject('invalid_proxy_body', 400);
  if (body.byteLength > policy.maxBodyBytes) reject('body_too_large', 413);
  const clientIp = normalizeClientIp(input.clientIp);
  if (!clientIp) reject('invalid_proxy_client_ip', 400);
  const host = publicHost(input.publicHost);
  const time = timestamp(input.timestamp);
  const headers = new Headers(input.headers);
  const values = PROXY_APP_HEADERS.map((name, index) => {
    const value = headers.get(name) || '';
    if (encoder.encode(value).byteLength > limits[index] || /[\u0000-\u001f\u007f]/.test(value)) reject('invalid_proxy_context', 400);
    return value;
  });
  const [origin, userAgent, cookie, contentType, preflightMethod, preflightHeaders] = values;
  if (scope === 'collect' && cookie) reject('invalid_proxy_context', 400);
  if (method === 'POST' && (policy.path !== '/api/logout' || body.byteLength > 0) &&
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) reject('json_required', 415);
  if (method !== 'OPTIONS' && (preflightMethod || preflightHeaders)) reject('invalid_preflight', 400);
  if (method === 'OPTIONS' && (preflightMethod !== 'POST' ||
      preflightHeaders.split(',').map(value => value.trim().toLowerCase()).filter(Boolean).some(value => value !== 'content-type'))) reject('invalid_preflight', 400);
  const bodyHash = await sha256Hex(body);
  // Fixed-order JSON array, UTF-8, no whitespace/newline suffix. Empty headers
  // are empty strings. The target and header values are never URL-decoded here.
  const canonical = JSON.stringify([
    'hub-proxy-v1', keyId, scope, time, nonce, method, target, bodyHash,
    clientIp, host, ...values
  ]);
  return { keyId, scope, timestamp: Number(time), nonce, method, target, path: policy.path,
    bodyHash, clientIp, publicHost: host, origin, userAgent, cookie, contentType, canonical };
}

export async function signProxyRequest(input) {
  const context = await canonicalRequest({ ...input,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000), nonce: input.nonce ?? randomNonce() });
  const key = await crypto.subtle.importKey('raw', decode32(input.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(context.canonical))));
  return new Headers(Object.entries({
    version: PROXY_VERSION, keyId: context.keyId, scope: context.scope, timestamp: String(context.timestamp),
    nonce: context.nonce, clientIp: context.clientIp, publicHost: context.publicHost, signature
  }).map(([name, value]) => [PROXY_HEADERS[name], value]));
}

// Cryptographic verification only. The gateway must additionally enforce its
// configured origins/hosts and atomically consume the nonce in durable storage.
export async function verifyProxyRequest({ method, target, body, headers: inputHeaders, keys, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const headers = new Headers(inputHeaders);
  if (headers.get(PROXY_HEADERS.version) !== PROXY_VERSION) reject();
  const fields = Object.fromEntries(Object.entries(PROXY_HEADERS).map(([name, header]) => [name, headers.get(header)]));
  const keyEntry = keys?.[fields.keyId];
  if (!keyEntry || keyEntry.scope !== fields.scope) reject();
  const context = await canonicalRequest({ ...fields, method, target, body, headers });
  if (context.clientIp !== fields.clientIp || !Number.isSafeInteger(nowSeconds) ||
      context.timestamp < nowSeconds - PROXY_MAX_AGE_SECONDS || context.timestamp > nowSeconds + PROXY_MAX_FUTURE_SECONDS) reject('proxy_expired');
  const signature = decode32(fields.signature);
  const key = await crypto.subtle.importKey('raw', decode32(keyEntry.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(context.canonical))) reject();
  return context;
}
