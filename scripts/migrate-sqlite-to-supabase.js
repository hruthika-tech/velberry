#!/usr/bin/env node
/**
 * Copy the original Velberry SQLite database (data/velberry.db) into PostgreSQL / Supabase.
 *
 *   npm run migrate:sqlite -- --dry-run      preview: does every step inside a transaction, then ROLLS BACK (no uploads)
 *   npm run migrate:sqlite                   copy for real (one transaction: all rows or none)
 *
 * Options:
 *   --sqlite <file>      SQLite file to read (default: SQLITE_FILE or data/velberry.db)
 *   --public-dir <dir>   folder that /uploads/... image URLs are served from (default: public/)
 *   --skip-images        don't upload images to Supabase Storage, keep their current URLs
 *   --dry-run            preview only
 *   --production         required when the target is the Production project (PRODUCTION_SUPABASE_REF), dry runs too
 *   --force-into-nonempty  with --production: allow importing into a Production database that already holds data
 *
 * Target: DATABASE_URL (from the environment or .env). Images go to Supabase Storage when SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY are set (run `npm run setup-storage` first).
 *
 * Safety:
 *  • The original SQLite files are never opened: the script reads a temporary snapshot copy, and checks the
 *    originals' fingerprints (sha256) before and after.
 *  • Rows keep their primary keys, so every foreign key still points at the same record.
 *  • Nothing in PostgreSQL is overwritten. A row that already exists with identical content is skipped (so the
 *    script can be re-run safely); a row that exists with DIFFERENT content is a conflict, and the whole run is
 *    rolled back so you can decide what to do. The only exception: an image URL that still holds the exact
 *    local path this script copied earlier is pointed at its Supabase Storage copy once that upload succeeded.
 *  • Storage uploads never overwrite an object: if one already exists at the path, its bytes are compared and
 *    the URL is switched only when they match.
 *  • Image URLs are switched to Supabase only for files whose upload succeeded.
 *  • Connection strings, passwords and keys are never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const { values: opt } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'skip-images': { type: 'boolean', default: false },
    sqlite: { type: 'string' },
    'public-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    // Production safety (see server/lib/script-guard.js). The parser stays strict: "--production=yes",
    // "--Production" or any other look-alike is rejected as an error, never ignored.
    production: { type: 'boolean', default: false },
    'force-into-nonempty': { type: 'boolean', default: false },
  },
});
if (opt.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}
const DRY = opt['dry-run'];

const { config, ROOT } = await import('../server/config.js');
if (!config.db.url) fail('DATABASE_URL is not set. Put your Supabase connection string in .env (see README → Supabase).');
const { pool, closeDb } = await import('../server/db/index.js');
const storage = await import('../server/services/storage.js');

/* ───────────── 0. Production guard — before ANY database or Storage request ─────────────
 * Production (PRODUCTION_SUPABASE_REF) needs --production, for --dry-run too. Into a Production database that
 * already holds data, it additionally needs --force-into-nonempty (re-importing could resurrect deleted records). */
{
  const { guardScript, nonEmptyTables, importDecision } = await import('../server/lib/script-guard.js');
  const decision = guardScript('migrate:sqlite', opt.production ? ['--production'] : []);
  const filled = decision.production ? await nonEmptyTables(async (sql) => (await pool.query(sql)).rows[0]) : [];
  const d = importDecision({ production: Boolean(decision.production), force: opt['force-into-nonempty'], filled });
  if (!d.ok) {
    console.error(`\n✗ migrate:sqlite: ${d.message}\n`);
    await closeDb();
    process.exit(2);
  }
  if (d.message) console.log(`   ⚠ ${d.message}`);
}

