/**
 * CLAYSLAY rebrand: every customer-facing surface says CLAYSLAY (pages, scripts, emails, metadata), every asset a
 * page references exists, no contact details are invented — and everything that existed before the rebrand still
 * works unchanged: accounts created earlier (same password hashes, same session cookie), existing orders and their
 * VB- numbers, order lookup and tracking, checkout + payment verification, admin authentication.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';

const env = await setupTestEnv('brand');
const { one, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits, hashPassword } = await import('../server/lib/auth.js');
const { renderEmail } = await import('../server/services/email-templates.js');
const { settleBackground } = await import('../server/lib/background.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const PUB = path.join(ROOT, 'public');
let app;
before(async () => { app = await startApp(); });
beforeEach(() => resetRateLimits());
after(async () => { await settleBackground(); await app.close(); await closeDb(); await env.drop(); });

const client = () => makeClient(() => app.base);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return ['uploads', 'vendor'].includes(d.name) && dir === PUB ? (d.name === 'uploads' ? walk(p) : []) : walk(p);
  return [p];
});
const rel = (p) => path.relative(PUB, p).split(path.sep).join('/');
const HTML = walk(PUB).filter((p) => p.endsWith('.html'));
const get = (u, opts) => fetch(app.base + u, opts);

/* ───────── branding ───────── */

test('no Velberry branding anywhere in what the browser receives (pages, scripts, styles, images, manifest)', () => {
  const offenders = [];
  for (const f of walk(PUB)) {
    if (!/\.(html|js|css|svg|json|txt|webmanifest)$/.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8').replaceAll('/css/velberry.css', ''); // internal file name, never shown
    const m = text.match(/velberry/gi);
    if (m) offenders.push(`${rel(f)} (${m.length})`);
  }
  assert.deepEqual(offenders, []);
});

test('every page is served with a CLAYSLAY title and CLAYSLAY sharing metadata; private pages are noindex', async () => {
  for (const f of HTML) {
    const url = `/${rel(f)}`;
    const r = await get(url);
    assert.equal(r.status, url === '/404.html' ? 200 : 200, url);
    const html = await r.text();
    assert.match(/<title>([^<]*)<\/title>/.exec(html)[1], /CLAYSLAY/, `${url} title`);
    assert.ok(html.includes('<meta property="og:site_name" content="CLAYSLAY">'), `${url} og:site_name`);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
    if (canonical) assert.ok(canonical.startsWith('https://www.clayslay.in/'), `${url} canonical on the new domain`);
  }
  for (const p of ['/cart.html', '/checkout.html', '/account.html', '/order-success.html', '/admin/']) {
    assert.match(await (await get(p)).text(), /<meta name="robots" content="noindex">/, p);
  }
  const manifest = await (await get('/site.webmanifest')).json();
  assert.equal(manifest.name, 'CLAYSLAY');
  assert.match(await (await get('/robots.txt')).text(), /Disallow: \/admin\//);
});

test('no broken assets: every stylesheet, script, icon, image and module import a page uses exists', async () => {
  const missing = [];
  const refs = new Set();
  for (const f of HTML) {
    for (const [, u] of fs.readFileSync(f, 'utf8').matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) refs.add(u);
  }
  for (const f of walk(path.join(PUB, 'js')).concat(walk(path.join(PUB, 'admin')))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const [, spec] of src.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+)['"]([^'"]+\.js)['"]/g)) {
      const target = spec.startsWith('/') ? path.join(PUB, spec) : path.resolve(path.dirname(f), spec);
      if (spec.startsWith('/vendor/')) continue; // copied from node_modules (served by Express / the Vercel build)
      if (!fs.existsSync(target)) missing.push(`${rel(f)} → ${spec}`);
    }
    for (const [, u] of src.matchAll(/href="(\/[a-z0-9/_-]+\.html)"/g)) refs.add(u);
  }
  refs.add((await (await get('/site.webmanifest')).json()).icons[0].src);
  for (const u of refs) {
    const r = await get(u);
    if (r.status !== 200) missing.push(`${u} → HTTP ${r.status}`);
  }
  assert.deepEqual(missing, []);
  assert.ok(refs.has('/contact.html') && refs.has('/privacy.html') && refs.has('/terms.html'), 'footer links the policy pages');
});

