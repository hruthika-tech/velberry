/**
 * Razorpay Standard Checkout — server-side order creation, verification, webhooks, failures, retries and
 * reconciliation, with PAYMENT_PROVIDER=razorpay against a local fake of the Razorpay API (no real charges).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';
import { startFakeRazorpay } from './helpers/fake-razorpay.js';

const KEY_ID = 'rzp_test_FakeKey12345';
const KEY_SECRET = 'fake_key_secret_never_shown_9f8e7d';
const WEBHOOK_SECRET = 'fake_webhook_secret_never_shown_1a2b';
const fake = await startFakeRazorpay({ keyId: KEY_ID, keySecret: KEY_SECRET });
const env = await setupTestEnv('razorpay', {
  PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_API_BASE: `${fake.url}/v1`, ALLOW_MOCK_PAYMENTS: 'false',
});
const { one, all, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits } = await import('../server/lib/auth.js');
const { expireStaleCheckouts, transition } = await import('../server/services/orders.js');
const razorpay = await import('../server/services/razorpay.js');

let app;
before(async () => { app = await startApp(); });
beforeEach(() => { resetRateLimits(); fake.state.holdCapture = false; });
after(async () => { await app.close(); await closeDb(); await env.drop(); await fake.close(); });

const ROOT = path.resolve(import.meta.dirname, '..');
const client = () => makeClient(() => app.base);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const productBySlug = (slug) => one('SELECT * FROM products WHERE slug = ?', slug);
const orderRow = (n) => one('SELECT * FROM orders WHERE order_number = ?', n);

/** Put a product in a fresh bag and start checkout. */
async function checkout(slug = 'cherry-twins', qty = 1, { c = client(), key = crypto.randomUUID(), extra = {} } = {}) {
  const p = await productBySlug(slug);
  await run('UPDATE products SET stock = GREATEST(stock, 20), sold_out = false WHERE id = ?', p.id);
  await c('POST', '/api/cart/items', { productId: p.id, quantity: qty });
  const r = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key, ...extra });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  return { c, o: r.data, product: p };
}
const verify = (c, o, resp) => c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, ...resp });