/* ───────────── table plan (parents before children) ───────────── */
const TABLES = [
  ['users', 'id'], ['sessions', 'token_hash'], ['addresses', 'id'], ['categories', 'id'], ['products', 'id'],
  ['product_images', 'id'], ['product_variants', 'id'], ['inventory_movements', 'id'], ['carts', 'id'],
  ['cart_items', 'id'], ['orders', 'id'], ['order_items', 'id'], ['order_status_history', 'id'], ['payments', 'id'],
  ['refunds', 'id'], ['shipments', 'id'], ['tracking_events', 'id'], ['notifications', 'id'], ['webhook_events', 'id'],
  ['settings', 'key'],
];
/** Columns that hold image URLs: moved to Supabase Storage and compared separately. */
const IMAGE_COLS = { product_images: 'url', order_items: 'image_url', categories: 'image_url' };

const report = { errors: [], warnings: [], tables: [], images: [] };
const err = (m) => { report.errors.push(m); };
const warn = (m) => { report.warnings.push(m); };

const target = (() => { try { const u = new URL(config.db.url); return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch { return '(unparseable URL)'; } })();
console.log(`\n🍓 Velberry: SQLite → PostgreSQL${DRY ? '   [DRY RUN: nothing will be written or uploaded]' : ''}`);
console.log(`   target database: ${target}`);
console.log(`   images:          ${opt['skip-images'] ? 'skipped (--skip-images)' : storage.isRemote() ? `Supabase Storage @ ${new URL(config.supabase.url).hostname}` : 'Supabase Storage not configured → URLs kept as they are'}`);

/* ───────────── 1. snapshot the SQLite file (the original is never opened) ───────────── */
const sqliteFile = path.resolve(opt.sqlite || config.legacySqliteFile);
if (!fs.existsSync(sqliteFile)) fail(`SQLite file not found: ${sqliteFile}`);
const SIDE = ['', '-wal', '-shm'];
const fingerprint = () => SIDE.map((s) => {
  const f = sqliteFile + s;
  return fs.existsSync(f) ? `${s || 'db'}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}` : `${s || 'db'}:absent`;
}).join(' ');
const before = fingerprint();
const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velberry-migrate-'));
const snap = path.join(snapDir, 'snapshot.db');
for (const s of SIDE) if (fs.existsSync(sqliteFile + s)) fs.copyFileSync(sqliteFile + s, snap + s);
console.log(`   source:          ${sqliteFile} (reading a snapshot copy)\n`);
const lite = new DatabaseSync(snap);

const liteTables = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
for (const t of liteTables) if (!TABLES.some(([n]) => n === t)) warn(`SQLite table "${t}" is not part of the Velberry schema and was not copied`);

/* ───────────── value conversion ───────────── */
const NAIVE_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/; // SQLite datetime('now') → UTC without a zone
function toTimestamp(v) {
  if (v === null || v === undefined || v === '') return null;
  let d;
  if (typeof v === 'number') d = new Date(v > 1e11 ? v : v * 1000);
  else d = new Date(NAIVE_TS.test(v) ? `${v.replace(' ', 'T')}Z` : v);
  if (Number.isNaN(d.getTime())) throw new Error(`not a valid date: ${JSON.stringify(v)}`);
  return d.toISOString();
}
function toBool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return ['1', 'true', 't', 'yes'].includes(v.toLowerCase());
  return Boolean(Number(v));
}
function convert(type, v, ctx) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) throw new Error('binary data is not supported here');
  switch (type) {
    case 'boolean': return toBool(v);
    case 'timestamp with time zone': case 'timestamp without time zone': return toTimestamp(v);
    case 'integer': case 'bigint': case 'smallint': {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new Error(`not a whole number: ${JSON.stringify(v)}`);
      return n;
    }
    case 'jsonb': case 'json':
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { warn(`${ctx}: text was not valid JSON, kept as {"legacy_text": …}`); return { legacy_text: v }; }
    default: return typeof v === 'string' ? v : String(v);
  }
}
/** Stable comparison form (handles timestamps, JSON key order, numbers vs strings). */
function norm(type, v) {
  if (v === null || v === undefined) return 'null';
  if (type.startsWith('timestamp')) return new Date(v).toISOString();
  if (type === 'jsonb' || type === 'json') return stable(typeof v === 'string' ? JSON.parse(v) : v);
  return JSON.stringify(v);
}
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));

