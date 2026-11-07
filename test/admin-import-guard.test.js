/**
 * Production protection for `create-admin` and `migrate:sqlite`:
 *  • both refuse a Production target without the exact --production argument, before any database/Storage request;
 *  • look-alike flags and environment variables never authorise anything;
 *  • create-admin never touches an existing customer account without --promote-existing, and no longer migrates;
 *  • migrate:sqlite refuses a nonempty Production database without --force-into-nonempty.
 * "Production" here is a made-up project on a host that doesn't exist, so nothing real is ever contacted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { setupTestEnv } from './helpers/env.js';
import { importDecision, nonEmptyTables } from '../server/lib/supabase-target.js'; // pure: never loads config or .env

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE_PROD = 'pppppppppppppppppppp';
const FAKE_PROD_ENV = {
  DATABASE_URL: `postgresql://postgres.${FAKE_PROD}:pw@aws-0-nowhere.pooler.supabase.com:5432/postgres`,
  SUPABASE_URL: `https://${FAKE_PROD}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'k', PRODUCTION_SUPABASE_REF: FAKE_PROD,
};
const NETWORK = /ENOTFOUND|ECONNREFUSED|getaddrinfo|EAI_AGAIN/;

function run(file, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'q'.repeat(40), ...env },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const admin = (args, env) => run('scripts/create-admin.js', args, env);
const importer = (args, env) => run('scripts/migrate-sqlite-to-supabase.js', args, env);
const ADMIN_ARGS = ['new-admin@example.com', 'a-strong-password-1', 'Owner'];

/* ───────── refusals before any request ───────── */

test('Production without --production: both scripts refuse before any request (dry runs included)', async () => {
  for (const [label, r] of [
    ['create-admin', await admin(ADMIN_ARGS, FAKE_PROD_ENV)],
    ['migrate:sqlite', await importer([], FAKE_PROD_ENV)],
    ['migrate:sqlite --dry-run', await importer(['--dry-run'], FAKE_PROD_ENV)],
  ]) {
    assert.equal(r.code, 2, `${label}: ${r.out}`);
    assert.match(r.out, new RegExp(`Supabase project ${FAKE_PROD} is PRODUCTION\\. Nothing was changed`), label);
    assert.ok(!NETWORK.test(r.out), `${label} made no connection attempt`);
  }
  for (const r of [await admin(ADMIN_ARGS, { ...FAKE_PROD_ENV, PRODUCTION_SUPABASE_REF: '' }), await importer([], { ...FAKE_PROD_ENV, PRODUCTION_SUPABASE_REF: '' })]) {
    assert.equal(r.code, 2);
    assert.match(r.out, /PRODUCTION_SUPABASE_REF is not set/);
  }
});

test('look-alike flags and environment variables never authorise Production', async () => {
  const env = { ...FAKE_PROD_ENV, npm_config_production: 'true', PRODUCTION: '1', CONFIRM_PRODUCTION: 'yes' };
  const lookAlikes = ['--production=yes', '--production=true', '--Production', '--PRODUCTION', '--prod', '-production', '—production', '--production-ok'];
  for (const flag of lookAlikes) {
    for (const r of [await admin([...ADMIN_ARGS, flag], FAKE_PROD_ENV), await importer([flag], FAKE_PROD_ENV)]) {
      assert.notEqual(r.code, 0, flag);
      assert.ok(!/confirmed with --production/.test(r.out), `${flag} must not authorise`);
      assert.ok(!NETWORK.test(r.out), `${flag}: refused before any connection`);
    }
  }
  for (const r of [await admin(ADMIN_ARGS, env), await importer([], env)]) {
    assert.equal(r.code, 2, 'environment variables are ignored');
    assert.match(r.out, /is PRODUCTION\. Nothing was changed/);
  }
});

test('the exact --production lets both guards pass (they then fail only on the made-up host)', async () => {
  const a = await admin([...ADMIN_ARGS, '--production'], FAKE_PROD_ENV);
  assert.match(a.out, new RegExp(`create-admin → target: Supabase project ${FAKE_PROD} — PRODUCTION \\(confirmed with --production\\)`));
  assert.ok(NETWORK.test(a.out), 'reached the database step');
  const m = await importer(['--production', '--dry-run'], FAKE_PROD_ENV);
  assert.match(m.out, /migrate:sqlite → target: .* PRODUCTION \(confirmed with --production\)/);
  assert.ok(NETWORK.test(m.out), 'next step is the read-only nonempty check');
  assert.ok(!/Migration committed|Dry run OK|schema .* applied/.test(m.out));
});

/* ───────── nonempty Production ───────── */

