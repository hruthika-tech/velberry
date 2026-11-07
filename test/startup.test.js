/**
 * Local server startup (`npm start`): Production is never migrated or seeded without `--production`;
 * a local database starts exactly as before. Vercel's entry (api/index.js) never migrates — see vercel.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { setupTestEnv } from './helpers/env.js';
import { startupPlan, prepareDatabase, StartupRefused } from '../server/db/startup.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE_PROD = 'pppppppppppppppppppp'; // made-up project on a host that doesn't exist — nothing real is ever reached
const OTHER = 'aaaaaaaaaaaaaaaaaaaa';

function fakeDb({ pending = [] } = {}) {
  const calls = [];
  return {
    calls,
    db: {
      migrate: async () => { calls.push('migrate'); },
      ensureAdmin: async () => { calls.push('ensureAdmin'); },
      seedCatalog: async () => { calls.push('seedCatalog'); return false; },
      pendingMigrations: async () => { calls.push('pendingMigrations'); return pending; },
    },
  };
}
const plan = (o) => startupPlan({ argv: [], dbRef: null, storageRef: null, productionRefs: FAKE_PROD, ...o });
const quiet = () => {};

test('startup plan: who may write at startup', () => {
  assert.equal(plan({}).write, true, 'local database');
  assert.equal(plan({ dbRef: OTHER }).write, true, 'a non-Production project');
  assert.equal(plan({ dbRef: FAKE_PROD }).write, false, 'Production without --production');
  assert.match(plan({ dbRef: FAKE_PROD }).message, /PRODUCTION — not running migrations or seeding automatically/);
  assert.deepEqual([plan({ dbRef: FAKE_PROD, argv: ['--production'] }).write, plan({ dbRef: FAKE_PROD, argv: ['--production'] }).production], [true, true]);
  assert.equal(plan({ dbRef: OTHER, productionRefs: '' }).write, false, 'unknown whether Production → treated as Production');
  assert.match(plan({ dbRef: OTHER, argv: ['--production'] }).refuse, /not listed in PRODUCTION_SUPABASE_REF/);
  assert.match(plan({ argv: ['--production'] }).refuse, /does not target a Supabase project/);
  assert.equal(plan({ dbRef: FAKE_PROD, argv: ['--production=true'] }).write, false, 'only the exact flag counts');
});

test('prepareDatabase: the guard runs before the first migration request', async () => {
  let f = fakeDb();
  assert.deepEqual(await prepareDatabase({ plan: plan({}), db: f.db, log: quiet }), { migrated: true, seeded: false });
  assert.deepEqual(f.calls, ['migrate', 'ensureAdmin', 'seedCatalog'], 'local: as before');

  f = fakeDb();
  assert.deepEqual(await prepareDatabase({ plan: plan({ dbRef: FAKE_PROD }), db: f.db, log: quiet }), { migrated: false, seeded: false });
  assert.deepEqual(f.calls, ['pendingMigrations'], 'Production without the flag: one read-only check, nothing written');

  f = fakeDb({ pending: ['005_new.sql'] });
  await assert.rejects(prepareDatabase({ plan: plan({ dbRef: FAKE_PROD }), db: f.db, log: quiet }), (e) => e instanceof StartupRefused && /005_new\.sql.*Nothing was changed/.test(e.message));
  assert.deepEqual(f.calls, ['pendingMigrations'], 'pending migrations are reported, never applied');

  f = fakeDb({ pending: ['005_new.sql'] });
  await prepareDatabase({ plan: plan({ dbRef: FAKE_PROD, argv: ['--production'] }), db: f.db, log: quiet });
  assert.deepEqual(f.calls, ['migrate', 'ensureAdmin', 'seedCatalog'], 'explicit --production authorises them');

  f = fakeDb();
  await assert.rejects(prepareDatabase({ plan: plan({ dbRef: OTHER, argv: ['--production'] }), db: f.db, log: quiet }), StartupRefused);
  assert.deepEqual(f.calls, [], 'a mismatched flag stops before any request');
});

/* ───────── the real server process ───────── */

function startServer(args, env, { until = /is open at/, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js', ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'q'.repeat(40),
        PAYMENT_PROVIDER: 'mock', PORT: '0', ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'test-password-123', ...env },
    });
    let out = '';
    let opened = false;
    const done = (code) => resolve({ code, out, opened });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const onData = (d) => {
      out += d;
      if (!opened && until.test(out)) { opened = true; p.kill(); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => { clearTimeout(timer); done(code); });
  });
}
const FAKE_PROD_ENV = {
  DATABASE_URL: `postgresql://postgres.${FAKE_PROD}:pw@aws-0-nowhere.pooler.supabase.com:5432/postgres`,
  SUPABASE_URL: `https://${FAKE_PROD}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'k', PRODUCTION_SUPABASE_REF: FAKE_PROD,
};

test('npm start on a local database: migrates and opens exactly as before; --production is refused there', async () => {
  const env = await setupTestEnv('startup');
  try {
    const base = { DATABASE_URL: env.url, DATABASE_SSL: 'disable' };
    const r = await startServer([], base);
    assert.equal(r.opened, true, r.out);
    assert.match(r.out, /startup → target: local \/ non-Supabase database/);
    assert.match(r.out, /applied migration 004_todays_special\.sql/);
    const c = new pg.Client({ connectionString: env.url });
    await c.connect();
    assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 4);
    await c.end();

    const flagged = await startServer(['--production'], base);
    assert.equal(flagged.opened, false);
    assert.equal(flagged.code, 2);
    assert.match(flagged.out, /Not starting: --production was given, but this start run does not target a Supabase project/);
  } finally {
    await env.drop();
  }
});

test('npm start against Production without --production writes nothing — and no environment variable changes that', async () => {
  for (const extra of [{}, { npm_config_production: 'true', PRODUCTION: '1', ALLOW_PRODUCTION_MIGRATIONS: 'true' }]) {
    const r = await startServer([], { ...FAKE_PROD_ENV, ...extra });
    assert.match(r.out, new RegExp(`startup → Supabase project ${FAKE_PROD} is \\(or may be\\) PRODUCTION — not running migrations or seeding automatically`));
    assert.ok(!/applied migration|Starter catalogue seeded/.test(r.out));
    assert.equal(r.opened, false, 'the made-up host is unreachable, so the read-only check fails and it does not open');
    assert.notEqual(r.code, 0);
  }
  const unknown = await startServer([], { ...FAKE_PROD_ENV, PRODUCTION_SUPABASE_REF: '' });
  assert.match(unknown.out, /is \(or may be\) PRODUCTION/, 'PRODUCTION_SUPABASE_REF unset → assume it might be');
});

test('npm start -- --production is the only thing that authorises migrating Production', async () => {
  const r = await startServer(['--production'], FAKE_PROD_ENV);
  assert.match(r.out, new RegExp(`startup → target: Supabase project ${FAKE_PROD} — PRODUCTION \\(confirmed with --production\\)`));
  assert.notEqual(r.code, 0, 'then fails only because the made-up host does not exist');
});
