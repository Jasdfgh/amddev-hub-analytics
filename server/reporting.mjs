const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
const TIMEZONE = 'Asia/Shanghai';
const allowedParameters = new Set(['start', 'end', 'categories', 'topics', 'targets', 'q', 'compare', 'grain', 'minClicks', 'includeZero', 'sort', 'direction', 'page', 'pageSize']);

function bad(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function epoch(date, label = 'date') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) === '0000') bad(`Invalid ${label}; expected a real YYYY-MM-DD date.`);
  const value = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) bad(`Invalid ${label}; expected a real calendar date.`);
  return value;
}
function iso(value) {
  const result = new Date(value).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || result.startsWith('0000')) bad('Comparison extends outside supported calendar dates.');
  return result;
}
function shift(date, days) { return iso(epoch(date) + days * DAY); }
function instant(value, label) {
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid ${label}.`);
  return result;
}
function shanghaiDate(value) { return iso(value + SHANGHAI_OFFSET); }
function collectionInstant(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return epoch(value, 'collectionStartedAt') - SHANGHAI_OFFSET;
  return instant(value, 'collectionStartedAt');
}
function arrayIds(catalog, field) { return new Set((catalog[field] || []).map(row => row.id)); }
function list(params, key, valid) {
  const text = params.get(key);
  if (text === null || text === '') return [];
  const values = text.split(',').map(value => value.trim());
  if (values.some(value => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) || !valid.has(value))) bad(`Unknown or invalid ${key}.`);
  return [...new Set(values)];
}
function boolean(params, name, fallback) {
  if (!params.has(name)) return fallback;
  const value = params.get(name);
  if (!['true', 'false'].includes(value)) bad(`Invalid ${name}; expected true or false.`);
  return value === 'true';
}
function integer(params, name, fallback, minimum = 0) {
  if (!params.has(name)) return fallback;
  const value = params.get(name);
  if (!/^(?:0|[1-9]\d*)$/.test(value)) bad(`Invalid ${name}; expected an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) bad(`Invalid ${name}.`);
  return parsed;
}

export function parseReportQuery(searchParams, catalog, { now = new Date(), collectionStartedAt } = {}) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);
  for (const key of params.keys()) {
    if (!allowedParameters.has(key)) bad(`Unsupported query parameter: ${key}.`);
    if (params.getAll(key).length !== 1) bad(`Repeated query parameter: ${key}.`);
  }
  if (params.has('start') !== params.has('end')) bad('Provide both start and end dates.');
  const today = shanghaiDate(instant(now, 'now'));
  const start = params.has('start') ? params.get('start') : shift(today, -6);
  const end = params.has('end') ? params.get('end') : today;
  const first = epoch(start, 'start'), last = epoch(end, 'end');
  if (first > last) bad('Start date must not be after end date.');
  const days = (last - first) / DAY + 1;
  const compare = boolean(params, 'compare', true);
  const previous = compare ? { start: shift(start, -days), end: shift(start, -1), days } : null;
  const grain = params.get('grain') || 'day';
  if (!['day', 'week', 'month'].includes(grain)) bad('Invalid trend grain.');
  const sort = params.get('sort') || 'date';
  if (!['date', 'clicks', 'delta', 'percent', 'name'].includes(sort)) bad('Invalid sort field.');
  const direction = params.get('direction') || 'desc';
  if (!['asc', 'desc'].includes(direction)) bad('Invalid sort direction.');
  const page = integer(params, 'page', 1, 1), pageSize = integer(params, 'pageSize', 25, 1);
  if (![25, 50, 100].includes(pageSize)) bad('Page size must be 25, 50, or 100.');
  const q = (params.get('q') || '').trim();
  if (q.length > 256 || /[\u0000-\u001f\u007f]/.test(q)) bad('Invalid search text.');
  collectionInstant(collectionStartedAt); // configuration validation, not a query-range restriction
  return {
    start, end, days, previous, timezone: TIMEZONE, compare, grain,
    categories: list(params, 'categories', arrayIds(catalog, 'categories')),
    topics: list(params, 'topics', arrayIds(catalog, 'topics')),
    targets: list(params, 'targets', arrayIds(catalog, 'targets')),
    q, minClicks: integer(params, 'minClicks', 0), includeZero: boolean(params, 'includeZero', false),
    sort, direction, page, pageSize, loadStart: previous?.start || start, loadEnd: end
  };
}