test('importDecision + nonEmptyTables: a nonempty Production database needs --force-into-nonempty', async () => {
  assert.match(importDecision({ production: true, force: false, filled: ['users', 'orders'] }).message, /Production already holds data \(users, orders\)\. Nothing was changed/);
  assert.equal(importDecision({ production: true, force: false, filled: ['orders'] }).ok, false);
  const forced = importDecision({ production: true, force: true, filled: ['orders'] });
  assert.equal(forced.ok, true);
  assert.match(forced.message, /confirmed with --force-into-nonempty/);
  assert.deepEqual(importDecision({ production: true, force: false, filled: [] }), { ok: true, message: null }, 'empty Production');
  assert.equal(importDecision({ production: false, force: false, filled: ['orders'] }).ok, true, 'local / non-Production: unchanged behaviour');
  assert.match(importDecision({ production: false, force: true, filled: [] }).message, /only applies to a Production import/);

  const env = await setupTestEnv('importguard');
  const c = new pg.Client({ connectionString: env.url });
  await c.connect();
  try {
    const q = async (sql) => (await c.query(sql)).rows[0];
    assert.deepEqual(await nonEmptyTables(q), [], 'no tables yet');
    assert.equal((await run('scripts/db-migrate.js', [], { DATABASE_URL: env.url, DATABASE_SSL: 'disable' })).code, 0);
    assert.deepEqual(await nonEmptyTables(q), [], 'schema but no data');
    await c.query("INSERT INTO users(email, password_hash, name) VALUES ('a@example.com', 'x', 'A')");
    await c.query("INSERT INTO categories(slug, name) VALUES ('c', 'C')");
    assert.deepEqual(await nonEmptyTables(q), ['users', 'categories']);
  } finally {
    await c.end();
    await env.drop();
  }
});

test('migrate:sqlite: --force-into-nonempty without --production is refused before reading anything', async () => {
  const env = await setupTestEnv('importflag');
  try {
    const r = await importer(['--force-into-nonempty', '--dry-run'], { DATABASE_URL: env.url, DATABASE_SSL: 'disable' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /only applies to a Production import/);
    assert.ok(!/source:/.test(r.out), 'stopped before the SQLite snapshot');
  } finally {
    await env.drop();
  }
});

/* ───────── create-admin on a local database ───────── */

test('create-admin locally: new admin created; an existing customer is untouched without --promote-existing; no migrations', async () => {
  const env = await setupTestEnv('createadmin');
  const local = { DATABASE_URL: env.url, DATABASE_SSL: 'disable' };
  const c = new pg.Client({ connectionString: env.url });
  await c.connect();
  try {
    // No automatic migrate(): on an empty database it explains what to do and changes nothing.
    const fresh = await admin(ADMIN_ARGS, local);
    assert.equal(fresh.code, 1);
    assert.match(fresh.out, /users table does not exist yet — run `npm run db:migrate` first/);
    assert.equal((await c.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t, null, 'no schema was created');

    assert.equal((await run('scripts/db-migrate.js', [], local)).code, 0);
    const made = await admin(ADMIN_ARGS, local);
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /Admin new-admin@example\.com created/);
    assert.equal((await c.query("SELECT role FROM users WHERE email = 'new-admin@example.com'")).rows[0].role, 'admin');

    await c.query("INSERT INTO users(email, password_hash, name, role) VALUES ('customer@example.com', 'original-hash', 'Asha', 'customer')");
    const refused = await admin(['customer@example.com', 'another-password-1'], local);
    assert.equal(refused.code, 2);
    assert.match(refused.out, /existing CUSTOMER account\. Nothing was changed.*--promote-existing/s);
    assert.deepEqual((await c.query("SELECT role, password_hash FROM users WHERE email = 'customer@example.com'")).rows[0], { role: 'customer', password_hash: 'original-hash' });

    const promoted = await admin(['customer@example.com', '--promote-existing', 'another-password-1'], local); // flag anywhere
    assert.equal(promoted.code, 0, promoted.out);
    const after = (await c.query("SELECT role, password_hash FROM users WHERE email = 'customer@example.com'")).rows[0];
    assert.equal(after.role, 'admin');
    assert.notEqual(after.password_hash, 'original-hash');

    const before = (await c.query("SELECT password_hash FROM users WHERE email = 'new-admin@example.com'")).rows[0].password_hash;
    assert.equal((await admin(['new-admin@example.com', 'a-new-password-22'], local)).code, 0, 'an existing admin can reset its password');
    assert.notEqual((await c.query("SELECT password_hash FROM users WHERE email = 'new-admin@example.com'")).rows[0].password_hash, before);

    const flagged = await admin(['--production', 'x@example.com', 'a-strong-password-1'], local);
    assert.equal(flagged.code, 2, '--production is a flag, never the email — and a local database is not Production');
    assert.match(flagged.out, /does not target a Supabase project/);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM users WHERE email IN ('--production', 'x@example.com')")).rows[0].n, 0);

    assert.equal((await admin(['too@many.com', 'a-strong-password-1', 'Name', 'extra'], local)).code, 1, 'stray arguments are rejected');
  } finally {
    await c.end();
    await env.drop();
  }
});