function webhook(event, entity, { id = `evt_${crypto.randomUUID()}`, secret = WEBHOOK_SECRET, raw } = {}) {
  const body = raw ?? JSON.stringify({ entity: 'event', event, payload: { payment: { entity }, ...(event === 'order.paid' ? { order: { entity: { id: entity.order_id, status: 'paid' } } } : {}) }, created_at: Math.floor(Date.now() / 1000) });
  return fetch(`${app.base}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': id, 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(body).digest('hex') },
    body,
  });
}
const counts = async (orderId) => one(`SELECT
  (SELECT count(*) FROM payments WHERE order_id = $1)::int AS payments,
  (SELECT count(*) FROM order_status_history WHERE order_id = $1 AND to_status = 'paid' AND from_status IS DISTINCT FROM 'paid')::int AS paid_once,
  (SELECT count(*) FROM notifications WHERE order_id = $1 AND type = 'order_confirmed')::int AS emails,
  (SELECT count(*) FROM inventory_movements WHERE order_id = $1)::int AS movements`.replace(/\$1/g, '?'), orderId, orderId, orderId, orderId);

/* ───────── configuration & secrets ───────── */

test('Razorpay test mode is explicit; only the public Key ID reaches the browser; the simulator is off', async () => {
  const cfg = (await client()('GET', '/api/config')).data;
  assert.equal(cfg.paymentMode, 'razorpay');
  assert.equal(cfg.paymentEnv, 'test');
  assert.equal(cfg.razorpayKeyId, KEY_ID);
  const { o } = await checkout();
  for (const payload of [cfg, o]) {
    const s = JSON.stringify(payload);
    assert.ok(!s.includes(KEY_SECRET) && !s.includes(WEBHOOK_SECRET), 'no secret in API responses');
  }
  assert.equal((await client()('POST', '/api/checkout/mock-pay', { orderNumber: o.orderNumber, accessToken: o.accessToken })).status, 404, 'simulator unavailable');
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' });
  const integ = (await admin('GET', '/api/admin/integrations')).data;
  assert.equal(integ.payments.mode, 'razorpay');
  assert.equal(integ.payments.env, 'test');
  assert.ok(!JSON.stringify(integ).includes(KEY_SECRET) && !JSON.stringify(integ).includes(WEBHOOK_SECRET));
});

function configIn(envOverrides) {
  const code = `const { config } = await import('./server/config.js'); const r = await import('./server/services/razorpay.js');
    console.log(JSON.stringify({ mode: r.mode(), env: r.environment(), problem: r.problem() }));`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'x'.repeat(40), ...envOverrides },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code2) => resolve({ code: code2, out, json: (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } })() }));
  });
}

test('misconfigured Razorpay is disabled with a reason — never a silent fallback to the simulator', async () => {
  let r = await configIn({ PAYMENT_PROVIDER: 'razorpay', ALLOW_MOCK_PAYMENTS: 'true' });
  assert.equal(r.json.mode, 'disabled');
  assert.match(r.json.problem, /RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required/);
  r = await configIn({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 's' });
  assert.equal(r.json.mode, 'disabled');
  assert.match(r.json.problem, /not a live key/);
  r = await configIn({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 's' });
  assert.match(r.json.problem, /RAZORPAY_WEBHOOK_SECRET is required in live mode/);
  r = await configIn({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' });
  assert.deepEqual([r.json.mode, r.json.env, r.json.problem], ['razorpay', 'live', null]);
  r = await configIn({ PAYMENT_PROVIDER: 'paypal' });
  assert.match(r.json.problem, /must be "razorpay" or "mock"/);
  r = await configIn({ PAYMENT_PROVIDER: 'mock' });
  assert.equal(r.json.mode, 'mock');
  r = await configIn({ ALLOW_MOCK_PAYMENTS: 'true' });
  assert.equal(r.json.mode, 'mock', 'unset provider keeps the old local-development behaviour');
  r = await configIn({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'razorpay' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Payments are misconfigured/);
  r = await configIn({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'mock' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /cannot be used in production/);
  const liveOk = { NODE_ENV: 'production', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc',
    RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', SUPABASE_URL: 'https://storage.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  for (const APP_URL of [undefined, 'http://velberry.example', 'https://localhost:3000']) {
    r = await configIn({ ...liveOk, ...(APP_URL ? { APP_URL } : {}) });
    assert.notEqual(r.code, 0, `production must refuse APP_URL=${APP_URL}`);
    assert.match(r.out, /APP_URL must be the public https/);
  }
  r = await configIn({ ...liveOk, APP_URL: 'https://velberry.example', SESSION_SECRET: 'change-me-to-a-long-random-string-0123456789' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /SESSION_SECRET is still the placeholder/);
  r = await configIn({ ...liveOk, APP_URL: 'https://velberry.example' });
  assert.deepEqual([r.code, r.json?.mode, r.json?.env], [0, 'razorpay', 'live'], r.out);
});

/* ───────── order creation ───────── */

test('the Razorpay order is created on the server for the server-calculated amount, in paise, INR', async () => {
  const before = fake.orders.size;
  const p = await productBySlug('cherry-twins');
  const { o } = await checkout('cherry-twins', 2, { extra: { total: 1, amount: 1, price: 1 } }); // client-supplied totals are ignored
  const row = await orderRow(o.orderNumber);
  const expectedSubtotal = p.price * 2;
  assert.equal(row.subtotal, expectedSubtotal);
  assert.equal(row.total, row.subtotal + row.shipping_fee);
  assert.ok(Number.isInteger(row.total) && row.total > 100, 'integer paise');
  assert.equal(fake.orders.size, before + 1);
  const ro = fake.orders.get(o.razorpayOrderId);
  assert.deepEqual([ro.amount, ro.currency, ro.receipt], [row.total, 'INR', o.orderNumber]);
  assert.equal(row.razorpay_order_id, o.razorpayOrderId, 'Razorpay order id stored against the internal order');
  assert.deepEqual([o.amount, o.currency, o.razorpayKeyId, o.paymentMode], [row.total, 'INR', KEY_ID, 'razorpay']);
  assert.equal(o.prefill.email, customer.email);
});

test('the same checkout sent 6 times at once → one internal order and ONE Razorpay order', async () => {
  const c = client();
  const p = await productBySlug('daisy-dream');
  await run('UPDATE products SET stock = 20 WHERE id = ?', p.id);
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const key = crypto.randomUUID();
  const before = fake.orders.size;
  const rs = await Promise.all(Array.from({ length: 6 }, () => c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.data.orderNumber)).size, 1);
  assert.equal(new Set(rs.map((r) => r.data.razorpayOrderId)).size, 1);
  assert.equal(fake.orders.size, before + 1, 'Razorpay was asked for exactly one order');
});

/* ───────── verification ───────── */

test('valid signature + captured payment → paid once; repeated verification changes nothing', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId, { method: 'card' });
  const r = await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.paymentStatus, 'paid');
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status], ['paid', 'paid']);
  const pay = await one('SELECT * FROM payments WHERE provider_payment_id = ?', payId);
  assert.deepEqual([pay.status, pay.amount, pay.method, pay.provider_order_id], ['captured', row.total, 'card', o.razorpayOrderId]);
  const stored = JSON.stringify(pay.raw);
  for (const secret of ['customer@example.com', '9876543210', 'customer@okbank', '1111', 'Asha Rao']) assert.ok(!stored.includes(secret), `personal detail "${secret}" not stored`);
  assert.equal(pay.raw.card_network, 'Visa');
  await wait(300);
  const first = await counts(row.id);
  for (let i = 0; i < 3; i++) assert.equal((await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId))).status, 200);
  await wait(300);
  assert.deepEqual(await counts(row.id), first, 'no duplicate payments, history, emails or stock movements');
  assert.deepEqual([first.payments, first.paid_once, first.emails], [1, 1, 1]);
});

test('invalid or malformed signatures are refused and the order stays unpaid', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  const good = fake.checkoutResponse(o.razorpayOrderId, payId);
  for (const bad of [{ ...good, razorpay_signature: 'a'.repeat(64) }, { ...good, razorpay_signature: 'not-hex' }, { ...good, razorpay_signature: undefined },
    { ...good, razorpay_payment_id: 'pay_<script>' }]) {
    assert.equal((await verify(c, o, bad)).status, 400);
  }
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'pending');
});

test('another order\'s Razorpay order id or payment cannot settle this order', async () => {
  const a = await checkout();
  const b = await checkout('bunny-bun');
  const payB = fake.pay(b.o.razorpayOrderId);
  // browser claims B's Razorpay order for order A
  assert.equal((await verify(a.c, a.o, fake.checkoutResponse(b.o.razorpayOrderId, payB))).status, 403);
  // B's genuine payment+signature, sent for order A without an order id: the signature is checked against A's stored id
  const { razorpay_order_id: _ignored, ...noOrder } = fake.checkoutResponse(b.o.razorpayOrderId, payB);
  assert.equal((await verify(a.c, a.o, noOrder)).status, 400);
  // a signature forged for A's order id over B's payment: Razorpay says the payment belongs to B
  assert.equal((await verify(a.c, a.o, fake.checkoutResponse(a.o.razorpayOrderId, payB))).status, 403);
  // customer A cannot use their access token on order B
  assert.equal((await a.c('POST', '/api/checkout/verify', { orderNumber: b.o.orderNumber, accessToken: a.o.accessToken, ...fake.checkoutResponse(b.o.razorpayOrderId, payB) })).status, 404);
  assert.equal((await orderRow(a.o.orderNumber)).payment_status, 'pending');
  assert.equal((await orderRow(b.o.orderNumber)).payment_status, 'pending');
});

test('wrong amount or wrong currency is never marked paid', async () => {
  const { c, o } = await checkout();
  const short = fake.pay(o.razorpayOrderId, { amount: o.amount - 100 });
  let r = await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, short));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /amount mismatch/);
  const usd = fake.pay(o.razorpayOrderId, { currency: 'USD' });
  r = await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, usd));
  assert.equal(r.status, 400);
  const row = await orderRow(o.orderNumber);
  assert.equal(row.payment_status, 'pending');
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND note LIKE '%NOT marked paid%'", row.id), 'flagged for the admin');
  // a USD webhook for the right order is not accepted either
  await webhook('payment.captured', fake.payments.get(usd));
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'pending');
});

test('authorized but not captured → "pending" (202), never paid; the captured webhook completes it', async () => {
  const { c, o } = await checkout();
  fake.state.holdCapture = true;
  const payId = fake.pay(o.razorpayOrderId, { status: 'authorized' });
  const r = await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId));
  assert.equal(r.status, 202);
  assert.equal(r.data.pending, true);
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'pending');
  assert.equal((await one('SELECT status FROM payments WHERE provider_payment_id = ?', payId)).status, 'authorized');
  // payment.authorized webhook: recorded, still not paid
  assert.equal((await webhook('payment.authorized', fake.payments.get(payId))).status, 200);
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'pending');
  // Razorpay captures it later
  fake.payments.get(payId).status = 'captured';
  assert.equal((await webhook('payment.captured', fake.payments.get(payId))).status, 200);
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'paid');
});

test('authorized payment is captured by the server, then confirmed captured before marking paid', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId, { status: 'authorized' });
  const r = await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fake.payments.get(payId).status, 'captured');
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'paid');
});

/* ───────── failure, cancellation, retry ───────── */

test('failed payment is recorded; checkout cancellation keeps the order payable; a retry succeeds', async () => {
  const { c, o, product } = await checkout('little-heart-key');
  const stockAfterReserve = (await productBySlug('little-heart-key')).stock;
  // customer closes the Checkout window without paying
  assert.equal((await c('POST', '/api/checkout/failed', { orderNumber: o.orderNumber, accessToken: o.accessToken })).status, 200);
  let row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status, row.stock_reserved], ['pending_payment', 'pending', true]);
  // a payment attempt fails (e.g. card declined)
  const failedId = fake.pay(o.razorpayOrderId, { status: 'failed', error: 'Your card was declined' });
  assert.equal((await c('POST', '/api/checkout/failed', { orderNumber: o.orderNumber, accessToken: o.accessToken, razorpay_payment_id: failedId })).status, 200);
  assert.equal((await one('SELECT status, error_reason FROM payments WHERE provider_payment_id = ?', failedId)).error_reason, 'Your card was declined');
  // even with a valid signature, a failed payment never marks paid
  assert.equal((await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, failedId))).status, 400);
  // retry: pressing Pay again returns the same order and the same Razorpay order (no new reservation)
  const again = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: (await orderRow(o.orderNumber)).idempotency_key });
  assert.equal(again.data.orderNumber, o.orderNumber);
  assert.equal(again.data.razorpayOrderId, o.razorpayOrderId);
  assert.equal((await productBySlug('little-heart-key')).stock, stockAfterReserve, 'stock reserved once');
  const okId = fake.pay(o.razorpayOrderId);
  assert.equal((await verify(c, again.data, fake.checkoutResponse(o.razorpayOrderId, okId))).status, 200);
  row = await orderRow(o.orderNumber);
  assert.equal(row.payment_status, 'paid');
  assert.equal((await counts(row.id)).payments, 2, 'failed + captured attempts both recorded');
  assert.ok(product);
});

/* ───────── webhooks ───────── */

test('webhook: bad signature, wrong secret or invalid JSON → 400 and nothing recorded', async () => {
  const { o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  const before = (await one('SELECT count(*)::int AS n FROM webhook_events')).n;
  assert.equal((await webhook('payment.captured', fake.payments.get(payId), { secret: 'wrong-secret' })).status, 400);
  const res = await fetch(`${app.base}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 400, 'no signature');
  assert.equal((await webhook(null, null, { raw: 'not json {' })).status, 400);
  assert.equal((await one('SELECT count(*)::int AS n FROM webhook_events')).n, before);
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'pending');
});

