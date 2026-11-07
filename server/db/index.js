/**
 * PostgreSQL (Supabase) data layer.
 *
 * Business code keeps using four small helpers — one / all / run / tx — now async.
 *  • `?` placeholders are converted to $1, $2… so queries stay readable.
 *  • tx(fn) runs fn inside BEGIN/COMMIT on ONE pooled connection; every helper called inside it
 *    (even from other modules) automatically uses that connection via AsyncLocalStorage.
 *    Nested tx() calls become savepoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
// Subpath import: only the pool helper, not the rest of @vercel/functions (OIDC, caching, …).
import { attachDatabasePool } from '@vercel/functions/db-connections';
import { config, ROOT } from '../config.js';

// Return BIGINT/NUMERIC as JS numbers (ids & sums here are far below 2^53) and timestamps as ISO strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());

if (!config.db.url) {
  throw new Error('DATABASE_URL is not set. Add your Supabase Postgres connection string to .env (see README → Supabase).');
}

// ONE pool per process / serverless instance, created when this module first loads and shared by every route,
// webhook and cron job (on Vercel all of them run in the single api/index.js function).
export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  ssl: config.db.ssl,
  idleTimeoutMillis: config.db.idleTimeoutMs, // 5 s on Vercel, 30 s locally (config.js)
  keepAlive: true, // TCP keep-alives stop routers/NAT from silently dropping long-lived connections to Supabase
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 15_000,
  application_name: 'velberry',
});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

// Vercel Fluid compute can suspend an instance as soon as a response ends. A suspended instance can't run the
// pool's idle timer, so its idle connections would stay open — each holding a Supabase pooler slot. Vercel's
// attachDatabasePool listens for every client "release" and keeps the instance alive (waitUntil) for
// idleTimeoutMillis + 100 ms so pg can close those idle connections first. Outside Vercel it does nothing,
// so it's only attached there.
if (config.serverless) attachDatabasePool(pool);

const als = new AsyncLocalStorage();
const runner = () => als.getStore()?.client || pool;

/** Run fn outside any surrounding transaction (for fire-and-forget work such as sending emails). */
export const detached = (fn) => als.exit(fn);

/** Convert `?` placeholders (outside quoted strings) to $1…$n. */
const cache = new Map();
function toPg(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let n = 0;
  let quote = null;
  out = '';
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  cache.set(sql, out);
  return out;
}

const NO_ID_TABLES = new Set(['sessions', 'settings', 'schema_migrations']);
function withReturning(sql) {
  const m = /^\s*insert\s+into\s+(\w+)/i.exec(sql);
  if (!m || /\breturning\b/i.test(sql) || NO_ID_TABLES.has(m[1].toLowerCase())) return sql;
  return `${sql} RETURNING id`;
}

export async function query(sql, params = []) {
  return runner().query(toPg(sql), params);
}
export const one = async (sql, ...p) => (await query(sql, p)).rows[0];
export const all = async (sql, ...p) => (await query(sql, p)).rows;
/** Write helper. INSERTs automatically return the new id. */
export const run = async (sql, ...p) => {
  const r = await query(withReturning(sql), p);
  return { changes: r.rowCount, id: r.rows[0]?.id };
};

/**
 * Run fn in a transaction. Nested calls create savepoints. The callback may be async.
 * Postgres runs transactions concurrently, so code that must not race takes row locks
 * (SELECT … FOR UPDATE) or an advisory lock (lockKey) inside the transaction.
 */
export async function tx(fn) {
  const store = als.getStore();
  if (store?.inTx) {
    const sp = `sp${++store.depth}`;
    await store.client.query(`SAVEPOINT ${sp}`);
    try {
      const out = await fn();
      await store.client.query(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      await store.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw e;
    } finally {
      store.depth--;
    }
  }
  // Inside withLock(): run the transaction on the lock's connection instead of taking a second one.
  const own = !store;
  const client = own ? await pool.connect() : store.client;
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, depth: 0, inTx: true }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own) client.release();
  }
}

/** Transaction-scoped advisory lock: serialises work on one logical key (released at COMMIT/ROLLBACK). */
export const lockKey = (key) => query('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [String(key)]);

export const isUniqueViolation = (e) => e?.code === '23505';

/**
 * Hold a cross-instance lock while fn runs (fn may call slow external APIs and commit in several steps).
 * Uses a session advisory lock, so it works across multiple server instances.
 *
 * Everything fn does runs on the lock's own connection (queries, tx(), nested withLock() — session advisory
 * locks are re-entrant), so a locked operation needs exactly ONE pooled connection however deeply it nests.
 * That matters on Vercel, where each instance has a tiny pool (DB_POOL_MAX=2): booking a shipment (ship lock →
 * Shiprocket login lock → queries) used to need three connections at once and could wait forever.
 * Called inside a transaction, the lock gets its own connection (an aborted transaction couldn't unlock).
 */
export async function withLock(key, fn, { wait = true } = {}) {
  const store = als.getStore();
  const reuse = store && !store.inTx;
  const client = reuse ? store.client : await pool.connect();
  let held = false;
  let broken = false;
  try {
    if (wait) await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [String(key)]);
    else if (!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [String(key)])).rows[0].ok) return LOCK_BUSY;
    held = true;
    return reuse || store?.inTx ? await fn() : await als.run({ client, depth: 0, inTx: false }, fn);
  } catch (e) {
    if (!held) broken = true; // failed while acquiring: don't trust this connection's lock state
    throw e;
  } finally {
    if (held) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [String(key)]);
      } catch {
        broken = true; // never hand a connection that may still hold the lock back to the pool
      }
    }
    if (!reuse) client.release(broken);
  }
}
/** Returned by withLock(key, fn, { wait: false }) when another instance already holds the lock. */
export const LOCK_BUSY = Symbol('lock busy');

export const getSetting = async (k, d = null) => (await one('SELECT value FROM settings WHERE key = ?', k))?.value ?? d;
export const setSetting = (k, v) =>
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));

const migrationFiles = () => fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();

/** Migration files not yet applied to this database (read-only check). */
export async function pendingMigrations() {
  const t = await one("SELECT to_regclass('public.schema_migrations') AS t");
  if (!t?.t) return migrationFiles();
  const done = new Set((await all('SELECT name FROM schema_migrations')).map((r) => r.name));
  return migrationFiles().filter((f) => !done.has(f));
}

/** Apply supabase/migrations/*.sql in order, once each (tracked in schema_migrations). */
export async function migrate({ log = () => {} } = {}) {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const files = migrationFiles();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // one migrator at a time
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`✿ applied migration ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

export const closeDb = () => pool.end();