/* ───────────── 2. images: plan + upload (before the DB transaction; nothing is overwritten) ───────────── */
const publicDir = path.resolve(opt['public-dir'] || path.join(ROOT, 'public'));
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.gif': 'image/gif' };
const B = config.supabase.buckets;
/** local URL → { bucket, objectPath, file, ok, newUrl, note } */
const imagePlan = new Map();

function planImage(url, kind) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/') || imagePlan.has(url)) return;
  const rel = decodeURIComponent(url.split(/[?#]/)[0]).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  const entry = { url, file, ok: false, newUrl: url };
  if (!file.startsWith(publicDir + path.sep)) { entry.note = 'path escapes the public folder — skipped'; imagePlan.set(url, entry); return; }
  const m = /^uploads\/seed\/(.+)$/.exec(rel);
  // Starter artwork goes where `npm run seed` would put it (product-images/seed/…); everything else under migrated/.
  entry.objectPath = m ? `seed/${m[1]}` : `migrated/${rel.replace(/^uploads\/(products\/)?/, '')}`;
  entry.bucket = kind === 'angle' ? B.angles : kind === 'category' ? B.categories : B.products;
  entry.contentType = MIME[path.extname(file).toLowerCase()];
  if (!entry.contentType) entry.note = `unsupported file type ${path.extname(file) || '(none)'}`;
  else if (!fs.existsSync(file)) entry.note = 'file not found on disk';
  imagePlan.set(url, entry);
}
if (liteTables.has('product_images')) for (const r of lite.prepare('SELECT url, kind FROM product_images').all()) planImage(r.url, r.kind);
if (liteTables.has('order_items')) for (const r of lite.prepare('SELECT DISTINCT image_url FROM order_items').all()) planImage(r.image_url, 'gallery');
if (liteTables.has('categories') && lite.prepare("SELECT 1 FROM pragma_table_info('categories') WHERE name = 'image_url'").get()) {
  for (const r of lite.prepare('SELECT image_url FROM categories').all()) planImage(r.image_url, 'category');
}

async function uploadOne(bucket, objectPath, buffer, contentType) {
  const state = await storage.putObjectIfAbsent({ bucket, objectPath, buffer, contentType });
  if (state === 'created') return 'uploaded';
  const existing = await storage.getObject(bucket, objectPath);
  if (existing && crypto.createHash('sha256').update(existing).digest('hex') === crypto.createHash('sha256').update(buffer).digest('hex')) return 'already in Storage (identical)';
  throw new Error('a DIFFERENT file already exists at this Storage path — left untouched, local URL kept');
}

const uploadImages = !opt['skip-images'] && storage.isRemote();
for (const e of imagePlan.values()) {
  if (e.note) { warn(`image ${e.url}: ${e.note} (URL kept)`); report.images.push([e.url, `✗ ${e.note}`]); continue; }
  if (!uploadImages) { report.images.push([e.url, opt['skip-images'] ? 'kept (--skip-images)' : 'kept (Storage not configured)']); continue; }
  const target = `${e.bucket}/${e.objectPath}`;
  if (DRY) { report.images.push([e.url, `would upload → ${target}`]); e.ok = true; e.newUrl = storage.publicUrl(e.bucket, e.objectPath); continue; }
  try {
    const status = await uploadOne(e.bucket, e.objectPath, fs.readFileSync(e.file), e.contentType);
    // PNG twin of starter SVGs: emails can't show SVG and look for the .png next to it (best effort).
    const twin = e.file.replace(/\.svg$/i, '.png');
    if (twin !== e.file && fs.existsSync(twin)) {
      await uploadOne(e.bucket, e.objectPath.replace(/\.svg$/i, '.png'), fs.readFileSync(twin), 'image/png')
        .catch((x) => warn(`email PNG twin for ${e.url}: ${x.message}`));
    }
    e.ok = true;
    e.newUrl = storage.publicUrl(e.bucket, e.objectPath);
    report.images.push([e.url, `${status} → ${target}`]);
  } catch (x) {
    warn(`image ${e.url}: ${x.message}`);
    report.images.push([e.url, `✗ ${x.message}`]);
  }
}

/* ───────────── 3. copy rows inside ONE transaction ───────────── */
const client = await pool.connect();
// If the network drops the connection, PostgreSQL discards the open transaction by itself; report it, don't crash.
let connectionLost = null;
client.on('error', (e) => { connectionLost = e; });
let committed = false;
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(727001)'); // same lock as the server's migrator: never run alongside it

  // Schema: apply any supabase/migrations not yet applied (inside this transaction, so a dry run leaves no trace).
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const migDir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    await client.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    console.log(`   ✿ schema ${f} ${DRY ? 'would be applied' : 'applied'}`);
  }

  // Column types for every table in one round trip (remote databases can be ~300 ms away).
  const allTypes = new Map();
  for (const c of (await client.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`)).rows) {
    if (!allTypes.has(c.table_name)) allTypes.set(c.table_name, new Map());
    allTypes.get(c.table_name).set(c.column_name, c.data_type);
  }

  for (const [table, pk] of TABLES) {
    const started = Date.now();
    const stat = { table, source: 0, inserted: 0, same: 0, conflicts: 0, errors: 0, images: 0 };
    report.tables.push(stat);
    if (!liteTables.has(table)) { stat.note = 'not in SQLite'; continue; }

    const types = allTypes.get(table) || new Map();
    const srcCols = lite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
    const missing = srcCols.filter((c) => !types.has(c));
    if (missing.length) { err(`${table}: PostgreSQL has no column(s) ${missing.join(', ')} — their data would be lost`); stat.errors++; continue; }
    const imgCol = srcCols.includes(IMAGE_COLS[table]) ? IMAGE_COLS[table] : undefined; // older SQLite files lack categories.image_url

    const rows = lite.prepare(`SELECT * FROM "${table}" ORDER BY "${pk}"`).all();
    stat.source = rows.length;

    // Convert every row first (bad values are reported per row and that row is not sent).
    const prepared = [];
    for (const raw of rows) {
      const ref = `${table} ${pk}=${raw[pk]}`;
      try {
        const row = {};
        for (const c of srcCols) row[c] = convert(types.get(c), raw[c], `${ref}.${c}`);
        if (table === 'users' && row.email) row.email = row.email.toLowerCase();
        if (imgCol && row[imgCol] && imagePlan.get(row[imgCol])?.ok) row[imgCol] = imagePlan.get(row[imgCol]).newUrl;
        prepared.push({ raw, row, ref });
      } catch (x) { err(`${ref}: ${x.message}`); stat.errors++; }
    }
    const params = (row) => srcCols.map((c) => (types.get(c) === 'jsonb' && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
    const insertSql = (n) => `INSERT INTO ${table} (${srcCols.map((c) => `"${c}"`).join(', ')}) VALUES ${
      Array.from({ length: n }, (_, i) => `(${srcCols.map((_, j) => `$${i * srcCols.length + j + 1}`).join(', ')})`).join(', ')}
      ON CONFLICT DO NOTHING RETURNING "${pk}"`;
    const keyOf = (v) => (pk === 'id' ? Number(v) : v);

    // Insert in batches (one round trip each); nothing that already exists is touched (ON CONFLICT DO NOTHING).
    const per = Math.max(1, Math.floor(30000 / srcCols.length));
    const notInserted = [];
    for (let i = 0; i < prepared.length; i += per) {
      const chunk = prepared.slice(i, i + per);
      await client.query('SAVEPOINT b');
      try {
        const ins = await client.query(insertSql(chunk.length), chunk.flatMap((p) => params(p.row)));
        await client.query('RELEASE SAVEPOINT b');
        const got = new Set(ins.rows.map((r) => keyOf(r[pk])));
        stat.inserted += got.size;
        for (const p of chunk) if (!got.has(keyOf(p.row[pk]))) notInserted.push(p);
      } catch {
        // A row in this batch broke a rule: redo the batch row by row so the exact rows can be named.
        await client.query('ROLLBACK TO SAVEPOINT b');
        for (const p of chunk) {
          await client.query('SAVEPOINT r');
          try {
            const ins = await client.query(insertSql(1), params(p.row));
            await client.query('RELEASE SAVEPOINT r');
            if (ins.rowCount === 1) stat.inserted++; else notInserted.push(p);
          } catch (x) {
            await client.query('ROLLBACK TO SAVEPOINT r');
            // Postgres' "Failing row contains (…)" detail would print customer data (names, phones, addresses): leave it out.
            const detail = x.detail && !/^Failing row contains/i.test(x.detail) ? ` (${x.detail})` : '';
            err(`${p.ref}: ${x.message}${detail}${x.column ? ` [column ${x.column}]` : ''}`);
            stat.errors++;
          }
        }
      }
    }

    // Not inserted → something with the same key (or another unique value) is already there. Compare, never overwrite.
    const existingByKey = new Map();
    if (notInserted.length) {
      for (const r of (await client.query(`SELECT * FROM ${table} WHERE "${pk}" = ANY($1)`, [notInserted.map((p) => p.row[pk])])).rows) {
        existingByKey.set(keyOf(r[pk]), r);
      }
    }
    for (const { raw, row, ref } of notInserted) {
      const existing = existingByKey.get(keyOf(row[pk]));
      if (!existing) {
        err(`${ref}: another row already uses one of its unique values (e.g. slug, email, order number) — not copied`);
        stat.conflicts++;
        continue;
      }
      const diff = srcCols.filter((c) => c !== imgCol && norm(types.get(c), row[c]) !== norm(types.get(c), existing[c]));
      if (diff.length) {
        err(`${ref}: already exists in PostgreSQL with different ${diff.join(', ')} — left untouched`);
        stat.conflicts++;
        continue;
      }
      stat.same++;
      // Image URL: only advance our own earlier copy (exact original local path) to its uploaded Storage URL.
      if (imgCol && existing[imgCol] !== row[imgCol]) {
        if (existing[imgCol] === raw[imgCol] && row[imgCol] !== raw[imgCol]) {
          await client.query(`UPDATE ${table} SET "${imgCol}" = $1 WHERE "${pk}" = $2 AND "${imgCol}" = $3`, [row[imgCol], row[pk], raw[imgCol]]);
          stat.images++;
        } else {
          warn(`${ref}: ${imgCol} in PostgreSQL was changed since it was copied — kept PostgreSQL's value`);
        }
      }
    }
    stat.ms = Date.now() - started;
    console.log(`   … ${table.padEnd(22)} ${String(rows.length).padStart(4)} rows  ${(stat.ms / 1000).toFixed(1)}s`);

    // Identity sequences: the next new row must get an id above the copied ones (never moves a sequence backwards).
    // (Skipped in a dry run: setval is the one thing PostgreSQL does NOT undo on ROLLBACK.)
    if (pk === 'id' && stat.inserted && !DRY) {
      const seq = (await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS s`, [table])).rows[0]?.s;
      if (seq) {
        await client.query(`SELECT setval($1::regclass, m) FROM (SELECT MAX(id) AS m FROM ${table}) x,
                              (SELECT last_value, is_called FROM ${seq}) s
                            WHERE m IS NOT NULL AND (m > s.last_value OR (m = s.last_value AND NOT s.is_called))`, [seq]);
      }
    }

    // Verify: every source key is now present.
    const keys = rows.map((r) => (pk === 'id' ? Number(r[pk]) : r[pk]));
    if (keys.length && !stat.errors && !stat.conflicts) {
      const present = (await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE "${pk}" = ANY($1)`, [keys])).rows[0].n;
      if (present !== keys.length) { err(`${table}: verification failed — ${present} of ${keys.length} rows present`); stat.errors++; }
      else stat.verified = true;
    }
  }

  const failed = report.errors.length > 0;
  if (failed || DRY) await client.query('ROLLBACK');
  else { await client.query('COMMIT'); committed = true; }
} catch (x) {
  await client.query('ROLLBACK').catch(() => {});
  if (connectionLost || /terminated|ECONNRESET|socket|timeout/i.test(x.message)) {
    err(`the connection to the database was lost (${(connectionLost || x).message}). PostgreSQL discards an unfinished transaction, so nothing was written — just run the command again`);
  } else {
    err(`unexpected error: ${x.message}`);
  }
} finally {
  client.release(Boolean(connectionLost));
  await closeDb();
  lite.close();
  fs.rmSync(snapDir, { recursive: true, force: true }); // the temporary COPY only
}