test('every email says CLAYSLAY, never Velberry', () => {
  const order = { order_number: 'VB-20261107-ABCD', customer_name: 'Asha Rao', customer_email: 'asha@example.com', total: 49900, subtotal: 42000, shipping_fee: 7900, payment_status: 'refunded', status: 'cancelled',
    ship_name: 'Asha Rao', ship_line1: '12 Rose Lane', ship_city: 'Bengaluru', ship_state: 'Karnataka', ship_pincode: '560001', ship_phone: '9876543210', created_at: new Date().toISOString() };
  const items = [{ name: 'Cherry Twins', quantity: 1, unit_price: 42000, line_total: 42000 }];
  const shipment = { courier_name: 'Delhivery', awb_code: 'AWB1', tracking_url: 'https://example.com/t' };
  for (const type of ['order_confirmed', 'order_preparing', 'shipped', 'tracking:in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'cancelled', 'refund:rfnd_1', 'owner_new_order']) {
    const { subject, html } = renderEmail(type, { order, items, shipment, extra: { amount: 1000, status: 'processed', refundId: 'rfnd_1', label: 'In transit' }, appUrl: 'https://www.clayslay.in' });
    assert.ok(!/velberry/i.test(subject + html), `${type} mentions Velberry`);
    assert.ok(html.includes('CLAYSLAY'), `${type} carries the CLAYSLAY header`);
    assert.ok(html.includes('www.clayslay.in'), `${type} links the shop`);
  }
});

test('no invented contact details: the footer, Contact, Privacy and Terms pages show only what site-info.js provides', async () => {
  const { SITE } = await import('../public/js/site-info.js');
  for (const k of ['contactEmail', 'phone', 'instagram', 'legalName', 'address']) assert.equal(SITE[k], null, `${k} must be supplied by the owner`);
  for (const p of ['/contact.html', '/privacy.html', '/terms.html', '/shipping.html']) {
    const html = await (await get(p)).text();
    assert.ok(!/mailto:|tel:|[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(html.replace(/<link[^>]+>|<meta[^>]+>/g, '')), `${p} has no hard-coded email or phone`);
  }
  const layout = fs.readFileSync(path.join(PUB, 'js', 'layout.js'), 'utf8');
  assert.ok(!/velberry\.in|hello@/.test(layout));
});

/* ───────── everything from before the rebrand still works ───────── */

test('an account created before the rebrand (stored hash) still logs in, keeps its session cookie name and sees its orders', async () => {
  const email = `before-rebrand-${crypto.randomBytes(3).toString('hex')}@example.com`;
  const { id } = await run('INSERT INTO users(email, password_hash, name, phone, role) VALUES (?,?,?,?,?)', email, hashPassword('old-password-123'), 'Asha Rao', '9876543210', 'customer');
  const c = client();
  const r = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'old-password-123' }) });
  assert.equal(r.status, 200);
  assert.ok(r.headers.getSetCookie().some((h) => h.startsWith('vb_session=')), 'same cookie name → existing sessions stay valid');
  assert.equal((await c('POST', '/api/auth/login', { email, password: 'wrong-password' })).status, 401);

  assert.equal((await c('POST', '/api/auth/login', { email, password: 'old-password-123' })).status, 200);
  const p = await one("SELECT id FROM products WHERE slug = 'cherry-twins'");
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false WHERE id = ?', p.id);
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = await c('POST', '/api/checkout/order', { customer: { ...customer, email }, address, idempotencyKey: crypto.randomUUID() });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.match(o.data.orderNumber, /^VB-\d{6}-[A-Z0-9]+$/, 'order numbers keep their existing format');
  const pay = await c('POST', '/api/checkout/mock-pay', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken });
  const v = await c('POST', '/api/checkout/verify', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken, ...pay.data });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', o.data.orderNumber)).payment_status, 'paid');

  const acc = await c('GET', '/api/account');
  assert.equal(acc.status, 200);
  assert.ok(acc.data.orders.some((x) => x.order_number === o.data.orderNumber));
  assert.equal((await c('GET', `/api/account/orders/${o.data.orderNumber}`)).status, 200);
  assert.equal((await one('SELECT id FROM users WHERE email = ?', email)).id, id, 'same user id');
});

test('an order placed before the rebrand is still found by order lookup, tracking and the admin', async () => {
  const c = client();
  const p = await one("SELECT id FROM products WHERE slug = 'cherry-twins'");
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  const pay = await c('POST', '/api/checkout/mock-pay', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken });
  await c('POST', '/api/checkout/verify', { orderNumber: o.data.orderNumber, accessToken: o.data.accessToken, ...pay.data });
  // make it look historical: placed before the rebrand, with an email subject that still says Velberry
  await run("UPDATE orders SET created_at = '2026-11-01T10:00:00Z' WHERE order_number = ?", o.data.orderNumber);
  const orderId = (await one('SELECT id FROM orders WHERE order_number = ?', o.data.orderNumber)).id;
  await settleBackground();
  await run("UPDATE notifications SET subject = 'Your Velberry order is confirmed' WHERE order_id = ? AND type = 'order_confirmed'", orderId);

  const look = await client()('POST', '/api/orders/lookup', { orderNumber: o.data.orderNumber, email: customer.email });
  assert.equal(look.status, 200, JSON.stringify(look.data));
  assert.equal(look.data.orderNumber, o.data.orderNumber);
  assert.equal((await client()('POST', '/api/orders/lookup', { orderNumber: o.data.orderNumber, email: 'someone-else@example.com' })).status, 404);

  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  const d = await a('GET', `/api/admin/orders/${o.data.orderNumber}`);
  assert.equal(d.status, 200);
  assert.ok(d.data.notifications.some((n) => n.subject === 'Your Velberry order is confirmed'), 'historical email records are shown exactly as sent');
});

test('admin authentication is unchanged: admin in, customers and visitors out', async () => {
  assert.equal((await client()('GET', '/api/admin/stats')).status, 401);
  const cust = client();
  await cust('POST', '/api/auth/signup', { name: 'Mira', email: `mira-${crypto.randomBytes(3).toString('hex')}@example.com`, password: 'mira-password-1' });
  assert.equal((await cust('GET', '/api/admin/stats')).status, 403);
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  assert.equal((await a('GET', '/api/admin/stats')).status, 200);
  assert.equal((await a('POST', '/api/auth/login', { email: 'owner@test.local', password: 'wrong' })).status, 401);
});
