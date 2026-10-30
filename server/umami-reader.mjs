import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQL_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

// Umami 3.4.1 official PostgreSQL schema: website_event and event_data.
// No report-date predicate appears before first-seen aggregation. A visit or
// destination first observed before a requested date never gets recounted.
export const EVENTS_CTE = `
deduplicated AS (
  SELECT DISTINCT ON (lower(e.tag))
    e.event_id, e.session_id, e.visit_id, e.created_at, e.event_type, e.event_name, e.tag
  FROM website_event e
  WHERE e.website_id = $1::uuid AND e.hostname = $2
    AND e.created_at IS NOT NULL AND e.tag ~* '${SQL_UUID}'
  ORDER BY lower(e.tag), e.created_at, e.event_id
), metadata AS (
  SELECT e.*, d.target_id, d.target_variants, d.target_canonical, d.target_host
  FROM deduplicated e
  LEFT JOIN LATERAL (
    SELECT
      min(string_value) FILTER (WHERE data_key = 'targetId') AS target_id,
      count(DISTINCT string_value) FILTER (WHERE data_key = 'targetId') AS target_variants,
      min(string_value) FILTER (WHERE data_key = 'targetCanonical') AS target_canonical,
      min(string_value) FILTER (WHERE data_key = 'targetHost') AS target_host
    FROM event_data d
    WHERE d.website_id = $1::uuid AND d.website_event_id = e.event_id
  ) d ON true
), effective AS (
  SELECT *, CASE WHEN event_type = 2 AND event_name IN ('hub_outbound', 'hub_download')
    AND target_variants = 1 AND target_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
    THEN target_id ELSE NULL END AS effective_target
  FROM metadata
  WHERE event_type = 1 OR (event_type = 2 AND event_name IN ('hub_outbound', 'hub_download')
    AND target_variants = 1 AND target_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$')
)`;

export const FACTS_SQL = `WITH ${EVENTS_CTE},
visit_first AS (
  SELECT visit_id, min(created_at) AS first_seen FROM effective GROUP BY visit_id
), target_first AS (
  SELECT visit_id, effective_target AS target_id, min(created_at) AS first_seen
  FROM effective WHERE effective_target IS NOT NULL GROUP BY visit_id, effective_target
)
SELECT 'visits' AS kind, to_char(first_seen AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date,
  NULL::text AS target_id, count(*)::bigint AS count
FROM visit_first
WHERE first_seen >= ($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
  AND first_seen < (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
GROUP BY date
UNION ALL
SELECT 'outbound' AS kind, to_char(first_seen AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date,
  target_id, count(*)::bigint AS count
FROM target_first
WHERE first_seen >= ($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
  AND first_seen < (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
GROUP BY date, target_id
ORDER BY kind, date, target_id`;

const DISCOVER_SQL = `WITH ${EVENTS_CTE}
SELECT effective_target AS target_id, min(created_at) AS first_seen,
  min(target_canonical) AS target_canonical, count(DISTINCT target_canonical) AS canonical_variants,
  min(target_host) AS target_host,
  bool_and(event_name = 'hub_download') AS is_download
FROM effective WHERE effective_target IS NOT NULL
GROUP BY effective_target ORDER BY first_seen, target_id`;

const FIND_SQL = `SELECT e.event_id, e.session_id, e.visit_id, e.created_at, e.event_type, e.event_name, e.tag,
  (SELECT min(d.string_value) FROM event_data d
    WHERE d.website_id = $1::uuid AND d.website_event_id = e.event_id AND d.data_key = 'targetId') AS target_id
FROM website_event e
WHERE e.website_id = $1::uuid AND e.hostname = $2 AND lower(e.tag) = lower($3) AND e.created_at IS NOT NULL
ORDER BY e.created_at, e.event_id LIMIT 1`;

