/**
 * Shiprocket — authentication, pickup location, serviceability & rates from the real parcel, idempotent booking
 * (order → AWB → pickup → label), lost responses, tracking (webhook + poll), cancellation and RTO — against a
 * local fake of the Shiprocket API. Nothing real is ever booked. Payments use the local simulator.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';
import { startFakeShiprocket } from './helpers/fake-shiprocket.js';

const SR_EMAIL = 'api-user@velberry.test';
const SR_PASSWORD = 'fake-shiprocket-password-never-shown';
const WEBHOOK_TOKEN = 'fake-courier-webhook-token-123';
const fake = await startFakeShiprocket({ email: SR_EMAIL, password: SR_PASSWORD });
const env = await setupTestEnv('shiprocket', {
  SHIPROCKET_EMAIL: SR_EMAIL, SHIPROCKET_PASSWORD: SR_PASSWORD, SHIPROCKET_API_BASE: fake.url, SHIPROCKET_ALLOW_BOOKING: 'true',
  SHIPROCKET_PICKUP_LOCATION: 'Velberry Studio', PICKUP_PINCODE: '', SHIPROCKET_WEBHOOK_TOKEN: WEBHOOK_TOKEN, SHIPPING_FEE_MODE: 'flat',
});
const { one, all, run, closeDb, getSetting } = await import('../server/db/index.js');
const { resetRateLimits } = await import('../server/lib/auth.js');
const { config } = await import('../server/config.js');
const { syncTracking } = await import('../server/services/fulfillment.js');
const { transition } = await import('../server/services/orders.js');

let app;
before(async () => { app = await startApp(); });
beforeEach(() => { resetRateLimits(); Object.assign(fake.state, { loseNext: null, failLabelOnce: false, failLoginOnce: false }); });
after(async () => { await app.close(); await closeDb(); await env.drop(); await fake.close(); });

const ROOT = path.resolve(import.meta.dirname, '..');
const client = () => makeClient(() => app.base);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const productBySlug = (slug) => one('SELECT * FROM products WHERE slug = ?', slug);
const orderRow = (n) => one('SELECT * FROM orders WHERE order_number = ?', n);
const shipmentOf = async (n) => one('SELECT s.* FROM shipments s JOIN orders o ON o.id = s.order_id WHERE o.order_number = ?', n);
const srOrdersFor = (n) => [...fake.orders.values()].filter((o) => o.channel_order_id === n);

let adminClient;
async function admin() {
  if (!adminClient) {
    adminClient = client();
    const r = await adminClient('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' });
    assert.equal(r.status, 200);
  }
  return adminClient;
}

/** A paid order (simulator) for `qty` of a product. */
async function paidOrder(slug = 'cherry-twins', qty = 1, addr = address) {
  const c = client();
  const p = await productBySlug(slug);
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false WHERE id = ?', p.id);
  await c('POST', '/api/cart/items', { productId: p.id, quantity: qty });
  const o = await c('POST', '/api/checkout/order', { customer, address: addr, idempotencyKey: crypto.randomUUID() });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const pay = await c('POST', '/api/checkout/mock-pay', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken });
  const v = await c('POST', '/api/checkout/verify', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken, ...pay.data });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return { c, o: o.data, product: p };
}
const book = async (n, body = {}) => (await admin())('POST', `/api/admin/orders/${n}/ship`, body);

function courierWebhook(payload, token = WEBHOOK_TOKEN) {
  return fetch(`${app.base}/api/webhooks/courier-tracking`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-api-key': token } : {}) }, body: JSON.stringify(payload),
  });
}
const scan = (awb, status, ts, extra = {}) => courierWebhook({ awb, current_status: status, current_timestamp: ts, scans: [{ date: ts, activity: `${status} scan`, location: 'Hyderabad Hub' }], ...extra });

/* ───────── authentication ───────── */

