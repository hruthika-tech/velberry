/**
 * Concurrency tests — real parallel requests against PostgreSQL.
 * SQLite serialised every write; Postgres doesn't, so these prove the row locks / conditional updates hold.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';

const env = await setupTestEnv('concurrency');
const { one, all, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits } = await import('../server/lib/auth.js');

let app;
before(async () => { app = await startApp(); });
// All simulated shoppers share 127.0.0.1, so give each test a fresh rate-limit window (the limits are unchanged).
beforeEach(() => resetRateLimits());
after(async () => { await app.close(); await closeDb(); await env.drop(); });
const client = () => makeClient(() => app.base);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('20 shoppers race for the LAST piece: exactly one order succeeds, stock never goes negative', async () => {
  const p = await one("SELECT * FROM products WHERE slug = 'cherry-twins'");
  await run('UPDATE products SET stock = 1 WHERE id = ?', p.id);
  const shoppers = Array.from({ length: 20 }, client);
  for (const c of shoppers) {
    // everyone puts the last piece in their bag first (allowed — stock is only reserved at checkout)
    assert.equal((await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 })).status, 200);
  }
  const results = await Promise.all(shoppers.map((c) => c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })));
  const ok = results.filter((r) => r.status === 201);
  const soldOut = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, `expected one winner, got ${ok.length}: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(soldOut.length, 19);
  assert.equal((await one('SELECT stock FROM products WHERE id = ?', p.id)).stock, 0);
  const reserved = await one("SELECT COALESCE(SUM(-delta), 0) AS n FROM inventory_movements WHERE product_id = ? AND reason = 'reserve'", p.id);
  assert.equal(reserved.n, 1, 'exactly one reservation recorded');
});

test('multi-item checkouts in opposite orders do not deadlock', async () => {
  const [a, b] = await all("SELECT * FROM products WHERE slug IN ('daisy-dream', 'tulip-bouquet') ORDER BY slug");
  await run('UPDATE products SET stock = 50 WHERE id = ANY(?)', [a.id, b.id]);
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const c = client();
    const first = i % 2 ? a : b;
    const second = i % 2 ? b : a;
    await c('POST', '/api/cart/items', { productId: first.id, quantity: 1 });
    await c('POST', '/api/cart/items', { productId: second.id, quantity: 1 });
    runs.push(c);
  }
  const results = await Promise.all(runs.map((c) => c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [201], JSON.stringify(results.map((r) => r.data?.error)));
  const left = await all('SELECT stock FROM products WHERE id = ANY(?) ORDER BY id', [a.id, b.id]);
  assert.deepEqual(left.map((x) => x.stock), [38, 38]);
});

test('the same checkout submitted 8 times at once creates ONE order and ONE reservation', async () => {
  const p = await one("SELECT * FROM products WHERE slug = 'butter-croissant'");
  const before = p.stock;
  const c = client();
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 2 });
  const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key })));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.map((r) => [r.status, r.data?.error])));
  const numbers = new Set(results.map((r) => r.data.orderNumber));
  assert.equal(numbers.size, 1, 'all requests got the same order');
  const rzp = new Set(results.map((r) => r.data.razorpayOrderId));
  assert.equal(rzp.size, 1, 'all requests got the same Razorpay order id');
  assert.equal((await one('SELECT stock FROM products WHERE id = ?', p.id)).stock, before - 2, 'stock reserved once');
  assert.equal((await one('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?', key)).n, 1);
});

test('browser verify + webhook + reconciliation arriving together mark the order paid exactly once', async () => {
  const p = await one("SELECT * FROM products WHERE slug = 'bunny-bun'");
  const c = client();
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = (await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })).data;
  const pay = (await c('POST', '/api/checkout/mock-pay', { orderNumber: o.orderNumber, accessToken: o.accessToken })).data;

  const { markPaid } = await import('../server/services/orders.js');
  const order = await one('SELECT * FROM orders WHERE order_number = ?', o.orderNumber);
  const payment = { id: pay.razorpay_payment_id, orderId: o.razorpayOrderId, status: 'captured', amount: o.amount, method: 'upi', raw: {} };
  const [verify] = await Promise.all([
    c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, ...pay }),
    c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, ...pay }),
    markPaid(order.id, payment, 'webhook'),
    markPaid(order.id, payment, 'reconciliation'),
  ]);
  assert.equal(verify.status, 200);
  assert.equal((await one('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', order.id)).n, 1, 'one payment row');
  assert.equal((await one("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND to_status = 'paid' AND from_status <> 'paid'", order.id)).n, 1, 'paid once');
  await wait(300);
  assert.equal((await one("SELECT COUNT(*) AS n FROM notifications WHERE order_id = ? AND type = 'order_confirmed'", order.id)).n, 1, 'one confirmation email');
});

test('parallel "add to bag" clicks on a new cart never exceed stock or duplicate lines', async () => {
  const p = await one("SELECT * FROM products WHERE slug = 'afternoon-teacup'");
  await run('UPDATE products SET stock = 3 WHERE id = ?', p.id);
  const c = client();
  await c('GET', '/api/cart'); // no cart yet
  const results = await Promise.all(Array.from({ length: 6 }, () => c('POST', '/api/cart/items', { productId: p.id, quantity: 1 })));
  const ok = results.filter((r) => r.status === 200).length;
  const cart = await c('GET', '/api/cart');
  const lines = cart.data.items.filter((i) => i.productId === p.id);
  assert.ok(lines.length <= 1, 'a single bag line');
  assert.ok((lines[0]?.quantity || 0) <= 3, 'never more than stock');
  assert.equal(lines[0]?.quantity || 0, Math.min(ok, 3));
});

test('expiring a checkout while the payment confirms: never both abandoned and paid', async () => {
  const p = await one("SELECT * FROM products WHERE slug = 'garden-butterfly'");
  const before = p.stock;
  const c = client();
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = (await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })).data;
  const pay = (await c('POST', '/api/checkout/mock-pay', { orderNumber: o.orderNumber, accessToken: o.accessToken })).data;
  await run("UPDATE orders SET expires_at = now() - interval '1 hour' WHERE order_number = ?", o.orderNumber);
  const { expireStaleCheckouts } = await import('../server/services/orders.js');
  const razorpay = await import('../server/services/razorpay.js');
  await Promise.all([
    expireStaleCheckouts(razorpay),
    c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, ...pay }),
  ]);
  const row = await one('SELECT status, payment_status, stock_reserved FROM orders WHERE order_number = ?', o.orderNumber);
  assert.equal(row.payment_status, 'paid', 'a verified payment always wins');
  assert.equal(row.status, 'paid');
  assert.equal(row.stock_reserved, true);
  assert.equal((await one('SELECT stock FROM products WHERE id = ?', p.id)).stock, before - 1, 'stock taken exactly once');
});

test('the production checkout rate limit still applies: the 31st checkout from one IP within 10 minutes is refused', async () => {
  const c = client();
  const statuses = [];
  // An empty bag is rejected with 400 after the limiter counts the request, so no stock is touched.
  for (let i = 0; i < 31; i++) statuses.push((await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })).status);
  assert.ok(statuses.slice(0, 30).every((s) => s !== 429), `first 30 allowed: ${statuses}`);
  assert.equal(statuses[30], 429);
});