test('webhook: duplicate deliveries are processed once', async () => {
  const { o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  const id = `evt_${crypto.randomUUID()}`;
  const first = await webhook('payment.captured', fake.payments.get(payId), { id });
  assert.equal(first.status, 200);
  const dups = await Promise.all([1, 2, 3].map(() => webhook('payment.captured', fake.payments.get(payId), { id })));
  for (const d of dups) assert.equal((await d.json()).duplicate, true);
  // the same payment announced by a different event (order.paid) is also harmless
  await webhook('order.paid', fake.payments.get(payId));
  await wait(300);
  const row = await orderRow(o.orderNumber);
  assert.deepEqual(await counts(row.id), { payments: 1, paid_once: 1, emails: 1, movements: 1 });
  const ev = await one('SELECT payload FROM webhook_events WHERE event_id = ?', id);
  assert.ok(!JSON.stringify(ev.payload).includes('customer@example.com'), 'stored webhook payload is redacted');
});

test('webhook: out-of-order events never downgrade a captured payment', async () => {
  const { o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  const entity = fake.payments.get(payId);
  await webhook('payment.captured', entity);
  await webhook('payment.authorized', { ...entity, status: 'authorized', captured: false }); // older event, arrives late
  await webhook('payment.failed', { ...entity, status: 'failed', error_description: 'stale' });
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status], ['paid', 'paid']);
  assert.equal((await one('SELECT status FROM payments WHERE provider_payment_id = ?', payId)).status, 'captured');
  assert.equal(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND note LIKE 'Payment attempt failed%'", row.id), undefined, 'no misleading failure note');
});

test('webhook for an unknown order is acknowledged and ignored', async () => {
  const r = await webhook('payment.captured', { id: 'pay_unknown123456', order_id: 'order_unknown12345', amount: 100, currency: 'INR', status: 'captured' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignored, 'no matching order');
});

test('delayed webhook: the browser never reported success, the webhook confirms it; a late verify is harmless', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'pending');
  await wait(400); // …the customer's network dropped right after paying
  assert.equal((await webhook('order.paid', fake.payments.get(payId))).status, 200);
  assert.equal((await orderRow(o.orderNumber)).payment_status, 'paid');
  assert.equal((await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId))).status, 200);
  const row = await orderRow(o.orderNumber);
  await wait(300);
  assert.deepEqual(await counts(row.id), { payments: 1, paid_once: 1, emails: 1, movements: 1 });
});

