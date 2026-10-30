import { createHash, createHmac, createSecretKey, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const SCRYPT = Object.freeze({ N:32768, r:8, p:1, maxmem:64 * 1024 * 1024 });
const COOKIE_NAME = 'hub_viewer';
const SIGNING_CONTEXT = 'hub-viewer-session:v1.';
const DEFAULT_TTL = 8 * 60 * 60 * 1000;
const MAX_TTL = 30 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 60_000;
const CLIENT_ATTEMPTS = 8;
const GLOBAL_ATTEMPTS = 60;
const MAX_CONCURRENT_HASHES = 2;
const MAX_CLIENTS = 2048;
const MAX_SESSIONS = 2048;
const MAX_PASSWORD_BYTES = 256;
const MAX_COOKIE_HEADER_BYTES = 8192;

function validPassword(password) {
  return typeof password === 'string' && password.length > 0 &&
    password.length <= MAX_PASSWORD_BYTES && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
}

function decodeBase64Url(value, minBytes, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString('base64url') !== value) return null;
  return bytes;
}

function parsePasswordHash(encoded) {
  const invalid = () => new TypeError('passwordHash must use a valid scrypt:v1 salt and 32-byte digest.');
  if (typeof encoded !== 'string' || encoded.length > 512) throw invalid();
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== 'v1') throw invalid();
  const salt = decodeBase64Url(parts[2], 16, 64);
  const expected = decodeBase64Url(parts[3], 32, 32);
  if (!salt || !expected) throw invalid();
  return { salt, expected };
}

function unauthorized() {
  const error = new Error('Invalid viewer credentials.');
  error.name = 'ViewerAuthError';
  error.statusCode = 401;
  error.code = 'invalid_credentials';
  return error;
}

function limited(milliseconds = 1000) {
  const error = new Error('Too many login attempts. Try again later.');
  error.name = 'ViewerAuthError';
  error.statusCode = 429;
  error.code = 'rate_limited';
  error.retryAfterSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return error;
}

/** Offline initialization helper. Never expose this as a public HTTP endpoint. */
export async function hashViewerPassword(password) {
  if (!validPassword(password)) throw new TypeError('Password must be a non-empty string of at most 256 UTF-8 bytes.');
  const salt = randomBytes(16);
  const input = Buffer.from(password, 'utf8');
  let result;
  try {
    result = await derive(input, salt, 32, SCRYPT);
    return 'scrypt:v1:' + salt.toString('base64url') + ':' + result.toString('base64url');
  } finally {
    input.fill(0);
    result?.fill(0);
  }
}

/**
 * One process-local viewer authority. Restarts intentionally invalidate old
 * sessions. Pass a trusted server-derived clientKey, not a request-body value.
 */
