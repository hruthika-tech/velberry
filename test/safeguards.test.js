/**
 * Preview / Production isolation safeguards:
 *   1. Preview refuses Razorpay credentials, non-mock payments, Shiprocket booking and Resend.
 *   2. DATABASE_URL and SUPABASE_URL must belong to the same Supabase project.
 *   3. FORBIDDEN_SUPABASE_REF: Preview must name the Production project and refuses to start against it.
 *   4. db:migrate, setup-storage and seed refuse Production without an explicit --production argument.
 * Everything fails closed. Script tests use made-up project refs, so no real Supabase project is ever contacted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setupTestEnv } from './helpers/env.js';
import { databaseTarget, storageTarget, parseRefList, checkSupabaseTargets, previewProblems, scriptTarget } from '../server/lib/supabase-target.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROD = 'xxvpkrwivuzxnnizrwqm';     // the Mumbai Production project's ref (an identifier, not a credential)
const PREV = 'aaaaaaaaaaaaaaaaaaaa';     // a stand-in Preview project
const FAKE_PROD = 'pppppppppppppppppppp'; // used by the script tests so nothing real is ever reached
const PW = 'S3cretDbPassw0rd-never-printed';
const pooler = (ref, host = 'aws-0-ap-south-1.pooler.supabase.com') => `postgresql://postgres.${ref}:${PW}@${host}:5432/postgres`;
const site = (ref) => `https://${ref}.supabase.co`;

/* ───────── unit: recognising the project ───────── */

test('databaseTarget: pooler, direct and local URLs are recognised; anything ambiguous or malformed is refused', () => {
  assert.equal(databaseTarget(pooler(PROD)).ref, PROD);
  assert.equal(databaseTarget(`postgresql://postgres:${PW}@db.${PREV}.supabase.co:5432/postgres`).ref, PREV);
  assert.deepEqual(databaseTarget('postgres://postgres:x@127.0.0.1:54329/db'), { ref: null, host: '127.0.0.1', local: true });
  assert.equal(databaseTarget('postgres://u:p@db.example.com/x').ref, null, 'a non-Supabase database');
  for (const bad of [
    `postgresql://postgres:${PW}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`, // pooler user without the ref
    `postgresql://postgres.short:${PW}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${PW}@db.abc.supabase.co:5432/postgres`,
    `postgresql://postgres:${PW}@weird-supabase-host.example:5432/postgres`,
  ]) assert.throws(() => databaseTarget(bad), /can't be determined/, bad.replace(PW, '***'));
  assert.throws(() => databaseTarget('not a url'), /not a valid connection URL/);
  assert.throws(() => databaseTarget('mysql://u:p@h/x'), /must start with postgres/);
  try { databaseTarget(`postgresql://postgres:${PW}@db.abc.supabase.co/x`); } catch (e) { assert.ok(!e.message.includes(PW), 'no password in the message'); }
});

test('storageTarget and parseRefList: valid refs only', () => {
  assert.equal(storageTarget(site(PREV)).ref, PREV);
  assert.equal(storageTarget('http://127.0.0.1:4321').ref, null);
  assert.equal(storageTarget('').ref, null);
  for (const bad of ['https://x.supabase.co', 'https://PROJECTREF00000000000.supabase.co', 'https://abc.supabase.in']) assert.throws(() => storageTarget(bad), /can't be determined/, bad);
  assert.throws(() => storageTarget('::nope'), /not a valid URL/);
  assert.deepEqual(parseRefList(` ${PROD} , ${PREV} `, 'X'), [PROD, PREV]);
  assert.deepEqual(parseRefList('', 'X'), []);
  assert.throws(() => parseRefList(`${PROD},oops`, 'FORBIDDEN_SUPABASE_REF'), /FORBIDDEN_SUPABASE_REF must be/);
});

test('safeguards 2 + 3: same project for database and storage; forbidden projects refused; Preview must name one', () => {
  assert.equal(checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: site(PREV) }).dbRef, PREV);
  assert.equal(checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: '' }).dbRef, PREV, 'no storage configured');
  assert.equal(checkSupabaseTargets({ databaseUrl: 'postgres://u:p@127.0.0.1/x', supabaseUrl: 'http://127.0.0.1:9' }).dbRef, null, 'local + fake (tests)');
  assert.throws(() => checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: site(PROD) }), /belong to different Supabase projects/);
  assert.throws(() => checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: 'https://storage.example.invalid' }), /one is a Supabase project, the other is not/);
  assert.throws(() => checkSupabaseTargets({ databaseUrl: 'postgres://u:p@127.0.0.1/x', supabaseUrl: site(PROD) }), /one is a Supabase project, the other is not/);

  assert.throws(() => checkSupabaseTargets({ databaseUrl: pooler(PROD), supabaseUrl: site(PROD), forbidden: PROD }), new RegExp(`project ${PROD}, which FORBIDDEN_SUPABASE_REF lists`));
  assert.throws(() => checkSupabaseTargets({ databaseUrl: pooler(PROD), supabaseUrl: '', forbidden: `${PREV},${PROD}` }), /off-limits/);
  assert.throws(() => checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: site(PREV), requireForbidden: true }), /FORBIDDEN_SUPABASE_REF must be set on Preview/);
  assert.throws(() => checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: site(PREV), forbidden: 'not-a-ref', requireForbidden: true }), /comma-separated list/);
  assert.equal(checkSupabaseTargets({ databaseUrl: pooler(PREV), supabaseUrl: site(PREV), forbidden: PROD, requireForbidden: true }).dbRef, PREV);
});

