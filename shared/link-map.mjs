// V1 evolution of dashboard-prototype/link-map.mjs. This is the sole mapping
// implementation used by catalog generation and the browser collector.
// Navigation URLs are never rewritten; query values never leave this module.
export class MappingError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'MappingError'; this.code = code; this.details = details; }
}

export function canonicalTarget(href, { origin, download = false } = {}) {
  if (!href || /^\s*(?:#|javascript:|data:|blob:)/i.test(href)) return null;
  let url, base;
  try { base = new URL(origin); url = new URL(href, base); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const local = url.origin === base.origin;
  const query = [...url.searchParams];
  let route = '';
  if (/^#!?\//.test(url.hash)) {
    const raw = url.hash.replace(/^#!/, '#').slice(1);
    const split = raw.indexOf('?');
    route = '#' + (split === -1 ? raw : raw.slice(0, split));
    if (split !== -1) query.push(...new URLSearchParams(raw.slice(split + 1)));
  }
  if (download && local && /\/amd-developer-group-qr-color(?:\.[a-f0-9]{8,64})?\.png$/i.test(url.pathname)) {
    return { key: 'download:community-qr', host: base.host, path: '/assets/amd-developer-group-qr-color.png', kind: 'download', query, strippedQuery: !!url.search };
  }
  if (local && !download) return null;
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
  const clean = url.origin + pathname + route;
  return { key: (download ? 'download:' : '') + clean, host: url.host, path: pathname + route, kind: download ? 'download' : 'external', query, strippedQuery: !!url.search || /\?/.test(url.hash) };
}

export function stableId(key) {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(key)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return 'link_' + hash.toString(16).padStart(16, '0');
}

function inferredCategory(target) {
  const host = target.host.replace(/^www\./, ''), p = target.path;
  if (host === 'bilibili.com') return { category: /^\/video\//.test(p) ? 'bilibili_video' : 'community', channel: 'B站' };
  if (host === 'b23.tv') return { category: 'other', channel: 'B站' };
  if (host === 'zhuanlan.zhihu.com') return { category: 'zhihu_article', channel: '知乎' };
  if (host === 'zhihu.com') return { category: /^\/(question|answer|p)\//.test(p) ? 'zhihu_article' : 'community', channel: '知乎' };
  if (['xiaohongshu.com', 'rednote.com'].includes(host)) return { category: /^\/(discovery\/item|explore)\//.test(p) ? 'xiaohongshu_content' : 'community', channel: '小红书' };
  return { category: 'other', channel: target.host };
}

const validId = value => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
const queryKey = value => /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : '[unrecognized]';
const categoriesOf = rules => rules.categories || rules.groups;
const ruleKey = (value, rules) => value.startsWith('download:') ? value : canonicalTarget(value, { origin: rules.origin })?.key;

export function mapLink(link, rules) {
  if (link.attrs?.['data-track-ignore'] === 'true') return null;
  const target = canonicalTarget(link.href, { origin: rules.origin, download: link.download });
  if (!target) return null;
  const match = rules.targets.find(row => [row[4], ...(row[5] || [])].some(value => ruleKey(value, rules) === target.key));
  const explicitId = link.attrs?.['data-track-id'];
  if (explicitId && !validId(explicitId)) throw new MappingError('invalid_explicit_id');
  const explicitRule = explicitId && rules.targets.find(row => row[0] === explicitId);
  if (explicitRule && explicitRule !== match) throw new MappingError('conflicting_explicit_id', { targetId: explicitId });
  const policy = rules.queryPolicies?.[explicitId || match?.[0]] || {};
  const ignoredKeys = new Set([...(rules.trackingQueryKeys || []), ...(policy.ignore || [])]);
  const ambiguous = target.query.filter(([key, value]) => !ignoredKeys.has(key) && !policy.values?.[key]?.includes(value));
  // An explicit ID is a curator assertion of identity. Otherwise an unknown
  // business query must be reviewed, never hashed into an accidental visitor ID.
  if (ambiguous.length && !explicitId) throw new MappingError('unreviewed_query', {
    canonical: target.key, host: target.host, queryKeys: [...new Set(ambiguous.map(([key]) => queryKey(key)))]
  });
  const inferred = inferredCategory(target);
  const explicitCategory = link.attrs?.['data-track-category'];
  if (explicitCategory && !categoriesOf(rules)[explicitCategory]) throw new MappingError('invalid_category');
  const id = explicitId || match?.[0] || stableId(target.key);
  const explicitTopics = (link.attrs?.['data-track-topics'] || '').split(',').map(value => value.trim()).filter(Boolean);
  if (explicitTopics.some(topic => !rules.topics?.[topic])) throw new MappingError('unknown_topic');
  return {
    id, name: link.attrs?.['data-track-label'] || match?.[1] || link.label || ('待命名 · ' + target.host),
    category: explicitCategory || match?.[2] || inferred.category, channel: match?.[3] || inferred.channel,
    topics: [...new Set(explicitTopics.length ? explicitTopics : match?.[6] || [])],
    canonical: match ? ruleKey(match[4], rules) : target.key, host: target.host, kind: target.kind,
    reviewed: !!(match || (explicitId && link.attrs?.['data-track-label'])), strippedQuery: target.strippedQuery,
    placement: link.attrs?.['data-track-placement'] || link.placement || '未标注位置',
    role: link.attrs?.['data-track-role'] || link.role || '',
    event: { type: target.kind === 'download' ? 'download_click' : 'outbound_click', targetId: id, targetHost: target.host }
  };
}

export function validateRules(rules) {
  const ids = new Set(), aliases = new Map();
  for (const row of rules.targets) {
    if (!validId(row[0]) || ids.has(row[0])) throw new MappingError('duplicate_or_invalid_rule_id');
    ids.add(row[0]);
    if (!categoriesOf(rules)[row[2]]) throw new MappingError('invalid_rule_category', { targetId: row[0] });
    if ((row[6] || []).some(topic => !rules.topics?.[topic])) throw new MappingError('unknown_rule_topic', { targetId: row[0] });
    for (const value of [row[4], ...(row[5] || [])]) {
      const key = ruleKey(value, rules);
      if (!key || aliases.has(key) && aliases.get(key) !== row[0]) throw new MappingError('conflicting_alias', { targetId: row[0] });
      aliases.set(key, row[0]);
    }
  }
  return true;
}

export function buildCatalog(links, rules) {
  validateRules(rules);
  const targets = new Map();
  let outgoing = 0, external = 0, downloads = 0, stripped = 0;
  for (const link of links) {
    const mapped = mapLink(link, rules);
    if (!mapped) continue;
    outgoing++;
    if (mapped.kind === 'download') downloads++; else external++;
    if (mapped.strippedQuery) stripped++;
    if (targets.has(mapped.id) && targets.get(mapped.id).canonical !== mapped.canonical) throw new MappingError('conflicting_target_id', { targetId: mapped.id });
    if (!targets.has(mapped.id)) targets.set(mapped.id, { ...mapped, occurrences: [] });
    targets.get(mapped.id).occurrences.push({ placement: mapped.placement, role: mapped.role });
  }
  return {
    version: rules.version, origin: rules.origin,
    counts: { anchors: links.length, outgoing, external, downloads, ignored: links.length - outgoing, targets: targets.size, queryStripped: stripped },
    targets: [...targets.values()].map(({ placement, role, strippedQuery, event, ...rest }) => rest),
    categories: Object.entries(categoriesOf(rules)).map(([id, name]) => ({ id, name })),
    topics: Object.entries(rules.topics || {}).map(([id, name]) => ({ id, name })), provenance: rules.provenance
  };
}

export function trackableFromEvent(event) {
  return event.composedPath?.().find(node => (node?.tagName === 'A' && node.hasAttribute?.('href'))
    || (node?.tagName === 'BUTTON' && node.hasAttribute?.('data-track-href')))
    || event.target?.closest?.('a[href], button[data-track-href]') || null;
}

export function linkFromElement(anchor) {
  const attrs = {};
  for (const key of ['data-track-id', 'data-track-label', 'data-track-category', 'data-track-topics', 'data-track-role', 'data-track-placement', 'data-track-ignore']) {
    if (anchor.hasAttribute(key)) attrs[key] = anchor.getAttribute(key);
  }
  return { href: anchor.getAttribute('href') || anchor.getAttribute('data-track-href'), download: anchor.hasAttribute('download'), attrs,
    label: anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.querySelector('h3,h2')?.textContent.trim() || anchor.textContent.trim(),
    placement: anchor.closest('[data-track-placement]')?.getAttribute('data-track-placement') || '未标注位置' };
}
