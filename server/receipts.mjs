import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'event_id, owner_hash, payload_hash, identity_id, status, response, created_at, updated_at, expires_at';
const SELECT_LOCKED = 'SELECT ' + COLUMNS + ' FROM hub.collect_receipt WHERE event_id = $1::uuid FOR UPDATE';
const INSERT_PENDING = 'INSERT INTO hub.collect_receipt ' +
  '(event_id, owner_hash, payload_hash, identity_id, status, response, created_at, updated_at, expires_at) ' +
  "VALUES ($1::uuid, $2, $3, $4, 'pending', NULL, $5::timestamptz, $5::timestamptz, $6::timestamptz) " +
  'ON CONFLICT (event_id) DO NOTHING RETURNING ' + COLUMNS;
const CLAIM_RETRY = 'UPDATE hub.collect_receipt SET updated_at = $2::timestamptz ' +
  "WHERE event_id = $1::uuid AND status = 'pending' AND expires_at > $2::timestamptz " +
  'AND updated_at <= $3::timestamptz RETURNING event_id';
const PRUNE_EXPIRED = 'WITH expired AS (' +
  'SELECT event_id FROM hub.collect_receipt WHERE expires_at <= $1::timestamptz ' +
  'ORDER BY expires_at, event_id LIMIT $2::integer FOR UPDATE SKIP LOCKED' +
  ') DELETE FROM hub.collect_receipt AS receipt USING expired ' +
  'WHERE receipt.event_id = expired.event_id RETURNING receipt.event_id';
const PRIVILEGES = [
  'SELECT',
  '(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls',
  ' FROM pg_catalog.pg_roles WHERE rolname = current_user) AS elevated_role,',
  "has_schema_privilege(current_user, 'public', 'CREATE') OR",
  "has_schema_privilege(current_user, 'hub', 'CREATE') AS can_create,",
  "has_table_privilege(current_user, 'hub.collect_receipt', 'SELECT') AND",
  "has_table_privilege(current_user, 'hub.collect_receipt', 'INSERT') AND",
  "has_table_privilege(current_user, 'hub.collect_receipt', 'UPDATE') AND",
  "has_table_privilege(current_user, 'hub.collect_receipt', 'DELETE') AS receipt_rw,",
  "has_table_privilege(current_user, 'hub.collect_receipt', 'TRUNCATE,REFERENCES,TRIGGER') AS receipt_extra,",
  'COALESCE((SELECT bool_or(has_table_privilege(current_user, c.oid,',
  "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))",
  'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "WHERE n.nspname IN ('public','hub') AND c.relkind IN ('r','p')",
  "AND NOT (n.nspname = 'hub' AND c.relname = 'collect_receipt')), false) AS other_access"
].join(' ');

function failure(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

const invalid = () => failure(400, 'invalid_receipt', 'Invalid receipt input.');
const expired = () => failure(410, 'receipt_expired', 'This collection receipt has expired.');
const unavailable = () => failure(503, 'receipt_unavailable', 'Collection receipt storage is unavailable.');

function eventId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}

function text(value) {
  if (typeof value !== 'string' || !value || value.length > 256 ||
    Buffer.byteLength(value, 'utf8') > 256 || value.includes('\u0000')) throw invalid();
  return value;
}

function timestamp(value) {
  if (!(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string') throw invalid();
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw invalid();
  return result;
}

function publicReceipt(row) {
  if (!row || !['pending','accepted','ignored'].includes(row.status)) throw unavailable();
  return {
    eventId:row.event_id,
    identityId:row.identity_id,
    status:row.status,
    response:row.response,
    createdAt:timestamp(row.created_at).toISOString(),
    updatedAt:timestamp(row.updated_at).toISOString(),
    expiresAt:timestamp(row.expires_at).toISOString()
  };
}

function assertNotExpired(row, current) {
  if (timestamp(row.expires_at).getTime() <= current.getTime()) throw expired();
}

function encodeResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(response))) throw invalid();
  let serialized;
  try { serialized = JSON.stringify(response); } catch { throw invalid(); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 65536) throw invalid();
  return serialized;
}

/**
 * Persistent ingestion receipts, using only the receipt-only database role.
 * The caller supplies RECEIPT_DATABASE_URL; there is no ambient DB fallback.
 */