test('verification and webhook arriving together mark the order paid exactly once', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  await Promise.all([verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId)), webhook('payment.captured', fake.payments.get(payId)),
    webhook('order.paid', fake.payments.get(payId)), verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId))]);
  await wait(300);
  const row = await orderRow(o.orderNumber);
  assert.deepEqual(await counts(row.id), { payments: 1, paid_once: 1, emails: 1, movements: 1 });
});

/* ───────── expiry & reconciliation ───────── */

const expire = async (n) => { await run("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE order_number = ?", n); await expireStaleCheckouts(razorpay); };

test('expiry asks Razorpay first: a captured payment is honoured, stock is never released', async () => {
  const { o } = await checkout('tulip-bouquet');
  const stock = (await productBySlug('tulip-bouquet')).stock;
  fake.pay(o.razorpayOrderId); // paid, but neither the browser nor the webhook told us
  await expire(o.orderNumber);
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status, row.stock_reserved], ['paid', 'paid', true]);
  assert.equal((await productBySlug('tulip-bouquet')).stock, stock, 'stock not released');
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND actor = 'reconciliation'", row.id));
});

test('expiry with a payment still authorized (not capturable yet) keeps the order reserved', async () => {
  const { o } = await checkout('toadstool-friend');
  fake.state.holdCapture = true;
  fake.pay(o.razorpayOrderId, { status: 'authorized' });
  await expire(o.orderNumber);
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.stock_reserved], ['pending_payment', true]);
});

