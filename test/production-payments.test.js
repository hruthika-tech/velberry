/**
 * Production payment security:
 *  • a Vercel deployment refuses NODE_ENV=development/test (it would switch production protections off);
 *  • Vercel Production refuses the simulator, a missing provider, test mode/keys and missing secrets — all listed,
 *    no secret values printed; local development and the Preview rules are unaffected;
 *  • with Razorpay configured, a simulator-style payment can never mark an order paid;
 *  • the webhook explains (instead of "bad signature") when the host consumed the raw body.
 * Razorpay is a local fake; nothing real is called.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';
import { startFakeRazorpay } from './helpers/fake-razorpay.js';
import { productionPaymentProblems } from '../server/lib/supabase-target.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY_ID = 'rzp_test_FakeKey12345';
const KEY_SECRET = 'fake_key_secret_never_shown_9f8e7d';
const WEBHOOK_SECRET = 'fake_webhook_secret_never_shown_1a2b';
const fake = await startFakeRazorpay({ keyId: KEY_ID, keySecret: KEY_SECRET });
const env = await setupTestEnv('prodpay', {
  PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_API_BASE: `${fake.url}/v1`, ALLOW_MOCK_PAYMENTS: 'false',
});
const { one, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits } = await import('../server/lib/auth.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/index.js');

let app;
before(async () => { app = await startApp(); });
beforeEach(() => resetRateLimits());
after(async () => { await app.close(); await closeDb(); await env.drop(); await fake.close(); });
const client = () => makeClient(() => app.base);

/* ───────── startup rules (fresh processes) ───────── */

const LIVE_SECRET = 'live-secret-value-never-printed';
const PROD_OK = {
  VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'www.clayslay.in', APP_URL: 'https://www.clayslay.in',
  DATABASE_URL: 'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
  SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k',
  PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456', RAZORPAY_KEY_SECRET: LIVE_SECRET, RAZORPAY_WEBHOOK_SECRET: LIVE_SECRET,
};
function loadConfig(extra) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `try { const { config: c } = await import('./server/config.js');
      console.log(JSON.stringify({ ok: true, prod: c.isProd, pay: c.payments.provider, env: c.payments.env, mock: c.mockPayments })); }
      catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`], {
      cwd: ROOT, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'q'.repeat(40), ...extra },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      assert.ok(!out.includes(LIVE_SECRET), 'secret values never appear in output');
      resolve(JSON.parse(out.trim().split('\n').pop()));
    });
  });
}

test('a correctly configured Vercel Production loads in live mode with production protections, without NODE_ENV', async () => {
  assert.deepEqual(await loadConfig(PROD_OK), { ok: true, prod: true, pay: 'razorpay', env: 'live', mock: false });
  assert.equal((await loadConfig({ ...PROD_OK, NODE_ENV: 'production' })).ok, true);
});

test('Vercel deployments refuse NODE_ENV=development / test (Production and Preview)', async () => {
  for (const v of ['development', 'test', 'dev']) {
    assert.match((await loadConfig({ ...PROD_OK, NODE_ENV: v })).error, new RegExp(`NODE_ENV=${v} is not allowed on a Vercel production deployment`));
  }
  const preview = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'p.vercel.app', PAYMENT_PROVIDER: 'mock', FORBIDDEN_SUPABASE_REF: 'xxvpkrwivuzxnnizrwqm',
    DATABASE_URL: PROD_OK.DATABASE_URL, SUPABASE_URL: PROD_OK.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'k' };
  assert.match((await loadConfig({ ...preview, NODE_ENV: 'development' })).error, /NODE_ENV=development is not allowed on a Vercel preview deployment/);
  assert.deepEqual(await loadConfig(preview), { ok: true, prod: true, pay: 'mock', env: 'test', mock: true }, 'Preview rules unchanged (simulator, production protections)');
});

test('Vercel Production refuses the simulator, a missing provider, test mode, test keys and missing secrets', async () => {
  const cases = [
    [{ PAYMENT_PROVIDER: 'mock' }, /PAYMENT_PROVIDER=mock is not allowed on Vercel Production/],
    [{ PAYMENT_PROVIDER: 'MOCK' }, /PAYMENT_PROVIDER=mock is not allowed/],
    [{ PAYMENT_PROVIDER: '' }, /PAYMENT_PROVIDER must be set to "razorpay"/],
    [{ PAYMENT_PROVIDER: 'stripe' }, /PAYMENT_PROVIDER must be set to "razorpay"/],
    [{ ALLOW_MOCK_PAYMENTS: 'true' }, /ALLOW_MOCK_PAYMENTS must not be set/],
    [{ RAZORPAY_MODE: 'test' }, /RAZORPAY_MODE must be "live"/],
    [{ RAZORPAY_MODE: '' }, /RAZORPAY_MODE must be "live"/],
    [{ RAZORPAY_KEY_ID: 'rzp_test_AbCdEf123456' }, /RAZORPAY_KEY_ID must be a live key/],
    [{ RAZORPAY_KEY_ID: '' }, /RAZORPAY_KEY_ID must be a live key/],
    [{ RAZORPAY_KEY_SECRET: '' }, /RAZORPAY_KEY_SECRET is not set/],
    [{ RAZORPAY_WEBHOOK_SECRET: '' }, /RAZORPAY_WEBHOOK_SECRET is not set/],
  ];
  for (const [extra, re] of cases) {
    const r = await loadConfig({ ...PROD_OK, ...extra });
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.match(r.error, re);
    assert.match(r.error, /refusing to start/);
  }
  const all = await loadConfig({ ...PROD_OK, PAYMENT_PROVIDER: 'mock', RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '', ALLOW_MOCK_PAYMENTS: 'true' });
  assert.equal(all.error.split('•').length - 1, 6, 'every problem listed at once');
});