test('safeguard 1: Preview refuses Razorpay credentials, non-mock payments, booking and Resend', () => {
  const envOf = (o) => (k) => String(o[k] ?? '').trim();
  assert.deepEqual(previewProblems(envOf({ PAYMENT_PROVIDER: 'mock' })), []);
  assert.deepEqual(previewProblems(envOf({ PAYMENT_PROVIDER: 'Mock', SHIPROCKET_ALLOW_BOOKING: 'FALSE' })), []);
  for (const pp of ['', 'razorpay', 'none']) assert.match(previewProblems(envOf({ PAYMENT_PROVIDER: pp })).join(), /PAYMENT_PROVIDER must be "mock"/);
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_MODE']) {
    assert.match(previewProblems(envOf({ PAYMENT_PROVIDER: 'mock', [k]: 'x' })).join(), new RegExp(`${k} must not be set on Preview`));
  }
  for (const v of ['true', 'TRUE', '1', 'yes']) assert.match(previewProblems(envOf({ PAYMENT_PROVIDER: 'mock', SHIPROCKET_ALLOW_BOOKING: v })).join(), /SHIPROCKET_ALLOW_BOOKING/);
  assert.match(previewProblems(envOf({ PAYMENT_PROVIDER: 'mock', RESEND_API_KEY: 're_x' })).join(), /RESEND_API_KEY must not be set/);
  const all = previewProblems(envOf({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x', SHIPROCKET_ALLOW_BOOKING: 'true', RESEND_API_KEY: 'k' }));
  assert.equal(all.length, 5, 'every problem is reported at once');
});

test('safeguard 4 (decision): Production needs --production; permission never comes from anywhere else', () => {
  const run = (o) => scriptTarget({ script: 'db:migrate', argv: [], productionRefs: PROD, ...o });
  assert.equal(run({ dbRef: null }).ok, true, 'local database');
  assert.equal(run({ dbRef: null, argv: ['--production'] }).ok, false, '--production on a non-Supabase target');
  assert.equal(run({ dbRef: PREV }).ok, true, 'another project');
  assert.match(run({ dbRef: PREV, argv: ['--production'] }).message, /not listed in PRODUCTION_SUPABASE_REF/);
  const p = run({ dbRef: PROD });
  assert.deepEqual([p.ok, p.production], [false, true]);
  assert.match(p.message, /is PRODUCTION\. Nothing was changed.*npm run db:migrate -- --production/);
  assert.equal(run({ dbRef: PROD, argv: ['--production'] }).ok, true);
  assert.equal(run({ dbRef: null, storageRef: PROD }).ok, false, 'storage-only target is recognised too');
  assert.match(run({ dbRef: PREV, productionRefs: '' }).message, /PRODUCTION_SUPABASE_REF is not set/);
  assert.match(run({ dbRef: PREV, productionRefs: 'bad' }).message, /comma-separated list/);
  assert.equal(run({ dbRef: PROD, argv: ['--production=yes'] }).ok, false, 'only the exact flag counts');
});

/* ───────── integration: the real config at startup ───────── */

function node(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'q'.repeat(40), ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const loadConfig = async (env) => {
  const r = await node(['--input-type=module', '-e', `try { const { config: c } = await import('./server/config.js');
    console.log(JSON.stringify({ ok: true, pay: c.payments.provider, booking: c.shiprocket.allowBooking, ref: c.supabase.projectRef })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`], env);
  const parsed = JSON.parse(r.out.trim().split('\n').pop());
  assert.ok(!r.out.includes(PW), 'the database password never appears in output');
  return parsed;
};
const PREVIEW = { VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', VERCEL_URL: 'clayslay-git-x.vercel.app', PAYMENT_PROVIDER: 'mock',
  DATABASE_URL: pooler(PREV), SUPABASE_URL: site(PREV), SUPABASE_SERVICE_ROLE_KEY: 'k', FORBIDDEN_SUPABASE_REF: PROD };
const PRODUCTION = { VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production', APP_URL: 'https://www.clayslay.in', DATABASE_URL: pooler(PROD),
  SUPABASE_URL: site(PROD), SUPABASE_SERVICE_ROLE_KEY: 'k', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x',
  RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', RESEND_API_KEY: 're_x', SHIPROCKET_EMAIL: 'a@b.c', SHIPROCKET_PASSWORD: 'p' };

test('Preview: a correctly isolated Preview starts (simulator, no booking); unsafe ones refuse with every reason', async () => {
  assert.deepEqual(await loadConfig(PREVIEW), { ok: true, pay: 'mock', booking: false, ref: PREV });
  const prodDb = await loadConfig({ ...PREVIEW, DATABASE_URL: pooler(PROD), SUPABASE_URL: site(PROD) });
  assert.match(prodDb.error, new RegExp(`project ${PROD}, which FORBIDDEN_SUPABASE_REF lists as off-limits`));
  assert.match((await loadConfig({ ...PREVIEW, FORBIDDEN_SUPABASE_REF: '' })).error, /FORBIDDEN_SUPABASE_REF must be set on Preview/);
  assert.match((await loadConfig({ ...PREVIEW, SUPABASE_URL: site(PROD) })).error, /different Supabase projects/);
  const unsafe = await loadConfig({ ...PREVIEW, PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', SHIPROCKET_ALLOW_BOOKING: 'true', RESEND_API_KEY: 're_x' });
  assert.match(unsafe.error, /Unsafe Preview configuration/);
  for (const k of ['PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_MODE', 'SHIPROCKET_ALLOW_BOOKING', 'RESEND_API_KEY']) assert.match(unsafe.error, new RegExp(k));
  assert.match((await loadConfig({ ...PREVIEW, RAZORPAY_KEY_ID: 'rzp_test_x' })).error, /RAZORPAY_KEY_ID must not be set on Preview/, 'test keys too');
  assert.match((await loadConfig({ ...PREVIEW, DATABASE_URL: 'garbage' })).error, /not a valid connection URL/);
});

test('Production is unaffected: live Razorpay, Resend and booking-by-default all still load', async () => {
  assert.deepEqual(await loadConfig(PRODUCTION), { ok: true, pay: 'razorpay', booking: true, ref: PROD });
  assert.equal((await loadConfig({ ...PRODUCTION, SHIPROCKET_ALLOW_BOOKING: 'false' })).booking, false);
  assert.match((await loadConfig({ ...PRODUCTION, FORBIDDEN_SUPABASE_REF: PROD })).error, /off-limits/, 'set in the wrong scope → fails loudly, never silently');
  assert.match((await loadConfig({ ...PRODUCTION, SUPABASE_URL: site(PREV) })).error, /different Supabase projects/, 'consistency applies to Production too');
});

test('local development: mismatched projects refuse; a local database with no storage is fine', async () => {
  assert.match((await loadConfig({ DATABASE_URL: pooler(PROD), SUPABASE_URL: site(PREV), SUPABASE_SERVICE_ROLE_KEY: 'k' })).error, /different Supabase projects/);
  assert.equal((await loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:54329/x' })).ok, true);
});

/* ───────── integration: the protected scripts ───────── */

const SCRIPTS = { 'db:migrate': 'scripts/db-migrate.js', 'setup-storage': 'scripts/setup-storage.js', seed: 'server/db/seed.js' };
// A made-up "production" project on a host that doesn't exist: even a guard failure couldn't reach anything real.
const FAKE_TARGET = { DATABASE_URL: pooler(FAKE_PROD, 'aws-0-nowhere.pooler.supabase.com'), SUPABASE_URL: site(FAKE_PROD), SUPABASE_SERVICE_ROLE_KEY: 'k' };

test('scripts refuse a Production target without --production — before any connection — and never accept permission from the environment', async () => {
  for (const [name, file] of Object.entries(SCRIPTS)) {
    const r = await node(['--disable-warning=ExperimentalWarning', file], { ...FAKE_TARGET, PRODUCTION_SUPABASE_REF: FAKE_PROD });
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, new RegExp(`${name}: Supabase project ${FAKE_PROD} is PRODUCTION\\. Nothing was changed`));
    assert.ok(!/ENOTFOUND|ECONNREFUSED|getaddrinfo/.test(r.out), `${name} stopped before connecting`);
    assert.ok(!r.out.includes(PW));

    const noRef = await node(['--disable-warning=ExperimentalWarning', file], FAKE_TARGET);
    assert.equal(noRef.code, 2);
    assert.match(noRef.out, /PRODUCTION_SUPABASE_REF is not set/, `${name} won't guess`);

    const viaEnv = await node(['--disable-warning=ExperimentalWarning', file], { ...FAKE_TARGET, PRODUCTION_SUPABASE_REF: FAKE_PROD, npm_config_production: 'true', PRODUCTION: '1', CONFIRM_PRODUCTION: 'yes' });
    assert.equal(viaEnv.code, 2, `${name}: environment variables never grant permission`);
  }
  const wrongFlag = await node(['scripts/db-migrate.js', '--production'], { ...FAKE_TARGET, PRODUCTION_SUPABASE_REF: PREV });
  assert.equal(wrongFlag.code, 2);
  assert.match(wrongFlag.out, /not listed in PRODUCTION_SUPABASE_REF/);
});

test('with --production the guard lets the script proceed (it then fails only because the fake host does not exist)', async () => {
  const r = await node(['--disable-warning=ExperimentalWarning', 'scripts/db-migrate.js', '--production'], { ...FAKE_TARGET, PRODUCTION_SUPABASE_REF: FAKE_PROD });
  assert.match(r.out, new RegExp(`db:migrate → target: Supabase project ${FAKE_PROD} — PRODUCTION \\(confirmed with --production\\)`));
  assert.notEqual(r.code, 2, 'not stopped by the guard');
  assert.notEqual(r.code, 0, 'the made-up host cannot be reached');
});

test('a local database needs no flag (and refuses one); migrations still apply normally', async () => {
  const env = await setupTestEnv('safeguards');
  try {
    const base = { DATABASE_URL: env.url, DATABASE_SSL: 'disable' };
    const ok = await node(['--disable-warning=ExperimentalWarning', 'scripts/db-migrate.js'], base);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /target: local \/ non-Supabase database/);
    assert.match(ok.out, /Schema up to date/);
    const flagged = await node(['scripts/db-migrate.js', '--production'], base);
    assert.equal(flagged.code, 2);
    assert.match(flagged.out, /does not target a Supabase project/);
  } finally {
    await env.drop();
  }
});