const PRIVILEGES_SQL = `
SELECT current_setting('transaction_read_only') = 'on' AS transaction_read_only,
  (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS elevated_role,
  has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
  COALESCE((SELECT bool_or(has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')), false) AS can_write,
  has_table_privilege(current_user, 'public.website_event', 'SELECT') AS can_read_events,
  has_table_privilege(current_user, 'public.event_data', 'SELECT') AS can_read_data`;

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw new Error('Invalid reader date.');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('Invalid reader calendar date.');
  return value;
}
function safeCount(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Analytics count is outside safe integer range.');
  return result;
}
function safeCanonical(value) {
  if (value === 'download:community-qr') return value;
  if (typeof value !== 'string' || value.length > 500) return null;
  const download = value.startsWith('download:');
  try {
    const url = new URL(download ? value.slice(9) : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || /\?/.test(url.hash)) return null;
    if (url.hash && !/^#\//.test(url.hash)) return null;
    return (download ? 'download:' : '') + url.origin + url.pathname + url.hash;
  } catch { return null; }
}

export function createUmamiReader({ connectionString, websiteId, hostname = 'hub.amddev.ai' }) {
  if (typeof connectionString !== 'string' || !connectionString) throw new Error('A read-only database connection is required.');
  if (!UUID.test(websiteId || '')) throw new Error('A valid fixed Umami website ID is required.');
  if (!/^[a-z0-9.-]{1,100}$/.test(hostname)) throw new Error('A fixed lowercase hostname is required.');
  const pool = new pg.Pool({ connectionString, max: 4, application_name: 'hub-analytics-readonly',
    connectionTimeoutMillis: 5000, statement_timeout: 15000, idle_in_transaction_session_timeout: 15000,
    options: '-c default_transaction_read_only=on' });
  // Failed idle clients are evicted by pg; request failures still surface as a
  // sanitized service error. Never log connection strings or credentials.
  pool.on('error', () => {});
  async function read(sql, values) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL search_path TO public');
      const result = await client.query(sql, values);
      await client.query('COMMIT');
      return result.rows;
    } catch (cause) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ } }
      const error = new Error('Read-only analytics query failed.');
      error.statusCode = 503;
      error.code = typeof cause.code === 'string' ? cause.code : 'READER_UNAVAILABLE';
      throw error;
    } finally { client?.release(); }
  }
  return {
    async loadFacts({ start, end }) {
      dateOnly(start); dateOnly(end);
      if (start > end) throw new Error('Reader start date must not be after end date.');
      const rows = await read(FACTS_SQL, [websiteId, hostname, start, end]);
      const facts = { visits: [], outbound: [] };
      for (const row of rows) {
        if (row.kind === 'visits') facts.visits.push({ date: row.date, count: safeCount(row.count) });
        else facts.outbound.push({ date: row.date, targetId: row.target_id, count: safeCount(row.count) });
      }
      return facts;
    },
    async discoverTargets() {
      const rows = await read(DISCOVER_SQL, [websiteId, hostname]);
      const targets = [];
      for (const row of rows) {
        if (Number(row.canonical_variants) > 1) throw new Error('Conflicting target canonical metadata; administrator review is required.');
        const canonical = safeCanonical(row.target_canonical);
        if (!canonical || typeof row.target_host !== 'string' || !/^[a-zA-Z0-9.[\]:-]{1,255}$/.test(row.target_host)) continue;
        targets.push({ id: row.target_id, name: '待确认 · ' + row.target_host, category: 'other', channel: row.target_host,
          topics: [], canonical, kind: row.is_download ? 'download' : 'external', reviewed: false,
          firstSeen: row.first_seen.toISOString() });
      }
      return targets;
    },
    async findEventByTag(eventId) {
      if (!UUID.test(eventId || '')) throw new Error('Invalid eventId.');
      const [row] = await read(FIND_SQL, [websiteId, hostname, eventId]);
      return row ? { eventId: row.event_id, sessionId: row.session_id, visitId: row.visit_id, createdAt: row.created_at.toISOString(),
        eventType: row.event_type, eventName: row.event_name, tag: row.tag, targetId: row.target_id } : null;
    },
    async assertReadOnly() {
      const [row] = await read(PRIVILEGES_SQL, []);
      const readOnly = row.transaction_read_only && !row.elevated_role && !row.can_create && !row.can_write && row.can_read_events && row.can_read_data;
      if (!readOnly) throw new Error('Analytics database role must have SELECT-only privileges without elevated or schema-creation privileges.');
      return { readOnly: true, transactionReadOnly: true, canReadEvents: true, canReadEventData: true, canWrite: false, canCreate: false };
    },
    close: () => pool.end()
  };
}