test('expired order with a late payment: stock re-reserved, order paid and flagged', async () => {
  const { o } = await checkout('pearly-seashell');
  await expire(o.orderNumber); // no payment yet → abandoned, stock released
  let row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status, row.stock_reserved], ['abandoned', 'expired', false]);
  const stockReleased = (await productBySlug('pearly-seashell')).stock;
  const payId = fake.pay(o.razorpayOrderId); // the customer pays after the window
  assert.equal((await webhook('payment.captured', fake.payments.get(payId))).status, 200);
  row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status, row.stock_reserved], ['paid', 'paid', true]);
  assert.equal((await productBySlug('pearly-seashell')).stock, stockReleased - 1, 'stock taken again');
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND to_status = 'paid' AND from_status = 'abandoned'", row.id));
});

test('payment arriving after the order was cancelled: recorded and flagged for refund, never revived', async () => {
  const { o } = await checkout('strawberry-milk-bear');
  const row0 = await orderRow(o.orderNumber);
  await transition(row0.id, 'cancelled', { note: 'test cancel', actor: 'admin' });
  const payId = fake.pay(o.razorpayOrderId);
  await webhook('payment.captured', fake.payments.get(payId));
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status], ['cancelled', 'paid']);
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND note LIKE '%please refund%'", row.id));
});