test('auth: logs in with the server-side credentials, stores the token, reuses it, and never exposes it', async () => {
  const before = fake.calls.filter((c) => c.path === '/auth/login').length;
  const a = await admin();
  const check = await a('POST', '/api/admin/shipping/check', {});
  assert.equal(check.data.ok, true, JSON.stringify(check.data));
  await a('POST', '/api/admin/shipping/check', {});
  await a('POST', '/api/admin/shipping/check', {});
  assert.equal(fake.calls.filter((c) => c.path === '/auth/login').length - before <= 1, true, 'token reused across calls');
  const stored = JSON.parse(await getSetting('shiprocket_token'));
  assert.ok(stored.token.startsWith('tok_') && stored.exp > Date.now() + 8 * 86400e3, 'token kept with a ~9-day expiry');
  const integ = await a('GET', '/api/admin/integrations');
  const pub = await client()('GET', '/api/config');
  for (const body of [integ.data, pub.data, check.data]) {
    const s = JSON.stringify(body);
    assert.ok(!s.includes(SR_PASSWORD) && !s.includes(stored.token) && !s.includes(WEBHOOK_TOKEN), 'no Shiprocket secret in responses');
  }
  assert.equal(integ.data.shipping.shiprocket, true);
  assert.equal(integ.data.shipping.bookingAllowed, true);
});

test('auth: an expired or revoked token is refreshed once and the call repeated; parallel calls log in once', async () => {
  const logins = () => fake.calls.filter((c) => c.path === '/auth/login').length;
  fake.expireTokens(); // Shiprocket invalidated the stored token early
  let n = logins();
  const a = await admin();
  assert.equal((await a('POST', '/api/admin/shipping/check', {})).data.ok, true);
  assert.equal(logins() - n, 1, 'one re-login after the 401');

  await run("UPDATE settings SET value = ? WHERE key = 'shiprocket_token'", JSON.stringify({ token: 'tok_old', exp: Date.now() - 1000 }));
  fake.expireTokens();
  n = logins();
  const rs = await Promise.all(Array.from({ length: 5 }, () => a('POST', '/api/admin/shipping/check', {})));
  assert.ok(rs.every((r) => r.data.ok), JSON.stringify(rs.map((r) => r.data)));
  assert.equal(logins() - n, 1, 'expired token → exactly one login even with 5 parallel calls');
});

test('auth: a failed login is reported without leaking the password', async () => {
  const saved = config.shiprocket.password;
  config.shiprocket.password = 'wrong-password-zzz';
  await run("DELETE FROM settings WHERE key = 'shiprocket_token'");
  try {
    const r = await (await admin())('POST', '/api/admin/shipping/check', {});
    assert.equal(r.data.ok, false);
    assert.match(r.data.problem, /login failed/i);
    assert.ok(!JSON.stringify(r.data).includes('wrong-password-zzz'));
  } finally { config.shiprocket.password = saved; }
});

/* ───────── pickup location ───────── */

test('pickup: the configured nickname must exist in Shiprocket; its registered PIN drives rates', async () => {
  const a = await admin();
  const ok = await a('POST', '/api/admin/shipping/check', {});
  assert.deepEqual([ok.data.pickup.name, ok.data.pickup.pincode], ['Velberry Studio', '500001']);
  const saved = config.shiprocket.pickupLocation;
  config.shiprocket.pickupLocation = 'Primary';
  try {
    const bad = await a('POST', '/api/admin/shipping/check', {});
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.problem, /"Primary" not found/);
    assert.deepEqual(bad.data.available, ['Velberry Studio']);
  } finally { config.shiprocket.pickupLocation = saved; }
});

/* ───────── serviceability & rates ───────── */

