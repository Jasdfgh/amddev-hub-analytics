import net from 'node:net';

export function normalizeIp(value = '') {
  const ip = String(value).replace(/^::ffff:/, '');
  return net.isIP(ip) ? ip : '';
}
export function isPrivateIp(value) {
  const ip = normalizeIp(value);
  if (ip === '::1' || /^f[cd][0-9a-f:]+$/i.test(ip)) return true;
  if (net.isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}
function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid ${key}.`);
  return value;
}
function origin(value, allowIntranetHttp) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Expected a clean origin.');
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowIntranetHttp && isPrivateIp(url.hostname)))) throw new Error('HTTP is restricted to explicitly enabled intranet or loopback trial origins.');
  return url.origin;
}
export function loadConfig(env = process.env) {
  const allowIntranetHttp = env.ALLOW_INTRANET_HTTP === 'true';
  const publicOrigin = origin(required(env,'PUBLIC_ORIGIN'),allowIntranetHttp);
  const mode = env.DATA_MODE || 'live';
  if (!['live','demo'].includes(mode)) throw new Error('DATA_MODE must be live or demo.');
  const port = Number(env.PORT || 4391);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT.');
  const umamiUrl = new URL(required(env,'UMAMI_URL'));
  if (!['http:','https:'].includes(umamiUrl.protocol) || umamiUrl.username || umamiUrl.password || umamiUrl.search || umamiUrl.hash) throw new Error('Invalid UMAMI_URL.');
  const startedAt = required(env,'COLLECTION_STARTED_AT');
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error('Invalid COLLECTION_STARTED_AT.');
  const allowedOrigins = new Set((env.ALLOWED_COLLECT_ORIGINS || 'https://hub.amddev.ai').split(',').filter(Boolean).map(value=>origin(value.trim(),allowIntranetHttp)));
  return {
    publicOrigin, port, host: env.HOST || '127.0.0.1', mode,
    allowIntranetHttp, secureCookie: publicOrigin.startsWith('https:'),
    allowedOrigins, allowTestTraffic: env.ALLOW_TEST_TRAFFIC === 'true',
    trustedProxyIps: new Set((env.TRUSTED_PROXY_IPS || '').split(',').map(normalizeIp).filter(Boolean)),
    readDatabaseUrl: required(env,'READ_DATABASE_URL'), receiptDatabaseUrl: required(env,'RECEIPT_DATABASE_URL'),
    umamiUrl: umamiUrl.origin, websiteId: required(env,'UMAMI_WEBSITE_ID'),
    umamiAppSecret: required(env,'UMAMI_APP_SECRET'), tokenSecret: required(env,'COLLECTOR_TOKEN_SECRET'),
    passwordHash: required(env,'VIEWER_PASSWORD_HASH'), sessionSecret: required(env,'VIEWER_SESSION_SECRET'),
    viewerUsername: env.VIEWER_USERNAME || 'hub-viewer', collectionStartedAt: startedAt,
    hubHostname: env.HUB_HOSTNAME || 'hub.amddev.ai'
  };
}
export function clientInfo(request, config) {
  let ip = normalizeIp(request.socket.remoteAddress) || '127.0.0.1';
  // Only an explicitly trusted direct proxy may supply forwarding metadata.
  if (config.trustedProxyIps.has(ip)) {
    const chain = String(request.headers['x-forwarded-for'] || '').split(',').map(x=>normalizeIp(x.trim())).filter(Boolean);
    while (chain.length && config.trustedProxyIps.has(chain.at(-1))) chain.pop();
    if (chain.length) ip = chain.at(-1);
  }
  return { ip, userAgent: String(request.headers['user-agent'] || '').slice(0,512) };
}