function coverageFor(start, end, collectedAt, asOf) {
  if (collectedAt === null || collectedAt >= asOf) return { status: 'none', start: null, end: null };
  const requestedStart = epoch(start) - SHANGHAI_OFFSET;
  const requestedEnd = epoch(end) + DAY - SHANGHAI_OFFSET;
  const observedStart = Math.max(requestedStart, collectedAt), observedEnd = Math.min(requestedEnd, asOf);
  if (observedStart >= observedEnd) return { status: 'none', start: null, end: null };
  return {
    status: observedStart === requestedStart && observedEnd === requestedEnd ? 'complete' : 'partial',
    start: shanghaiDate(observedStart), end: shanghaiDate(observedEnd - 1)
  };
}
function fold(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN'); }
function matchedTargets(query, catalog) {
  const queryText = fold(query.q);
  return catalog.targets.filter(row => (!query.categories.length || query.categories.includes(row.category))
    && (!query.topics.length || row.topics?.some(topic => query.topics.includes(topic)))
    && (!query.targets.length || query.targets.includes(row.id))
    && (!queryText || fold([row.name, row.channel, row.canonical].join(' ')).includes(queryText)));
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid aggregated fact count.');
  return value;
}
function add(map, key, value) {
  const next = (map.get(key) || 0) + count(value);
  if (!Number.isSafeInteger(next)) throw new Error('Aggregated count exceeds safe integer range.');
  map.set(key, next);
}
function prepare({ query, facts, catalog, collectionStartedAt, now = new Date(), mode = 'live' }) {
  if (!['live', 'demo'].includes(mode)) throw new Error('Invalid report mode.');
  const asOf = instant(now, 'now'), collectedAt = collectionInstant(collectionStartedAt);
  const current = coverageFor(query.start, query.end, collectedAt, asOf);
  const previous = query.compare ? coverageFor(query.previous.start, query.previous.end, collectedAt, asOf) : null;
  const matched = matchedTargets(query, catalog), ids = new Set(matched.map(row => row.id));
  const catalogIds = new Set(catalog.targets.map(row => row.id));
  const visits = new Map(), clicks = new Map(), byTarget = new Map();
  for (const row of facts.visits || []) { epoch(row.date); add(visits, row.date, row.count); }
  for (const row of facts.outbound || []) {
    epoch(row.date);
    if (!catalogIds.has(row.targetId)) {
      const error = new Error('Catalog is missing recorded targets; refresh discovered target metadata.');
      error.code = 'CATALOG_OUTDATED'; error.statusCode = 503; throw error;
    }
    if (!ids.has(row.targetId)) continue;
    add(clicks, row.date, row.count);
    if (!byTarget.has(row.targetId)) byTarget.set(row.targetId, new Map());
    add(byTarget.get(row.targetId), row.date, row.count);
  }
  const period = { start: query.start, end: query.end, days: query.days, timezone: TIMEZONE, previous: query.previous };
  const coverage = { status: current.status, collectedFrom: collectedAt === null ? null : shanghaiDate(collectedAt), through: current.end, previousStatus: previous?.status ?? null };
  return { query, facts, catalog, current, previous, matched, ids, visits, clicks, byTarget, period, coverage, mode, collectedAt, asOf,
    comparable: query.compare && current.status === 'complete' && previous.status === 'complete' };
}
function sum(map, start, end, cover) {
  if (!cover || cover.status === 'none') return null;
  let total = 0;
  const first = start > cover.start ? start : cover.start, last = end < cover.end ? end : cover.end;
  if (first > last) return null;
  for (const [date, value] of map || []) if (date >= first && date <= last) total += value;
  if (!Number.isSafeInteger(total)) throw new Error('Aggregated count exceeds safe integer range.');
  return total;
}
function rangeBins(query, cover) {
  if (cover.status === 'none') return [];
  const start = epoch(cover.start), end = epoch(cover.end), anchor = epoch(query.start), result = [];
  let cursor = start;
  while (cursor <= end) {
    let stop;
    if (query.grain === 'week') stop = anchor + (Math.floor((cursor - anchor) / (7 * DAY)) + 1) * 7 * DAY - DAY;
    else if (query.grain === 'month') {
      const current = new Date(cursor);
      current.setUTCMonth(current.getUTCMonth() + 1, 1);
      stop = current.getTime() - DAY;
    } else stop = cursor;
    stop = Math.min(stop, end, epoch(query.end));
    result.push({ start: iso(cursor), end: iso(stop) });
    cursor = stop + DAY;
  }
  return result;
}
function changes(current, previous, comparable) {
  if (!comparable || current === null || previous === null) return { delta: null, percent: null };
  const delta = current - previous;
  return { delta, percent: previous > 0 ? delta / previous * 100 : null };
}

export function buildReport(options) {
  const state = prepare(options), { query, current, previous, visits, clicks, byTarget } = state;
  const summary = {
    visits: sum(visits, query.start, query.end, current), clicks: sum(clicks, query.start, query.end, current),
    previousVisits: query.compare ? sum(visits, query.previous.start, query.previous.end, previous) : null,
    previousClicks: query.compare ? sum(clicks, query.previous.start, query.previous.end, previous) : null
  };
  const series = rangeBins(query, current).map(bin => {
    const previousStart = query.compare ? shift(bin.start, -query.days) : null;
    const previousEnd = query.compare ? shift(bin.end, -query.days) : null;
    return { ...bin, visits: sum(visits, bin.start, bin.end, current), clicks: sum(clicks, bin.start, bin.end, current),
      previousStart, previousEnd,
      previousVisits: query.compare ? sum(visits, previousStart, previousEnd, previous) : null,
      previousClicks: query.compare ? sum(clicks, previousStart, previousEnd, previous) : null };
  });
  const single = query.targets.length === 1 && state.matched.length === 1;
  const top = current.status === 'none' ? [] : state.matched.map(target => {
    const count = sum(byTarget.get(target.id), query.start, query.end, current);
    const previousCount = query.compare ? sum(byTarget.get(target.id), query.previous.start, query.previous.end, previous) : null;
    return { targetId: target.id, count, previousCount, ...changes(count, previousCount, state.comparable) };
  }).filter(row => row.count > 0 || single && row.count === 0)
    .sort((a, b) => b.count - a.count || a.targetId.localeCompare(b.targetId, 'en')).slice(0, single ? 1 : 3);
  return { period: state.period, coverage: state.coverage, summary, series, top, matchedTargets: state.matched.length, mode: state.mode,
    grain: query.grain, comparisonAlignment: query.grain === 'month' ? 'calendar-month-bins-with-equal-day-offset' : 'equal-day-offset' };
}

export function buildDailyReport(options) {
  const state = prepare(options), { query, current, previous, byTarget } = state;
  const rows = [], series = [];
  const threshold = Math.max(query.minClicks, query.includeZero ? 0 : 1);
  if (current.status !== 'none') {
    for (let day = epoch(current.start), end = epoch(current.end); day <= end; day += DAY) {
      const date = iso(day), previousDate = query.compare ? shift(date, -query.days) : null;
      const previousDayCovered = query.compare && previous.status !== 'none' && previousDate >= previous.start && previousDate <= previous.end;
      let total = 0, previousTotal = previousDayCovered ? 0 : null;
      for (const target of state.matched) {
        const values = byTarget.get(target.id), count = values?.get(date) || 0;
        if (count < threshold) continue;
        const previousCount = previousDayCovered ? values?.get(previousDate) || 0 : null;
        rows.push({ date, targetId: target.id, count, previousDate, previousCount, ...changes(count, previousCount, state.comparable) });
        total += count;
        if (previousTotal !== null) previousTotal += previousCount;
      }
      series.push({ date, count: total, previousDate, previousCount: previousTotal });
    }
  }
  const names = new Map(state.matched.map(row => [row.id, row.name]));
  const compareValues = (a, b, field) => {
    const left = field === 'name' ? names.get(a.targetId) : field === 'clicks' ? a.count : a[field];
    const right = field === 'name' ? names.get(b.targetId) : field === 'clicks' ? b.count : b[field];
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    const result = typeof left === 'string' ? left.localeCompare(right, field === 'name' ? 'zh-CN' : 'en') : left - right;
    return query.direction === 'asc' ? result : -result;
  };
  rows.sort((a, b) => compareValues(a, b, query.sort) || b.date.localeCompare(a.date, 'en') || b.count - a.count || a.targetId.localeCompare(b.targetId, 'en'));
  const summary = current.status === 'none' ? { clicks: null, targets: null } : {
    clicks: rows.reduce((total, row) => total + row.count, 0), targets: new Set(rows.map(row => row.targetId)).size
  };
  const first = (query.page - 1) * query.pageSize;
  return { period: state.period, coverage: state.coverage, mode: state.mode, summary, series,
    totalRows: rows.length, page: query.page, pageSize: query.pageSize, rows: rows.slice(first, first + query.pageSize) };
}