test('rates use the actual parcel: items + packing in the configured box; volumetric weight respected', async () => {
  const c = client();
  const p = await productBySlug('cherry-twins');
  await run('UPDATE products SET stock = 100, sold_out = false WHERE id = ?', p.id);
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const q = await c('POST', '/api/checkout/quote', { pincode: '110001' });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.deepEqual([q.data.serviceable, q.data.source, q.data.courier, q.data.etd], [true, 'shiprocket', 'Delhivery Surface', 'Nov 12, 2026']);
  const call = fake.calls.filter((x) => x.path === '/courier/serviceability/' && x.query.delivery_postcode === '110001').at(-1);
  const grams = p.weight_grams + config.parcel.packagingGrams;
  assert.deepEqual([call.query.pickup_postcode, call.query.weight, call.query.length, call.query.breadth, call.query.height, call.query.cod],
    ['500001', (grams / 1000).toFixed(3), '12', '10', '6', '0']);

  // Courier pricing: fee = Shiprocket's recommended rate for the chargeable weight
  config.shipping.feeMode = 'courier';
  const freeAbove = config.shipping.freeAbove;
  config.shipping.freeAbove = 0; // no free-shipping threshold for this check
  try {
    const one1 = await c('POST', '/api/checkout/quote', { pincode: '110002' });
    assert.equal(one1.data.fee, 70 * 100, 'max(78 g actual, 144 g volumetric) → first 0.5 kg slab → ₹70');
    await c('POST', '/api/cart/items', { productId: p.id, quantity: 19 }); // 20 × 28 g + 50 g = 610 g → 2 slabs
    const heavy = await c('POST', '/api/checkout/quote', { pincode: '110002' });
    assert.equal(heavy.data.fee, 100 * 100);
  } finally { config.shipping.feeMode = 'flat'; config.shipping.freeAbove = freeAbove; }
});

test('serviceability: unserviceable PINs (404 or 200 with status 404) are refused; blocked couriers are hidden', async () => {
  const c = client();
  const p = await productBySlug('cherry-twins');
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  for (const pin of ['799999', '788888']) {
    const r = await c('POST', '/api/checkout/quote', { pincode: pin });
    assert.equal(r.status, 400, pin);
    assert.match(r.data.error, /can't reach this PIN/);
    const o = await c('POST', '/api/checkout/order', { customer, address: { ...address, pincode: pin }, idempotencyKey: crypto.randomUUID() });
    assert.equal(o.status, 400, 'no order (or stock reservation) for an unserviceable address');
  }
  const { o } = await paidOrder();
  const list = await (await admin())('GET', `/api/admin/orders/${o.orderNumber}/couriers`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.couriers.map((x) => x.name), ['Delhivery Surface', 'Bluedart Air']);
  assert.equal(list.data.recommended.name, 'Delhivery Surface');
  assert.equal(list.data.parcel.chargeableGrams, 144);
  assert.ok(list.data.couriers.every((x) => x.etd && x.etdDays && Number.isInteger(x.rate)));
});

test('Shiprocket unreachable: flat fee checkout continues (unverified); courier pricing refuses honestly', async () => {
  const c = client();
  const p = await productBySlug('cherry-twins');
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const saved = config.shiprocket.apiBase;
  config.shiprocket.apiBase = 'http://127.0.0.1:9/v1/external';
  try {
    const flat = await c('POST', '/api/checkout/quote', { pincode: '400001' });
    assert.deepEqual([flat.status, flat.data.source, flat.data.fee], [200, 'flat-unverified', config.shipping.flatRate]);
    config.shipping.feeMode = 'courier';
    const courier = await c('POST', '/api/checkout/quote', { pincode: '400002' });
    assert.equal(courier.status, 503);
  } finally { config.shiprocket.apiBase = saved; config.shipping.feeMode = 'flat'; }
});

test('the public quote endpoint is rate-limited', async () => {
  const c = client();
  const p = await productBySlug('cherry-twins');
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  let last;
  for (let i = 0; i < 61; i++) last = await c('POST', '/api/checkout/quote', { pincode: '560001' });
  assert.equal(last.status, 429);
});

/* ───────── booking ───────── */

test('never ships unpaid orders; nothing is sent to Shiprocket', async () => {
  const c = client();
  const p = await productBySlug('cherry-twins');
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = (await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() })).data;
  const before = fake.bookingCalls().length;
  const r = await book(o.orderNumber);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Only paid orders/);
  assert.equal(fake.bookingCalls().length, before);
  assert.ok(!(await shipmentOf(o.orderNumber)), 'no shipment row');
});

