/**
 * Database pool configuration and the Vercel attachDatabasePool integration (Stage 1 of the connection-exhaustion
 * fix). Each case runs in a fresh Node process so the pool is created exactly as it would be on that host.
 * The release mechanism is exercised against the local test Postgres with a simulated Vercel request context
 * (the same global hook Vercel provides); real Vercel suspension can only be observed on a deployment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ADMIN_URL } from './helpers/env.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', DATABASE_URL: ADMIN_URL, DATABASE_SSL: 'disable', SESSION_SECRET: 'q'.repeat(40) };
const VERCEL_PREVIEW = { VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', VERCEL_URL: 'x.vercel.app', PAYMENT_PROVIDER: 'mock',
  SUPABASE_URL: 'https://storage.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k', FORBIDDEN_SUPABASE_REF: 'xxvpkrwivuzxnnizrwqm' };

function child(code, extra = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...BASE, ...extra } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (exit) => {
      const last = out.trim().split('\n').pop();
      try { resolve({ exit, ...JSON.parse(last) }); } catch { resolve({ exit, error: out }); }
    });
  });
}
const SETTINGS = `const { pool, closeDb } = await import('./server/db/index.js');
  console.log(JSON.stringify({ max: pool.options.max, idle: pool.options.idleTimeoutMillis, releaseListeners: pool.listenerCount('release') }));
  await closeDb();`;

test('local development: one pool of 3, 30 s idle timeout, Vercel hook not attached', async () => {
  assert.deepEqual(await child(SETTINGS), { exit: 0, max: 3, idle: 30000, releaseListeners: 0 });
});

test('Vercel: pool of 2, 5 s idle timeout, attachDatabasePool listening for releases (Preview and Production)', async () => {
  assert.deepEqual(await child(SETTINGS, VERCEL_PREVIEW), { exit: 0, max: 2, idle: 5000, releaseListeners: 1 });
  const prod = { ...VERCEL_PREVIEW, VERCEL_ENV: 'production', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x',
    RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', APP_URL: 'https://www.clayslay.in' };
  assert.deepEqual(await child(SETTINGS, prod), { exit: 0, max: 2, idle: 5000, releaseListeners: 1 });
});

test('DB_POOL_MAX / DB_IDLE_TIMEOUT_MS can be set explicitly; nonsense values stop the server at startup', async () => {
  assert.deepEqual(await child(SETTINGS, { ...VERCEL_PREVIEW, DB_POOL_MAX: '4', DB_IDLE_TIMEOUT_MS: '8000' }), { exit: 0, max: 4, idle: 8000, releaseListeners: 1 });
  assert.match((await child(SETTINGS, { DB_POOL_MAX: '0' })).error, /DB_POOL_MAX must be a whole number/);
  assert.match((await child(SETTINGS, { DB_POOL_MAX: 'ten' })).error, /DB_POOL_MAX must be a whole number/);
  assert.match((await child(SETTINGS, { DB_IDLE_TIMEOUT_MS: '50' })).error, /DB_IDLE_TIMEOUT_MS must be/);
});

test('exactly one pg.Pool in the application — every route, webhook and cron job shares it', () => {
  const files = ['server', 'api'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).map((f) => path.join(ROOT, d, String(f)))).filter((f) => f.endsWith('.js'));
  const creators = files.filter((f) => /new\s+pg\.(Pool|Client)\(|new\s+(Pool|Client)\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(creators.map((f) => path.relative(ROOT, f).split(path.sep).join('/')), ['server/db/index.js']);
});

test('on Vercel, each released connection keeps the instance alive (waitUntil) until pg has closed it — query, tx and withLock paths', async () => {
  const r = await child(`
    const waits = [];
    globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (p) => waits.push(p) }) };
    const pg = (await import('pg')).default;
    const { pool, one, tx, withLock, closeDb } = await import('./server/db/index.js');
    const t0 = Date.now();
    const pid = (await one('SELECT pg_backend_pid() AS pid')).pid;           // plain query → release
    await tx(async () => one('SELECT 1'));                                       // transaction → release
    await withLock('pool-test', async () => tx(async () => one('SELECT 2')));   // session lock + nested tx → one release
    const afterWork = { waits: waits.length, total: pool.totalCount, idle: pool.idleCount };
    await Promise.all(waits);                                                    // what Vercel waits for before suspending
    const waited = Date.now() - t0;
    const afterWait = { total: pool.totalCount, idle: pool.idleCount };
    const probe = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await probe.connect();
    const still = (await probe.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].n;
    await probe.end();
    const again = (await one('SELECT 3 AS n')).n;                                // the pool reconnects on demand
    await closeDb();
    console.log(JSON.stringify({ afterWork, afterWait, waited, serverSessionGone: still === 0, again }));
  `, { ...VERCEL_PREVIEW, VERCEL_REGION: 'bom1', DB_IDLE_TIMEOUT_MS: '1000' });
  assert.equal(r.exit, 0, r.error);
  assert.ok(r.afterWork.waits >= 3, `waitUntil called on every release (got ${r.afterWork.waits})`);
  assert.ok(r.afterWork.total >= 1 && r.afterWork.total <= 2, 'never more than DB_POOL_MAX connections');
  assert.deepEqual(r.afterWait, { total: 0, idle: 0 }, 'by the time the instance may suspend, the pool holds no connections');
  assert.ok(r.waited >= 1000 && r.waited < 4000, `kept alive ≈ idle timeout + 100 ms (waited ${r.waited} ms)`);
  assert.equal(r.serverSessionGone, true, 'the Postgres session really closed');
  assert.equal(r.again, 3);
});

test('outside a Vercel deployment (no VERCEL_URL/VERCEL_REGION) the hook never calls waitUntil', async () => {
  const r = await child(`
    const waits = [];
    globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (p) => waits.push(p) }) };
    const { one, closeDb } = await import('./server/db/index.js');
    await one('SELECT 1');
    await closeDb();
    console.log(JSON.stringify({ waits: waits.length }));
  `);
  assert.deepEqual(r, { exit: 0, waits: 0 });
});