test('after a refund, late or repeated "captured" events never turn the order back into paid or un-ship it', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  const resp = fake.checkoutResponse(o.razorpayOrderId, payId);
  assert.equal((await verify(c, o, resp)).status, 200);
  const row0 = await orderRow(o.orderNumber);
  await transition(row0.id, 'shipped', { note: 'test ship', actor: 'admin', notify: false });
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' });
  assert.equal((await admin('POST', `/api/admin/orders/${o.orderNumber}/refund`, { reason: 'test' })).status, 200);
  assert.deepEqual(Object.values(await one('SELECT status, payment_status FROM orders WHERE id = ?', row0.id)), ['shipped', 'refunded']);
  const before = await counts(row0.id);
  await webhook('payment.captured', fake.payments.get(payId)); // a Razorpay retry arriving late (new delivery)
  await webhook('order.paid', fake.payments.get(payId));
  assert.equal((await verify(c, o, resp)).status, 200, 'a repeated browser verification is harmless');
  await wait(200);
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status], ['shipped', 'refunded']);
  assert.deepEqual(await counts(row0.id), before, 'no new history, emails or stock movements');
});

test('refund.failed webhook: the order no longer claims the money was returned', async () => {
  const { c, o } = await checkout();
  const payId = fake.pay(o.razorpayOrderId);
  assert.equal((await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, payId))).status, 200);
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' });
  assert.equal((await admin('POST', `/api/admin/orders/${o.orderNumber}/refund`, { reason: 'test' })).status, 200);
  const row0 = await orderRow(o.orderNumber);
  assert.equal(row0.payment_status, 'refunded');
  const rf = await one('SELECT * FROM refunds WHERE order_id = ?', row0.id);
  const raw = JSON.stringify({ entity: 'event', event: 'refund.failed', payload: { refund: { entity: { id: rf.provider_refund_id, payment_id: payId, amount: rf.amount, status: 'failed' } } } });
  assert.equal((await webhook('refund.failed', null, { raw })).status, 200);
  const row = await orderRow(o.orderNumber);
  assert.equal(row.payment_status, 'paid');
  assert.equal((await one('SELECT status FROM refunds WHERE id = ?', rf.id)).status, 'failed');
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND note LIKE '%FAILED at Razorpay%'", row.id));
  assert.equal((await admin('POST', `/api/admin/orders/${o.orderNumber}/refund`, { reason: 'retry' })).status, 200, 'the refund can be issued again');
});