test('paid order → Shiprocket order, AWB, courier, pickup and label; order ready for pickup; customer sees tracking', async () => {
  const { c, o, product } = await paidOrder('cherry-twins', 2);
  const r = await book(o.orderNumber);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = await shipmentOf(o.orderNumber);
  assert.ok(s.provider_order_id && s.provider_shipment_id && s.awb_code && s.pickup_scheduled_at && s.label_url);
  assert.deepEqual([s.courier_name, s.status, s.tracking_url], ['Delhivery Surface', 'pickup_scheduled', `https://shiprocket.co/tracking/${s.awb_code}`]);
  const row = await orderRow(o.orderNumber);
  assert.equal(row.status, 'ready_to_ship');

  const [sr] = srOrdersFor(o.orderNumber);
  const pl = sr.payload;
  assert.deepEqual([pl.pickup_location, pl.payment_method, pl.length, pl.breadth, pl.height], ['Velberry Studio', 'Prepaid', 12, 10, 6]);
  assert.equal(pl.weight, Number(((product.weight_grams * 2 + config.parcel.packagingGrams) / 1000).toFixed(3)));
  assert.deepEqual([pl.billing_pincode, pl.billing_phone, pl.order_items[0].units, pl.sub_total], [address.pincode, address.phone, 2, (row.subtotal / 100).toFixed(2)]);

  const history = await all('SELECT note FROM order_status_history WHERE order_id = ? ORDER BY id', row.id);
  assert.ok(history.some((h) => /Shiprocket order \d+ created/.test(h.note)) && history.some((h) => h.note?.includes(s.awb_code)));

  const view = await c('POST', '/api/orders/lookup', { orderNumber: o.orderNumber, token: o.accessToken });
  assert.deepEqual([view.data.shipment.awb, view.data.shipment.courier, view.data.shipment.trackingUrl], [s.awb_code, 'Delhivery Surface', s.tracking_url]);
  const pub = JSON.stringify(view.data);
  assert.ok(!pub.includes(s.label_url) && !pub.includes(s.provider_shipment_id), 'label and Shiprocket ids are admin-only');
});

test('booking is idempotent: repeats and 5 simultaneous clicks create ONE Shiprocket order, AWB and pickup', async () => {
  const { o } = await paidOrder();
  const rs = await Promise.all(Array.from({ length: 5 }, () => book(o.orderNumber)));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.data?.error)));
  const callsFor = () => fake.bookingCalls().filter((c) => c.path === '/orders/create/adhoc' && c.body.order_id === o.orderNumber).length;
  assert.equal(callsFor(), 1);
  const before = fake.bookingCalls().length;
  assert.equal((await book(o.orderNumber)).status, 200);
  assert.equal(fake.bookingCalls().length, before, 'fully booked → nothing sent again');
  assert.equal(srOrdersFor(o.orderNumber).length, 1);
  assert.equal((await one('SELECT count(*)::int AS n FROM shipments s JOIN orders x ON x.id = s.order_id WHERE x.order_number = ?', o.orderNumber)).n, 1);
});

test('courier choice: the chosen courier gets the AWB; invalid courier ids are refused', async () => {
  const { o } = await paidOrder();
  assert.equal((await book(o.orderNumber, { courierId: 'abc;drop' })).status, 400);
  const r = await book(o.orderNumber, { courierId: '20' });
  assert.equal(r.status, 200);
  assert.equal((await shipmentOf(o.orderNumber)).courier_name, 'Bluedart Air');
});

test('lost responses: Shiprocket acted but we never heard back → the retry reuses it, never books twice', async () => {
  const assigns = (sid) => fake.calls.filter((c) => c.path === '/courier/assign/awb' && c.body.shipment_id === sid).length;
  const pickups = (sid) => fake.calls.filter((c) => c.path === '/courier/generate/pickup' && c.body.shipment_id[0] === sid).length;

  // 1. "create order" response lost → shipment claimed without ids → retry finds the Shiprocket order by our order number
  const a = (await paidOrder()).o;
  fake.state.loseNext = { path: '/orders/create/adhoc' };
  assert.equal((await book(a.orderNumber)).status, 502);
  const claimed = await shipmentOf(a.orderNumber);
  assert.deepEqual([claimed.status, claimed.provider_order_id], ['creating', null]);
  assert.equal((await book(a.orderNumber)).status, 200);
  assert.equal(srOrdersFor(a.orderNumber).length, 1, 'one Shiprocket order, not two');
  assert.equal((await shipmentOf(a.orderNumber)).provider_order_id, String(srOrdersFor(a.orderNumber)[0].id));

  // 2. "assign AWB" response lost → the AWB Shiprocket assigned is read back in the same request; no second AWB
  const b = (await paidOrder()).o;
  fake.state.loseNext = { path: '/courier/assign/awb' };
  assert.equal((await book(b.orderNumber)).status, 200);
  const sb = await shipmentOf(b.orderNumber);
  assert.equal(sb.awb_code, fake.shipments.get(Number(sb.provider_shipment_id)).awb);
  assert.equal(assigns(Number(sb.provider_shipment_id)), 1);

  // 3. "schedule pickup" response lost → retry sees "Already in Pickup Queue" and treats it as done
  const c = (await paidOrder()).o;
  fake.state.loseNext = { path: '/courier/generate/pickup' };
  assert.equal((await book(c.orderNumber)).status, 502);
  assert.equal((await orderRow(c.orderNumber)).status, 'paid', 'not marked ready until pickup is confirmed');
  assert.equal((await book(c.orderNumber)).status, 200);
  const sc = await shipmentOf(c.orderNumber);
  assert.ok(sc.pickup_scheduled_at && sc.label_url);
  assert.equal(pickups(Number(sc.provider_shipment_id)), 2, 'second request only confirmed the existing pickup');
  assert.equal(fake.shipments.get(Number(sc.provider_shipment_id)).pickup, true);
  assert.equal((await orderRow(c.orderNumber)).status, 'ready_to_ship');
});