test('productionPaymentProblems names variables, never values; local development is unaffected', async () => {
  const envOf = (o) => (k) => String(o[k] ?? '').trim();
  assert.deepEqual(productionPaymentProblems(envOf(PROD_OK)), []);
  const msgs = productionPaymentProblems(envOf({ ...PROD_OK, RAZORPAY_KEY_ID: 'rzp_test_SECRETISH999' })).join(' ');
  assert.ok(!msgs.includes('SECRETISH999'));
  assert.deepEqual(await loadConfig({ PAYMENT_PROVIDER: 'mock', DATABASE_URL: 'postgres://u:p@127.0.0.1/x' }), { ok: true, prod: false, pay: 'mock', env: 'test', mock: true }, 'local simulator still works');
  assert.match((await loadConfig({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'mock', DATABASE_URL: 'postgres://u:p@127.0.0.1/x' })).error, /cannot be used in production/, 'a non-Vercel production server still refuses the simulator');
});

/* ───────── a simulated payment can never mark an order paid ───────── */

async function razorpayOrder() {
  const c = client();
  const p = await one("SELECT id FROM products WHERE slug = 'cherry-twins'");
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false WHERE id = ?', p.id);
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  return { c, o: o.data };
}

test('with Razorpay configured: no simulator endpoint, simulator signatures rejected, unknown payments never paid', async () => {
  assert.equal(config.payments.provider, 'razorpay');
  const { c, o } = await razorpayOrder();
  const row = await one('SELECT * FROM orders WHERE order_number = ?', o.orderNumber);
  assert.match(row.razorpay_order_id, /^order_/);
  assert.ok(!row.razorpay_order_id.startsWith('order_mock'));

  assert.equal((await c('POST', '/api/checkout/mock-pay', { orderNumber: o.orderNumber, accessToken: o.accessToken })).status, 404, 'simulator endpoint does not exist');

  // A response signed the way the simulator signs (with its local secret) is not a Razorpay signature.
  const mockSecret = crypto.createHash('sha256').update(`mock:${config.sessionSecret}`).digest('hex');
  const payId = `pay_mock${crypto.randomBytes(7).toString('hex')}`;
  const simSig = crypto.createHmac('sha256', mockSecret).update(`${row.razorpay_order_id}|${payId}`).digest('hex');
  const v1 = await c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, razorpay_order_id: row.razorpay_order_id, razorpay_payment_id: payId, razorpay_signature: simSig });
  assert.equal(v1.status, 400);
  assert.match(v1.data.error, /signature could not be verified/);

  // Even a correctly signed id is checked with Razorpay itself: a payment Razorpay doesn't know is never "paid".
  const realSig = crypto.createHmac('sha256', KEY_SECRET).update(`${row.razorpay_order_id}|${payId}`).digest('hex');
  const v2 = await c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, razorpay_order_id: row.razorpay_order_id, razorpay_payment_id: payId, razorpay_signature: realSig });
  assert.ok(v2.status >= 400, `unknown payment refused (${v2.status})`);

  const after = await one('SELECT status, payment_status FROM orders WHERE order_number = ?', o.orderNumber);
  assert.deepEqual([after.status, after.payment_status], ['pending_payment', 'pending']);
  assert.equal((await one("SELECT count(*)::int AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.order_number = ? AND p.status = 'captured'", o.orderNumber)).n, 0);
});

/* ───────── webhook raw body ───────── */

test('Razorpay webhook: if the host consumed the raw body, it says so clearly and processes nothing', async () => {
  const inner = createApp();
  // Simulates a platform that reads the request stream before Express does (what NODEJS_HELPERS=0 prevents).
  const srv = http.createServer(async (req, res) => { for await (const _ of req) { /* drain */ } inner(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'request body unavailable' });

    // Normal path through the real app: the same signed body is accepted.
    const ok = await fetch(`${app.base}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': `evt_${crypto.randomUUID()}` }, body });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${app.base}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': '0'.repeat(64) }, body });
    assert.equal(bad.status, 400, 'wrong signature still rejected');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