export function createViewerAuth({
  passwordHash,
  sessionSecret,
  secureCookie = true,
  username = 'hub-viewer',
  ttlMs = DEFAULT_TTL
} = {}) {
  const { salt, expected } = parsePasswordHash(passwordHash);
  if (typeof sessionSecret !== 'string' && !Buffer.isBuffer(sessionSecret)) {
    throw new TypeError('sessionSecret must contain at least 32 bytes.');
  }
  const secretLength = Buffer.isBuffer(sessionSecret) ? sessionSecret.length : Buffer.byteLength(sessionSecret, 'utf8');
  if (secretLength < 32 || secretLength > 4096) throw new TypeError('sessionSecret must contain between 32 and 4096 bytes.');
  if (typeof secureCookie !== 'boolean') throw new TypeError('secureCookie must be a boolean.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL) throw new TypeError('ttlMs must be a positive integer no greater than 30 days.');
  if (typeof username !== 'string' || !username || username !== username.trim() ||
    Buffer.byteLength(username, 'utf8') > 128 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new TypeError('username must be a non-empty display identifier without control characters.');
  }

  const secretCopy = Buffer.from(sessionSecret);
  const key = createSecretKey(secretCopy);
  secretCopy.fill(0);
  const sessions = new Map();
  const clients = new Map();
  const globalAttempts = [];
  let activeHashes = 0;
  let generation = 0;

  function prune(now) {
    const expiredBefore = now - WINDOW_MS;
    while (globalAttempts.length && globalAttempts[0] <= expiredBefore) globalAttempts.shift();
    for (const [id, attempts] of clients) {
      while (attempts.length && attempts[0] <= expiredBefore) attempts.shift();
      if (!attempts.length) clients.delete(id);
    }
    for (const [id, record] of sessions) if (record.exp <= now) sessions.delete(id);
  }

  function clientIdentity(clientKey) {
    const normalized = typeof clientKey === 'string' && clientKey.length > 0 &&
      clientKey.length <= 256 && Buffer.byteLength(clientKey, 'utf8') <= 256 ? clientKey : 'unknown';
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  function reserveAttempt(clientKey, now) {
    prune(now);
    const id = clientIdentity(clientKey);
    const attempts = clients.get(id);
    if (attempts?.length >= CLIENT_ATTEMPTS) throw limited(attempts[0] + WINDOW_MS - now);
    if (globalAttempts.length >= GLOBAL_ATTEMPTS) throw limited(globalAttempts[0] + WINDOW_MS - now);
    if (!attempts && clients.size >= MAX_CLIENTS) throw limited(WINDOW_MS);
    if (activeHashes >= MAX_CONCURRENT_HASHES) throw limited(1000);
    if (sessions.size >= MAX_SESSIONS) throw limited(Math.min(...[...sessions.values()].map(record => record.exp)) - now);
    const bucket = attempts || [];
    bucket.push(now);
    clients.set(id, bucket);
    globalAttempts.push(now);
  }

  function signature(body) {
    return createHmac('sha256', key).update(SIGNING_CONTEXT).update(body).digest();
  }

  function cookie(value, expiresAt, clear = false) {
    const attributes = [
      COOKIE_NAME + '=' + value,
      'HttpOnly',
      'Path=/',
      'SameSite=Strict',
      'Max-Age=' + (clear ? 0 : Math.ceil(ttlMs / 1000)),
      'Expires=' + (clear ? 'Thu, 01 Jan 1970 00:00:00 GMT' : new Date(expiresAt).toUTCString())
    ];
    if (secureCookie) attributes.push('Secure');
    return attributes.join('; ');
  }

  function sessionView(record) {
    return {
      authenticated:true,
      role:'viewer',
      viewer:{ displayName:'团队查看' },
      expiresAt:new Date(record.exp).toISOString()
    };
  }

  function resolve(cookieHeader, now) {
    prune(now);
    if (typeof cookieHeader !== 'string' || cookieHeader.length > MAX_COOKIE_HEADER_BYTES ||
      Buffer.byteLength(cookieHeader, 'utf8') > MAX_COOKIE_HEADER_BYTES) return null;
    let token = null;
    for (const component of cookieHeader.split(';')) {
      const separator = component.indexOf('=');
      if (separator < 0 || component.slice(0, separator).trim() !== COOKIE_NAME) continue;
      if (token !== null) return null; // Reject ambiguous duplicate-cookie scopes.
      token = component.slice(separator + 1).trim();
    }
    if (!token || token.length > 1024) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const body = decodeBase64Url(parts[0], 1, 512);
    const supplied = decodeBase64Url(parts[1], 32, 32);
    if (!body || !supplied || !timingSafeEqual(signature(parts[0]), supplied)) return null;
    let claims;
    try { claims = JSON.parse(body.toString('utf8')); } catch { return null; }
    if (!claims || Array.isArray(claims) || typeof claims !== 'object' || Object.keys(claims).length !== 4 ||
      claims.v !== 1 || !decodeBase64Url(claims.jti, 24, 24) ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat < 0 || claims.iat > now || claims.exp <= now || claims.exp - claims.iat !== ttlMs) return null;
    const record = sessions.get(claims.jti);
    if (!record || record.iat !== claims.iat || record.exp !== claims.exp) return null;
    return { id:claims.jti, record };
  }

  async function login({ password, clientKey } = {}) {
    reserveAttempt(clientKey, Date.now());
    if (!validPassword(password)) throw unauthorized();
    const admittedGeneration = generation;
    const input = Buffer.from(password, 'utf8');
    let actual;
    activeHashes++;
    try {
      try { actual = await derive(input, salt, 32, SCRYPT); }
      catch { throw limited(1000); }
      if (!timingSafeEqual(actual, expected) || admittedGeneration !== generation) throw unauthorized();
      const now = Date.now();
      prune(now);
      if (sessions.size >= MAX_SESSIONS) throw limited(WINDOW_MS);
      let id;
      do { id = randomBytes(24).toString('base64url'); } while (sessions.has(id));
      const record = { iat:now, exp:now + ttlMs };
      const body = Buffer.from(JSON.stringify({ v:1, jti:id, ...record })).toString('base64url');
      const token = body + '.' + signature(body).toString('base64url');
      sessions.set(id, record);
      return { cookie:cookie(token, record.exp), session:sessionView(record) };
    } finally {
      activeHashes--;
      input.fill(0);
      actual?.fill(0);
    }
  }

  function authenticate(cookieHeader) {
    const found = resolve(cookieHeader, Date.now());
    return found ? sessionView(found.record) : null;
  }

  function logout(cookieHeader) {
    const found = resolve(cookieHeader, Date.now());
    if (found) sessions.delete(found.id);
    return cookie('', 0, true);
  }

  function resetAll() {
    const revoked = sessions.size;
    sessions.clear();
    generation++;
    // Pending logins from before this revocation cannot mint a fresh session.
    // Keep login-rate history so revocation is not a rate-limit reset.
    return revoked;
  }

  return Object.freeze({ username, login, authenticate, logout, resetAll });
}