test('label: a failed label never blocks the booking and can be generated afterwards', async () => {
  const { o } = await paidOrder();
  fake.state.failLabelOnce = true;
  assert.equal((await book(o.orderNumber)).status, 200);
  let s = await shipmentOf(o.orderNumber);
  assert.ok(s.awb_code && s.pickup_scheduled_at && !s.label_url);
  const r = await (await admin())('POST', `/api/admin/orders/${o.orderNumber}/label`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = await shipmentOf(o.orderNumber);
  assert.match(s.label_url, /\.pdf$/);
});

test('development safety: with booking off, nothing is sent to Shiprocket and the reason is clear', async () => {
  const { o } = await paidOrder();
  config.shiprocket.allowBooking = false;
  const before = fake.bookingCalls().length;
  try {
    const r = await book(o.orderNumber);
    assert.equal(r.status, 503);
    assert.match(r.data.error, /SHIPROCKET_ALLOW_BOOKING/);
    assert.equal(fake.bookingCalls().length, before);
    assert.ok(!(await shipmentOf(o.orderNumber)), 'no shipment row');
  } finally { config.shiprocket.allowBooking = true; }
});

test('config: booking is off by default outside production, on in production; the API address can\'t be redirected in production', async () => {
  const cfg = (extra) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./server/config.js'); console.log(JSON.stringify({ allow: config.shiprocket.allowBooking, base: config.shiprocket.apiBase }));"], {
      cwd: ROOT, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'q'.repeat(40), SHIPROCKET_API_BASE: 'http://evil.example', ...extra },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ out }); } });
  });
  assert.deepEqual(await cfg({}), { allow: false, base: 'http://evil.example' });
  assert.deepEqual(await cfg({ SHIPROCKET_ALLOW_BOOKING: 'true' }), { allow: true, base: 'http://evil.example' });
  const prod = { NODE_ENV: 'production', APP_URL: 'https://velberry.example', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x',
    RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  assert.deepEqual(await cfg(prod), { allow: true, base: 'https://apiv2.shiprocket.in/v1/external' });
  assert.deepEqual(await cfg({ ...prod, SHIPROCKET_ALLOW_BOOKING: 'false' }), { allow: false, base: 'https://apiv2.shiprocket.in/v1/external' });
});

/* ───────── tracking ───────── */

