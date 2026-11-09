/**
 * Login-first shopping: browsing is public; the bag, checkout and payment need a signed-in customer — enforced by the
 * server (not just hidden buttons). Each customer only ever reaches their own bag, addresses and orders; nothing from
 * a browser cookie or request body can claim someone else's. Old guest-cart rows are never merged or deleted.
 * Payments use the local simulator; nothing real is called.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestEnv, makeClient, startApp, customer, address, confirmEmail } from './helpers/env.js';

const env = await setupTestEnv('loginshop');
const { one, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits, LOGIN_TO_SHOP } = await import('../server/lib/auth.js');
const { settleBackground } = await import('../server/lib/background.js');

let app;
before(async () => { app = await startApp(); });
beforeEach(() => resetRateLimits());
after(async () => { await settleBackground(); await app.close(); await closeDb(); await env.drop(); });

const visitor = () => makeClient(() => app.base, { anonymous: true });
const product = async (slug = 'cherry-twins') => {
  const p = await one('SELECT * FROM products WHERE slug = ?', slug);
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false WHERE id = ?', p.id);
  return p;
};
/** A customer who signed up through the real API and opened the confirmation link (shopping needs a confirmed email). */
async function signedUp(name = 'Asha') {
  const c = visitor();
  const email = `${name.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const r = await c('POST', '/api/auth/signup', { name, email, password: 'lovely-charms-1', phone: '9876543210' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.email = email;
  c.userId = (await one('SELECT id FROM users WHERE email = ?', email)).id;
  await confirmEmail(c.userId);
  return c;
}
const rawFetch = (path, opts = {}) => fetch(app.base + path, opts);

/* ───────── signed out ───────── */

test('a signed-out visitor sees the public pages only — the boutique asks them to log in first', async () => {
  const v = visitor();
  const p = await product();
  for (const url of ['/api/config', '/api/home']) assert.equal((await v('GET', url)).status, 200, url);
  for (const url of ['/api/products', `/api/products/${p.slug}`, '/api/categories']) assert.equal((await v('GET', url)).status, 401, url);
  for (const page of ['/', '/care.html', '/shipping.html', '/contact.html', '/track.html', `/share/product/${p.slug}`]) {
    assert.equal((await rawFetch(page)).status, 200, page);
  }
  for (const page of ['/shop.html', `/p/${p.slug}`, '/collection/strawberry']) {
    const r = await rawFetch(page, { redirect: 'manual' });
    assert.equal(r.status, 302, page);
    assert.ok(r.headers.get('location').startsWith('/account.html?reason=browse&next='), page);
  }
});

test('a signed-out visitor cannot add, change or remove bag items — the server refuses, nothing is created', async () => {
  const v = visitor();
  const p = await product();
  const cartsBefore = (await one('SELECT count(*)::int AS n FROM carts')).n;
  const add = await v('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  assert.equal(add.status, 401);
  assert.equal(add.data.error, LOGIN_TO_SHOP);
  assert.equal(add.data.details.loginRequired, true);
  assert.equal((await v('PATCH', '/api/cart/items/1', { quantity: 2 })).status, 401);
  assert.equal((await v('DELETE', '/api/cart/items/1')).status, 401);
  assert.equal((await one('SELECT count(*)::int AS n FROM carts')).n, cartsBefore, 'no cart row was created');

  const r = await rawFetch('/api/cart');
  const bag = await r.json();
  assert.deepEqual([bag.count, bag.items.length, bag.loginRequired], [0, 0, true]);
  assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith('vb_cart=')), 'no guest bag cookie is handed out any more');
});

test('signed out, every checkout and payment endpoint is refused by the server', async () => {
  const v = visitor();
  for (const [path, body] of [
    ['/api/checkout/quote', { pincode: '560001' }],
    ['/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() }],
    ['/api/checkout/verify', { orderNumber: 'VB-000000-AAAAA', razorpay_payment_id: 'pay_x', razorpay_signature: 'x' }],
    ['/api/checkout/failed', { orderNumber: 'VB-000000-AAAAA' }],
    ['/api/checkout/mock-pay', { orderNumber: 'VB-000000-AAAAA' }],
  ]) {
    const r = await v('POST', path, body);
    assert.equal(r.status, 401, path);
    assert.equal(r.data.details?.loginRequired, true, path);
  }
});

/* ───────── signed in ───────── */

test('signed in: the bag belongs to the account, survives new sessions, and is hidden again after logout', async () => {
  const a = await signedUp('Asha');
  const p = await product();
  assert.equal((await a('POST', '/api/cart/items', { productId: p.id, quantity: 2 })).status, 200);
  assert.equal((await one('SELECT user_id FROM carts c JOIN cart_items i ON i.cart_id = c.id WHERE i.product_id = ? AND c.user_id = ?', p.id, a.userId)).user_id, a.userId);

  // a second browser / new session for the same customer sees the same bag ("refresh" and "log in again")
  const again = visitor();
  assert.equal((await again('POST', '/api/auth/login', { email: a.email, password: 'lovely-charms-1' })).status, 200);
  assert.equal((await again('GET', '/api/cart')).data.count, 2);

  // logout: this browser no longer shows (or can change) anyone's bag
  assert.equal((await a('POST', '/api/auth/logout', {})).status, 200);
  const after = await a('GET', '/api/cart');
  assert.deepEqual([after.data.count, after.data.loginRequired], [0, true]);
  assert.equal((await a('POST', '/api/cart/items', { productId: p.id, quantity: 1 })).status, 401);
  assert.equal((await again('GET', '/api/cart')).data.count, 2, 'still there for the customer');
});

test('customer A can never see or change customer B\'s bag, addresses or orders', async () => {
  const a = await signedUp('Asha');
  const b = await signedUp('Bina');
  const p = await product();
  const bBag = await b('POST', '/api/cart/items', { productId: p.id, quantity: 3 });
  const bItem = bBag.data.items[0].id;

  assert.equal((await a('GET', '/api/cart')).data.count, 0, "A's bag doesn't show B's items");
  const patch = await a('PATCH', `/api/cart/items/${bItem}`, { quantity: 1 });
  assert.equal(patch.status, 400);
  await a('DELETE', `/api/cart/items/${bItem}`);
  assert.equal((await b('GET', '/api/cart')).data.items[0].quantity, 3, "B's line untouched");

  const bAddr = await b('POST', '/api/account/addresses', address);
  assert.equal(bAddr.status, 201, JSON.stringify(bAddr.data));
  const addrId = (await one('SELECT id FROM addresses WHERE user_id = ?', b.userId)).id;
  assert.equal((await a('PUT', `/api/account/addresses/${addrId}`, { ...address, line1: 'Hijacked' })).status, 404);
  await a('DELETE', `/api/account/addresses/${addrId}`);
  assert.equal((await one('SELECT line1 FROM addresses WHERE id = ?', addrId)).line1, address.line1);
  assert.equal((await a('GET', '/api/account')).data.addresses.length, 0);

  const order = await b('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal((await a('GET', `/api/account/orders/${order.data.orderNumber}`)).status, 404);
  assert.ok(!(await a('GET', '/api/account')).data.orders.some((o) => o.order_number === order.data.orderNumber));
  // even holding B's order access token, A cannot pay, fail or "verify" B's order
  const tokenBody = { orderNumber: order.data.orderNumber, accessToken: order.data.accessToken };
  for (const path of ['/api/checkout/mock-pay', '/api/checkout/verify', '/api/checkout/failed']) {
    assert.equal((await a('POST', path, tokenBody)).status, 404, path);
  }
  assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', order.data.orderNumber)).payment_status, 'pending');
});

test('authenticated checkout: order tied to the session\'s customer, address validated, server-calculated fee and total reach the payment', async () => {
  const a = await signedUp('Chitra');
  const other = await signedUp('Divya');
  const p = await product('cherry-twins');
  await a('POST', '/api/cart/items', { productId: p.id, quantity: 1 });

  const bad = await a('POST', '/api/checkout/order', { customer, address: { ...address, pincode: '12' }, idempotencyKey: crypto.randomUUID() });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.details.pincode, 'invalid PIN code reported on the field');
  assert.equal((await a('POST', '/api/checkout/order', { customer: { ...customer, phone: '123' }, address, idempotencyKey: crypto.randomUUID() })).status, 400);

  const quote = await a('POST', '/api/checkout/quote', { pincode: address.pincode });
  assert.equal(quote.status, 200);
  const bag = (await a('GET', '/api/cart')).data;
  const expectedFee = bag.subtotal >= 99900 ? 0 : 7900;
  assert.deepEqual([quote.data.fee, quote.data.total], [expectedFee, bag.subtotal + expectedFee]);

  // the browser cannot choose the customer or the amount
  const o = await a('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID(), userId: other.userId, user_id: other.userId, amount: 100, total: 100 });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.equal(o.data.amount, bag.subtotal + expectedFee, 'the payment amount is the server total');
  const row = await one('SELECT user_id, total, shipping_fee FROM orders WHERE order_number = ?', o.data.orderNumber);
  assert.deepEqual([row.user_id, row.total, row.shipping_fee], [a.userId, bag.subtotal + expectedFee, expectedFee]);

  // and the secure verification path still completes it for the owner
  const pay = await a('POST', '/api/checkout/mock-pay', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken });
  const v = await a('POST', '/api/checkout/verify', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken, ...pay.data });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', o.data.orderNumber)).payment_status, 'paid');
  assert.ok((await a('GET', '/api/account')).data.orders.some((x) => x.order_number === o.data.orderNumber), 'in her order history');
  const forged = await a('POST', '/api/checkout/verify', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken, razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'f'.repeat(64) });
  assert.ok(forged.status >= 400, 'a forged signature is still refused');
});

test('old guest bags: never merged into an account on login or signup, and never deleted', async () => {
  const p = await product();
  const token = 'G'.repeat(32);
  const guest = await one('INSERT INTO carts(guest_token) VALUES (?) RETURNING id', token);
  await run('INSERT INTO cart_items(cart_id, product_id, quantity) VALUES (?,?,?)', guest.id, p.id, 4);

  const r = await rawFetch('/api/cart', { headers: { Cookie: `vb_cart=${token}` } });
  assert.equal((await r.json()).count, 0, 'a guest cookie no longer opens a bag');

  const c = visitor();
  c.jar.set('vb_cart', token);
  const s = await c('POST', '/api/auth/signup', { name: 'Esha', email: `esha-${crypto.randomBytes(3).toString('hex')}@example.com`, password: 'lovely-charms-1' });
  assert.equal(s.status, 201);
  assert.equal((await c('GET', '/api/cart')).data.count, 0, 'nothing merged into the new account');
  assert.equal((await one('SELECT count(*)::int AS n FROM cart_items WHERE cart_id = ?', guest.id)).n, 1, 'the old guest bag is left untouched');
});

test('existing accounts and admin access are unchanged', async () => {
  const admin = visitor();
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  assert.equal((await admin('GET', '/api/admin/stats')).status, 200);
  const a = await signedUp('Farah');
  assert.equal((await a('GET', '/api/admin/stats')).status, 403, 'a customer is still not an admin');
  assert.equal((await visitor()('GET', '/api/admin/stats')).status, 401);
});
