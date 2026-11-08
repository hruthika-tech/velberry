/**
 * End-to-end API tests against a throwaway PostgreSQL database (Supabase-like), using the local payment simulator.
 * Run: npm test   (needs TEST_DATABASE_URL or the local Docker Postgres — see test/helpers/env.js)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';

const env = await setupTestEnv('journey');
const { one, run, closeDb } = await import('../server/db/index.js');
const { expireStaleCheckouts, transition } = await import('../server/services/orders.js');
const razorpay = await import('../server/services/razorpay.js');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await closeDb(); await env.drop(); });
const client = () => makeClient(() => app.base);
const base = () => app.base;

const productBySlug = (slug) => one('SELECT * FROM products WHERE slug = ?', slug);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkoutAndPay(c, { outcome = 'success', key = crypto.randomUUID() } = {}) {
  const o = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const pay = await c('POST', '/api/checkout/mock-pay', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken, outcome });
  return { order: o.data, pay: pay.data };
}

test('catalogue is served from the database', async () => {
  const c = client();
  const cats = await c('GET', '/api/categories');
  assert.equal(cats.data.length, 8);
  const prods = await c('GET', '/api/products');
  assert.equal(prods.data.length, 18);
  const p = await c('GET', '/api/products/strawberry-shortcake-charm');
  assert.equal(p.data.variants.length, 3);
  assert.ok(p.data.related.length > 0);
  assert.equal((await c('GET', '/api/products/nope')).status, 404);
});

test('cart: variants required, stock enforced, quantities update, persisted by cookie', async () => {
  const c = client();
  const straw = (await productBySlug('strawberry-shortcake-charm'));
  assert.equal((await c('POST', '/api/cart/items', { productId: straw.id, quantity: 1 })).status, 400, 'variant required');
  const white = (await one("SELECT * FROM product_variants WHERE product_id = ? AND name = 'White Berry'", straw.id)); // stock 2
  let r = await c('POST', '/api/cart/items', { productId: straw.id, variantId: white.id, quantity: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.items[0].unitPrice, 37900, 'variant price override');
  r = await c('POST', '/api/cart/items', { productId: straw.id, variantId: white.id, quantity: 1 });
  assert.equal(r.status, 409, 'cannot exceed stock');
  const cart = await c('GET', '/api/cart');
  assert.equal(cart.data.count, 2, 'cart persisted across requests');
  r = await c('PATCH', `/api/cart/items/${cart.data.items[0].id}`, { quantity: 1 });
  assert.equal(r.data.subtotal, 37900);
  r = await c('DELETE', `/api/cart/items/${cart.data.items[0].id}`);
  assert.equal(r.data.count, 0);
  const sold = (await productBySlug('parisian-macaron'));
  const vanilla = (await one("SELECT id FROM product_variants WHERE product_id = ? AND name = 'Vanilla'", sold.id));
  assert.equal((await c('POST', '/api/cart/items', { productId: sold.id, variantId: vanilla.id, quantity: 1 })).status, 409, 'sold-out variant');
});

test('rejects non-JSON mutations (CSRF guard)', async () => {
  const res = await fetch(`${base()}/api/cart/items`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'productId=1' });
  assert.equal(res.status, 403);
});

test('full guest journey: reserve stock → idempotent order → verified payment → paid, email, snapshot', async () => {
  const c = client();
  const daisy = (await productBySlug('daisy-dream'));
  await c('POST', '/api/cart/items', { productId: daisy.id, quantity: 3 });
  const q = await c('POST', '/api/checkout/quote', { pincode: '560001' });
  assert.equal(q.data.fee, 7900);
  assert.equal((await c('POST', '/api/checkout/quote', { pincode: '012345' })).status, 400);

  const key = crypto.randomUUID();
  const o1 = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.equal(o1.status, 201);
  assert.equal(o1.data.amount, 3 * 25900 + 7900);
  assert.equal((await productBySlug('daisy-dream')).stock, daisy.stock - 3, 'stock reserved');
  const o2 = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key });
  assert.equal(o2.data.orderNumber, o1.data.orderNumber, 'same key → same order');
  assert.equal((await productBySlug('daisy-dream')).stock, daisy.stock - 3, 'no double reservation');

  const pay = (await c('POST', '/api/checkout/mock-pay', { orderNumber: o1.data.orderNumber, accessToken: o2.data.accessToken })).data;
  // Forged signature is rejected
  const forged = await c('POST', '/api/checkout/verify', { orderNumber: o1.data.orderNumber, accessToken: o2.data.accessToken, ...pay, razorpay_signature: 'f'.repeat(64) });
  assert.equal(forged.status, 400);
  assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', o1.data.orderNumber)).payment_status, 'pending');

  const v = await c('POST', '/api/checkout/verify', { orderNumber: o1.data.orderNumber, accessToken: o2.data.accessToken, ...pay });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const again = await c('POST', '/api/checkout/verify', { orderNumber: o1.data.orderNumber, accessToken: o2.data.accessToken, ...pay });
  assert.equal(again.status, 200, 'verify is idempotent');
  assert.equal((await one('SELECT COUNT(*) n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.order_number = ?', o1.data.orderNumber)).n, 1);
  assert.equal((await c('GET', '/api/cart')).data.count, 0, 'cart cleared after payment');
  assert.equal((await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: key })).status, 400, 'empty bag after purchase');

  // Old token was rotated by the idempotent replay (checked by someone who is NOT the signed-in owner)
  const visitor = makeClient(() => app.base, { anonymous: true });
  assert.equal((await visitor('POST', '/api/orders/lookup', { orderNumber: o1.data.orderNumber, token: o1.data.accessToken })).status, 404);
  const view = await visitor('POST', '/api/orders/lookup', { orderNumber: o1.data.orderNumber, token: o2.data.accessToken });
  assert.equal(view.data.paymentStatus, 'paid');
  assert.equal(view.data.timeline[1].done, true);
  assert.equal((await visitor('POST', '/api/orders/lookup', { orderNumber: o1.data.orderNumber, email: 'ASHA@example.com' })).status, 200);
  assert.equal((await visitor('POST', '/api/orders/lookup', { orderNumber: o1.data.orderNumber, email: 'someone@else.com' })).status, 404);

  // Price snapshot survives a price change
  await run('UPDATE products SET price = 99900 WHERE id = ?', daisy.id);
  const after = await c('POST', '/api/orders/lookup', { orderNumber: o1.data.orderNumber, email: customer.email });
  assert.equal(after.data.items[0].unitPrice, 25900);
  await run('UPDATE products SET price = 25900 WHERE id = ?', daisy.id);

  await wait(150);
  const mails = (await one("SELECT COUNT(*) n FROM notifications n JOIN orders o ON o.id = n.order_id WHERE o.order_number = ? AND type = 'order_confirmed'", o1.data.orderNumber));
  assert.equal(mails.n, 1, 'exactly one confirmation email');
});

test('last-piece race: the second buyer is refused, never oversold', async () => {
  const bear = (await productBySlug('strawberry-milk-bear')); // stock 3
  const a = client();
  const b = client();
  await a('POST', '/api/cart/items', { productId: bear.id, quantity: 3 });
  await b('POST', '/api/cart/items', { productId: bear.id, quantity: 2 });
  assert.equal((await a('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })).status, 201);
  const second = await b('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  assert.equal(second.status, 409);
  assert.equal((await productBySlug('strawberry-milk-bear')).stock, 0);
});

test('abandoned checkouts expire and release stock', async () => {
  const c = client();
  const bow = (await productBySlug('little-heart-key'));
  await c('POST', '/api/cart/items', { productId: bow.id, quantity: 2 });
  const o = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  assert.equal((await productBySlug('little-heart-key')).stock, bow.stock - 2);
  await run("UPDATE orders SET expires_at = '2000-01-01T00:00:00Z' WHERE order_number = ?", o.data.orderNumber);
  await expireStaleCheckouts(razorpay);
  const row = (await one('SELECT status, payment_status FROM orders WHERE order_number = ?', o.data.orderNumber));
  assert.equal(row.status, 'abandoned');
  assert.equal(row.payment_status, 'expired');
  assert.equal((await productBySlug('little-heart-key')).stock, bow.stock, 'stock released');
});

test('a payment arriving for a cancelled order is recorded for refund, never revives the order', async () => {
  const c = client();
  const p = (await productBySlug('toadstool-friend'));
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const { order, pay } = await checkoutAndPay(c);
  const { transition } = await import('../server/services/orders.js');
  const id = (await one('SELECT id FROM orders WHERE order_number = ?', order.orderNumber)).id;
  await transition(id, 'cancelled', { note: 'test', notify: false });
  const stockAfterCancel = (await productBySlug('toadstool-friend')).stock;
  const v = await c('POST', '/api/checkout/verify', { orderNumber: order.orderNumber, accessToken: order.accessToken, ...pay });
  assert.equal(v.status, 409);
  const row = (await one('SELECT status, payment_status FROM orders WHERE id = ?', id));
  assert.equal(row.status, 'cancelled');
  assert.equal(row.payment_status, 'paid', 'visible to admin for refund');
  assert.equal((await productBySlug('toadstool-friend')).stock, stockAfterCancel, 'stock not re-reserved');
});

test('Razorpay webhook: signature required, marks paid once, duplicates ignored', async () => {
  const c = client();
  const p = (await productBySlug('tulip-bouquet'));
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_webhooktest1', order_id: o.data.razorpayOrderId, status: 'captured', amount: o.data.amount, method: 'upi' } } } });
  const sig = crypto.createHmac('sha256', 'whsec_test').update(evt).digest('hex');
  const bad = await fetch(`${base()}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'nope' }, body: evt });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base()}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' }, body: evt });
  assert.equal(ok.status, 200);
  const dup = await (await fetch(`${base()}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' }, body: evt })).json();
  assert.equal(dup.duplicate, true);
  assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', o.data.orderNumber)).payment_status, 'paid');

  // Amount mismatch must NOT mark paid
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o2 = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  const evt2 = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_webhooktest2', order_id: o2.data.razorpayOrderId, status: 'captured', amount: 100, method: 'upi' } } } });
  await fetch(`${base()}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', 'whsec_test').update(evt2).digest('hex'), 'x-razorpay-event-id': 'evt_2' }, body: evt2 });
  assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', o2.data.orderNumber)).payment_status, 'pending');
});

test('accounts: no guest bag (nothing added or merged before login), saved addresses, order history; admin routes protected', async () => {
  const c = makeClient(() => app.base, { anonymous: true });
  const shell = (await productBySlug('pearly-seashell'));
  const guestAdd = await c('POST', '/api/cart/items', { productId: shell.id, quantity: 1 });
  assert.equal(guestAdd.status, 401, 'a signed-out visitor cannot add to a bag');
  assert.equal(guestAdd.data.details.loginRequired, true);
  const s = await c('POST', '/api/auth/signup', { name: 'Meera', email: 'meera@example.com', password: 'lovely-charms' });
  assert.equal(s.status, 201);
  assert.equal((await c('GET', '/api/cart')).data.count, 0, 'nothing was added or merged before login');
  await c('POST', '/api/cart/items', { productId: shell.id, quantity: 1 });
  assert.equal((await c('GET', '/api/cart')).data.count, 1, 'signed in: the charm goes into her own bag');
  assert.equal((await c('GET', '/api/admin/stats')).status, 403);
  await c('POST', '/api/account/addresses', address);
  const { order, pay } = await checkoutAndPay(c);
  await c('POST', '/api/checkout/verify', { orderNumber: order.orderNumber, accessToken: order.accessToken, ...pay });
  const acct = await c('GET', '/api/account');
  assert.equal(acct.data.addresses.length, 1);
  assert.equal(acct.data.orders[0].order_number, order.orderNumber);
  assert.equal((await c('POST', '/api/auth/login', { email: 'meera@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await client()('GET', '/api/admin/stats')).status, 401);
});

test('admin: dashboard, status flow, manual shipment, cancellation with refund + restock', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  const stats = await admin('GET', '/api/admin/stats');
  assert.ok(stats.data.totalOrders >= 2);
  assert.ok(stats.data.revenue > 0);

  const buyer = client();
  const cup = (await productBySlug('afternoon-teacup'));
  await buyer('POST', '/api/cart/items', { productId: cup.id, quantity: 2 });
  const { order, pay } = await checkoutAndPay(buyer);
  await buyer('POST', '/api/checkout/verify', { orderNumber: order.orderNumber, accessToken: order.accessToken, ...pay });

  assert.equal((await admin('POST', `/api/admin/orders/${order.orderNumber}/status`, { status: 'delivered' })).status, 400, 'cannot skip to delivered');
  assert.equal((await admin('POST', `/api/admin/orders/${order.orderNumber}/status`, { status: 'preparing' })).status, 200);
  assert.equal((await admin('POST', `/api/admin/orders/${order.orderNumber}/status`, { status: 'packed' })).status, 200);
  const ship = await admin('POST', `/api/admin/orders/${order.orderNumber}/ship`, {});
  assert.equal(ship.status, 503, 'Shiprocket not configured → honest error, no fake shipment');
  const manual = await admin('POST', `/api/admin/orders/${order.orderNumber}/manual-shipment`, { courierName: 'India Post', awb: 'EK123456789IN', trackingUrl: 'https://www.indiapost.gov.in' });
  assert.equal(manual.data.status, 'shipped');
  assert.equal(manual.data.shipment.courier, 'India Post');
  assert.equal((await admin('POST', `/api/admin/orders/${order.orderNumber}/cancel`, {})).status, 400, 'shipped orders cannot be cancelled');

  // Another paid order → cancel with refund
  await buyer('POST', '/api/cart/items', { productId: cup.id, quantity: 1 });
  const second = await checkoutAndPay(buyer);
  await buyer('POST', '/api/checkout/verify', { orderNumber: second.order.orderNumber, accessToken: second.order.accessToken, ...second.pay });
  const before = (await productBySlug('afternoon-teacup')).stock;
  const cancelled = await admin('POST', `/api/admin/orders/${second.order.orderNumber}/cancel`, { reason: 'Customer request' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.paymentStatus, 'refunded');
  assert.equal((await productBySlug('afternoon-teacup')).stock, before + 1, 'stock returned');

  const list = await admin('GET', `/api/admin/orders?q=${second.order.orderNumber}`);
  assert.equal(list.data.total, 1);
  const filtered = await admin('GET', '/api/admin/orders?payment=refunded');
  assert.ok(filtered.data.rows.every((r) => r.payment_status === 'refunded'));
});

test('admin product management: create with variants, upload image, archive when ordered', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' });
  const created = await admin('POST', '/api/admin/products', {
    name: 'Matcha Latte Charm', price: '299', stock: 5, categoryId: (await one('SELECT id FROM categories LIMIT 1')).id, isActive: true,
    variants: [{ name: 'Iced', stock: 3 }, { name: 'Hot', stock: 2, price: '319' }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.stock, 5);
  const png = 'data:image/png;base64,' + fs.readFileSync(path.resolve('public/uploads/seed/daisy-dream-1.png')).toString('base64');
  const up = await admin('POST', `/api/admin/products/${created.data.id}/images`, { files: [{ name: 'a.png', dataUrl: png }] });
  assert.equal(up.status, 201);
  assert.equal(up.data.images.length, 1);
  const fake = await admin('POST', `/api/admin/products/${created.data.id}/images`, { files: [{ name: 'evil.png', dataUrl: 'data:image/png;base64,' + Buffer.from('<script>').toString('base64') }] });
  assert.equal(fake.status, 400, 'non-images rejected by magic bytes');
  const del = await admin('DELETE', `/api/admin/products/${created.data.id}`);
  assert.equal(del.data.deleted, true);
  const ordered = (await productBySlug('daisy-dream'));
  assert.equal((await admin('DELETE', `/api/admin/products/${ordered.id}`)).data.archived, true, 'ordered products are archived, not deleted');
  await run('UPDATE products SET is_active = true WHERE id = ?', ordered.id);
});