test('webhook: token required; unknown AWB ignored; statuses move the order forward; duplicates and late events change nothing', async () => {
  const { c, o } = await paidOrder();
  await book(o.orderNumber);
  const { awb_code: awb } = await shipmentOf(o.orderNumber);
  assert.equal((await scan(awb, 'PICKED UP', '07 11 2026 12:00:00')).status, 200);
  assert.equal((await courierWebhook({ awb, current_status: 'DELIVERED' }, 'wrong')).status, 401);
  assert.equal((await courierWebhook({ awb, current_status: 'DELIVERED' }, null)).status, 401);
  assert.deepEqual(await (await courierWebhook({ awb: 'NOPE123', current_status: 'DELIVERED' })).json(), { ignored: 'unknown awb' });
  assert.equal((await orderRow(o.orderNumber)).status, 'shipped');

  await scan(awb, 'IN TRANSIT', '2026-11-08 09:30:00');
  await scan(awb, 'OUT FOR DELIVERY', '2026-11-09 08:00:00');
  assert.equal((await orderRow(o.orderNumber)).status, 'out_for_delivery');
  const late = await (await scan(awb, 'IN TRANSIT', '2026-11-08 18:00:00')).json(); // an older scan delivered late
  assert.equal(late.stale, true);
  assert.equal((await orderRow(o.orderNumber)).status, 'out_for_delivery', 'never moved backwards');
  const row = await orderRow(o.orderNumber);
  const events = () => one('SELECT count(*)::int AS n FROM tracking_events WHERE order_id = ?', row.id);
  const n = (await events()).n;
  await scan(awb, 'OUT FOR DELIVERY', '2026-11-09 08:00:00'); // duplicate delivery
  assert.equal((await events()).n, n, 'duplicate webhook adds nothing');
  await scan(awb, 'DELIVERED', '2026-11-09 15:45:00', { etd: '2026-11-09 18:00:00' });
  assert.equal((await orderRow(o.orderNumber)).status, 'delivered');

  const view = (await c('POST', '/api/orders/lookup', { orderNumber: o.orderNumber, token: o.accessToken })).data;
  assert.equal(view.status, 'delivered');
  const at = view.trackingEvents.map((e) => e.occurred_at);
  assert.ok(at.every((x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)), `timestamps stored as ISO: ${at}`);
  assert.ok(at.includes('2026-11-07T06:30:00.000Z'), '"07 11 2026 12:00:00" IST → 06:30 UTC');
  assert.equal(view.shipment.etd, '2026-11-09T12:30:00.000Z');
});

test('poll: hourly tracking sync adds each scan once — repeated syncs add nothing', async () => {
  const { o } = await paidOrder();
  await book(o.orderNumber);
  const s = await shipmentOf(o.orderNumber);
  fake.tracks.set(s.awb_code, {
    track_status: 1, etd: '2026-11-11 20:00:00', track_url: `https://shiprocket.co/tracking/${s.awb_code}`,
    shipment_track: [{ current_status: 'IN TRANSIT', courier_name: 'Delhivery Surface' }],
    shipment_track_activities: [
      { date: '2026-11-08 10:00:00', activity: 'Shipment in transit', location: 'Nagpur', 'sr-status-label': 'IN TRANSIT' },
      { date: '2026-11-07 17:00:00', activity: 'Picked up', location: 'Hyderabad', 'sr-status-label': 'PICKED UP' },
    ],
  });
  await syncTracking(s.order_id);
  const count = async () => (await one('SELECT count(*)::int AS n FROM tracking_events WHERE order_id = ?', s.order_id)).n;
  const n = await count();
  assert.equal(n, 2);
  await syncTracking(s.order_id);
  await syncTracking(s.order_id);
  assert.equal(await count(), n);
  assert.equal((await one('SELECT status FROM orders WHERE id = ?', s.order_id)).status, 'shipped');
});

test('a courier problem (e.g. LOST) is flagged for the owner without changing the order', async () => {
  const { o } = await paidOrder();
  await book(o.orderNumber);
  const { awb_code: awb } = await shipmentOf(o.orderNumber);
  await scan(awb, 'PICKED UP', '2026-11-07 12:00:00');
  await scan(awb, 'LOST', '2026-11-08 12:00:00');
  const row = await orderRow(o.orderNumber);
  assert.equal(row.status, 'shipped');
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND note LIKE '%Courier reports \"LOST\"%'", row.id));
});

/* ───────── cancellation & returns ───────── */