export function createReceiptStore({ connectionString, now = () => Date.now() } = {}) {
  if (typeof connectionString !== 'string' || !connectionString) throw new TypeError('A receipt-only database connection is required.');
  if (typeof now !== 'function') throw new TypeError('now must be a clock function.');
  const pool = new pg.Pool({
    connectionString,
    max:4,
    application_name:'hub-analytics-receipts',
    connectionTimeoutMillis:5000,
    statement_timeout:15000,
    idle_in_transaction_session_timeout:15000,
    idleTimeoutMillis:10000
  });
  pool.on('error', () => {}); // Never log a connection string, payload or DB diagnostic.
  let verified = false;
  let verification = null;
  let closing = null;
  const clock = () => timestamp(now());

  async function ensureLimitedRole() {
    if (closing) throw unavailable();
    if (verified) return;
    if (!verification) {
      verification = pool.query(PRIVILEGES).then(({ rows }) => {
        const rights = rows[0];
        if (!rights || rights.elevated_role || rights.can_create || !rights.receipt_rw ||
          rights.receipt_extra || rights.other_access) throw unavailable();
        verified = true;
      }).finally(() => { verification = null; });
    }
    await verification;
  }

  async function transaction(operation) {
    let client;
    try {
      await ensureLimitedRole();
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (cause) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* Broken connection; pool will evict it. */ }
      }
      if (cause?.statusCode && ['invalid_receipt','receipt_conflict','receipt_expired','receipt_not_found','receipt_unavailable'].includes(cause.code)) throw cause;
      throw unavailable();
    } finally { client?.release(); }
  }

  async function query(sql, values) {
    try {
      await ensureLimitedRole();
      return await pool.query(sql, values);
    } catch { throw unavailable(); }
  }

  return {
    async reserve(input) {
      const id = eventId(input?.eventId);
      const owner = text(input.ownerHash), payload = text(input.payloadHash), identity = text(input.identityId);
      const until = timestamp(input.expiresAt), current = clock();
      if (until.getTime() <= current.getTime()) throw expired();
      return transaction(async client => {
        const inserted = await client.query(INSERT_PENDING, [id, owner, payload, identity, current.toISOString(), until.toISOString()]);
        const created = inserted.rowCount === 1;
        const row = created ? inserted.rows[0] : (await client.query(SELECT_LOCKED, [id])).rows[0];
        if (!row) throw unavailable();
        if (row.owner_hash !== owner || row.payload_hash !== payload) {
          throw failure(409, 'receipt_conflict', 'This event ID belongs to a different collection request.');
        }
        assertNotExpired(row, clock());
        // identity_id and expires_at belong to the first reservation, even if
        // this retry generated another candidate identity or a later deadline.
        return { created, receipt:publicReceipt(row) };
      });
    },

    async complete(value, response) {
      const id = eventId(value);
      return transaction(async client => {
        const row = (await client.query(SELECT_LOCKED, [id])).rows[0];
        if (!row) throw failure(404, 'receipt_not_found', 'This collection receipt does not exist.');
        const current = clock();
        assertNotExpired(row, current);
        const receipt = publicReceipt(row);
        if (receipt.status !== 'pending') return receipt.response;
        const serialized = encodeResponse(response);
        const status = response.accepted === false ? 'ignored' : 'accepted';
        const result = await client.query(
          'UPDATE hub.collect_receipt SET status = $2, response = $3::jsonb, updated_at = $4::timestamptz ' +
          "WHERE event_id = $1::uuid AND status = 'pending' RETURNING response",
          [id, status, serialized, current.toISOString()]
        );
        if (result.rowCount !== 1) throw unavailable();
        return result.rows[0].response;
      });
    },

    async claimRetry(value, olderThanMs = 15000) {
      const id = eventId(value);
      if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0 || olderThanMs > 30 * 86400000) throw invalid();
      const current = clock();
      const result = await query(CLAIM_RETRY, [id, current.toISOString(), new Date(current.getTime() - olderThanMs).toISOString()]);
      return result.rowCount === 1;
    },

    async pruneExpired(limit = 1000) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw invalid();
      if (limit === 0) return 0;
      const result = await query(PRUNE_EXPIRED, [clock().toISOString(), limit]);
      return result.rowCount;
    },

    close() {
      if (!closing) closing = pool.end();
      return closing;
    }
  };
}