/* ───────────── 4. report ───────────── */
const after = fingerprint();
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`   ${pad('table', 22)}${lpad('sqlite', 7)}${lpad(DRY ? 'would add' : 'added', 10)}${lpad('present', 9)}${lpad('conflict', 10)}${lpad('error', 7)}  check`);
console.log(`   ${'─'.repeat(75)}`);
for (const t of report.tables) {
  const check = t.note || (t.errors || t.conflicts ? '✗' : t.verified ? '✓' : t.source ? '–' : '✓ (empty)');
  console.log(`   ${pad(t.table, 22)}${lpad(t.source, 7)}${lpad(t.inserted, 10)}${lpad(t.same, 9)}${lpad(t.conflicts, 10)}${lpad(t.errors, 7)}  ${check}${t.images ? `  (${t.images} image URL${t.images > 1 ? 's' : ''} → Storage)` : ''}`);
}
const tot = report.tables.reduce((s, t) => ({ src: s.src + t.source, ins: s.ins + t.inserted, same: s.same + t.same }), { src: 0, ins: 0, same: 0 });
console.log(`   ${'─'.repeat(75)}\n   ${pad('total', 22)}${lpad(tot.src, 7)}${lpad(tot.ins, 10)}${lpad(tot.same, 9)}`);

if (report.images.length) {
  console.log(`\n   Images (${report.images.length} distinct local files referenced):`);
  for (const [u, s] of report.images) console.log(`     ${u}  ${s}`);
}
if (report.warnings.length) { console.log(`\n   ⚠ ${report.warnings.length} warning(s):`); for (const w of report.warnings) console.log(`     • ${w}`); }
if (report.errors.length) { console.log(`\n   ✗ ${report.errors.length} problem(s):`); for (const e of report.errors.slice(0, 200)) console.log(`     • ${e}`); }
if (report.errors.some((e) => /already exists in PostgreSQL|unique values/.test(e))) {
  console.log('\n   The target already holds different records with the same ids. This usually means the server was started');
  console.log('   against it first and seeded the starter catalogue / admin. Migrate into an EMPTY database (a fresh Supabase');
  console.log('   project, or drop the tables) — this script will not overwrite existing records.');
}

console.log(`\n   original SQLite files ${before === after ? 'unchanged ✓' : 'CHANGED ✗ (something else wrote to them during the run)'}`);
if (report.errors.length) console.log(`\n✗ Migration ROLLED BACK — PostgreSQL is exactly as it was.${uploadImages && !DRY ? ' (Uploaded images stay in Storage; a re-run reuses them.)' : ''}\n`);
else if (DRY) console.log('\n✓ Dry run OK — everything would copy cleanly. Nothing was written. Run again without --dry-run to migrate.\n');
else console.log(`\n✓ Migration committed: ${tot.ins} rows added, ${tot.same} already present.\n`);
process.exitCode = report.errors.length || before !== after ? 1 : committed || DRY ? 0 : 1;

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