test('cancel before pickup: Shiprocket booking cancelled, refund issued, stock returned; retries are safe; no rebooking', async () => {
  const { o, product } = await paidOrder('cherry-twins', 1);
  await book(o.orderNumber);
  const s = await shipmentOf(o.orderNumber);
  const stock = (await productBySlug('cherry-twins')).stock;
  const a = await admin();
  const r = await a('POST', `/api/admin/orders/${o.orderNumber}/cancel`, { reason: 'Customer asked' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status], ['cancelled', 'refunded']);
  assert.equal(fake.orders.get(Number(s.provider_order_id)).status, 'CANCELED');
  const s2 = await shipmentOf(o.orderNumber);
  assert.deepEqual([s2.status, s2.awb_code, s2.label_url], ['cancelled', s.awb_code, s.label_url], 'history kept: AWB and label stay on record');
  assert.equal((await productBySlug('cherry-twins')).stock, stock + 1);
  assert.ok(product);
  assert.ok(await one("SELECT 1 FROM order_status_history WHERE order_id = ? AND note LIKE 'Shipment cancelled at Shiprocket%'", row.id));
  assert.equal((await a('POST', `/api/admin/orders/${o.orderNumber}/cancel`, {})).status, 400, 'already cancelled');
  assert.equal((await book(o.orderNumber)).status, 400, 'a cancelled order is never booked again');
  const ignored = await (await scan(s.awb_code, 'PICKED UP', '2026-11-10 10:00:00')).json();
  assert.equal(ignored.ignored, 'shipment cancelled');
});

test('cancel after pickup is refused and nothing is cancelled at Shiprocket', async () => {
  const { o } = await paidOrder();
  await book(o.orderNumber);
  const s = await shipmentOf(o.orderNumber);
  await scan(s.awb_code, 'PICKED UP', '2026-11-07 12:00:00');
  const r = await (await admin())('POST', `/api/admin/orders/${o.orderNumber}/cancel`, {});
  assert.equal(r.status, 400);
  assert.equal(fake.orders.get(Number(s.provider_order_id)).status, 'NEW');
  assert.equal((await shipmentOf(o.orderNumber)).status, 'picked up');
});

test('return to origin: RTO statuses (even with missed updates) end in "returned", stock back; cancel+refund without calling Shiprocket', async () => {
  const { o } = await paidOrder('pearly-seashell', 1);
  await book(o.orderNumber);
  const s = await shipmentOf(o.orderNumber);
  await scan(s.awb_code, 'PICKED UP', '2026-11-07 12:00:00');
  await scan(s.awb_code, 'UNDELIVERED', '2026-11-09 12:00:00');
  assert.equal((await orderRow(o.orderNumber)).status, 'delivery_failed');
  const stock = (await productBySlug('pearly-seashell')).stock;
  await scan(s.awb_code, 'RTO DELIVERED', '2026-11-14 12:00:00'); // the "RTO INITIATED" update never arrived
  const row = await orderRow(o.orderNumber);
  assert.equal(row.status, 'rto_delivered');
  assert.equal((await productBySlug('pearly-seashell')).stock, stock + 1, 'returned charm back in stock');
  const path = await all("SELECT to_status FROM order_status_history WHERE order_id = ? AND actor = 'courier' ORDER BY id", row.id);
  assert.deepEqual(path.map((p) => p.to_status).slice(-2), ['rto_initiated', 'rto_delivered']);
  const cancelsBefore = fake.calls.filter((c) => c.path === '/orders/cancel').length;
  const r = await (await admin())('POST', `/api/admin/orders/${o.orderNumber}/cancel`, { reason: 'Returned to us' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(Object.values(await one('SELECT status, payment_status FROM orders WHERE id = ?', row.id)), ['cancelled', 'refunded']);
  assert.equal(fake.calls.filter((c) => c.path === '/orders/cancel').length, cancelsBefore, 'no Shiprocket cancel after a return');
  assert.equal((await productBySlug('pearly-seashell')).stock, stock + 1, 'not restocked twice');
});

test('manual shipments still work and a manual one blocks Shiprocket booking (no duplicate shipment)', async () => {
  const { o } = await paidOrder();
  const a = await admin();
  const m = await a('POST', `/api/admin/orders/${o.orderNumber}/manual-shipment`, { courierName: 'India Post', awb: 'EK123456789IN' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  const r = await book(o.orderNumber);
  assert.equal(r.status, 400, 'order already shipped');
  assert.equal(srOrdersFor(o.orderNumber).length, 0);
  await transition((await orderRow(o.orderNumber)).id, 'delivered', { note: 'test', notify: false });
  await wait(50);
});