test('Pay again on the same page: reused only while the bag is unchanged; a changed bag or expired checkout starts fresh', async () => {
  const key = crypto.randomUUID();
  const { c, o } = await checkout('cherry-twins', 1, { key });
  const again = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.deepEqual([again.status, again.data.orderNumber, again.data.razorpayOrderId], [200, o.orderNumber, o.razorpayOrderId], 'unchanged bag → same order');

  const cherry = await productBySlug('cherry-twins');
  const stockHeld = cherry.stock;
  await c('POST', '/api/cart/items', { productId: cherry.id, quantity: 1 }); // bag changes (now 2) in another tab
  const changed = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.equal(changed.status, 201, JSON.stringify(changed.data));
  assert.notEqual(changed.data.orderNumber, o.orderNumber);
  assert.notEqual(changed.data.razorpayOrderId, o.razorpayOrderId);
  const newRow = await orderRow(changed.data.orderNumber);
  assert.equal(newRow.total, newRow.subtotal + newRow.shipping_fee);
  assert.equal(newRow.subtotal, cherry.price * 2, 'new order matches the bag now');
  const old = await orderRow(o.orderNumber);
  assert.deepEqual([old.status, old.stock_reserved], ['abandoned', false]);
  assert.equal((await productBySlug('cherry-twins')).stock, stockHeld + 1 - 2, 'old reservation returned, new one taken');

  await expire(changed.data.orderNumber); // the new checkout also expires while the page stays open
  const fresh = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.equal(fresh.status, 201, 'an expired checkout does not block paying again');
  assert.notEqual(fresh.data.orderNumber, changed.data.orderNumber);

  const payId = fake.pay(fresh.data.razorpayOrderId);
  assert.equal((await verify(c, fresh.data, fake.checkoutResponse(fresh.data.razorpayOrderId, payId))).status, 200);
  await c('POST', '/api/cart/items', { productId: cherry.id, quantity: 1 });
  const done = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.equal(done.status, 409, 'a paid checkout is never reused or duplicated with the same key');
});

test('payment endpoints are rate-limited', async () => {
  const { c, o } = await checkout();
  const statuses = [];
  for (let i = 0; i < 41; i++) statuses.push((await verify(c, o, { razorpay_payment_id: 'pay_nothing00000', razorpay_signature: 'a'.repeat(64) })).status);
  assert.equal(statuses.at(-1), 429);
});

test('admin order view shows the Razorpay payment and order ids, status, amount, method and failure reason', async () => {
  const { c, o } = await checkout();
  const f = fake.pay(o.razorpayOrderId, { status: 'failed', error: 'Bank declined the payment' });
  await c('POST', '/api/checkout/failed', { orderNumber: o.orderNumber, accessToken: o.accessToken, razorpay_payment_id: f });
  const okId = fake.pay(o.razorpayOrderId);
  await verify(c, o, fake.checkoutResponse(o.razorpayOrderId, okId));
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' });
  const d = (await admin('GET', `/api/admin/orders/${o.orderNumber}`)).data;
  assert.equal(d.razorpayOrderId, o.razorpayOrderId);
  const byId = Object.fromEntries(d.payments.map((p) => [p.provider_payment_id, p]));
  assert.deepEqual([byId[okId].status, byId[okId].amount, byId[okId].method], ['captured', o.amount, 'upi']);
  assert.deepEqual([byId[f].status, byId[f].error_reason], ['failed', 'Bank declined the payment']);
  assert.ok(byId[okId].created_at);
});
