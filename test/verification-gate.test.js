/**
 * Mandatory email confirmation + public share links.
 *  • Only public pages (homepage, sign-up/login, the confirmation pages, Track Order, policy pages and share links)
 *    are open to everyone. The boutique — listings, search, collections, product pages, bag, checkout and the account
 *    area — needs a signed-in customer with a CONFIRMED email, enforced by the server for pages AND APIs.
 *  • /share/product/:slug shows one product to anyone, with only safe display fields and proper social metadata.
 * Resend is faked in-process; no email leaves the machine.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupTestEnv, makeClient, startApp, address } from './helpers/env.js';

const APP_URL = 'https://shop.example.test';
const env = await setupTestEnv('gate', { RESEND_API_KEY: 're_test_not_a_real_key', EMAIL_FROM: 'CLAYSLAY <hello@clayslay.in>', APP_URL });
const { one, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits, VERIFY_TO_SHOP, LOGIN_TO_SHOP } = await import('../server/lib/auth.js');
const { settleBackground } = await import('../server/lib/background.js');
const { ROOT } = await import('../server/config.js');

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, opts);
  sent.push(JSON.parse(opts.body));
  return new Response(JSON.stringify({ id: `re_${crypto.randomBytes(4).toString('hex')}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

let app;
before(async () => { app = await startApp(); });
beforeEach(() => resetRateLimits());
after(async () => { await settleBackground(); globalThis.fetch = realFetch; await app.close(); await closeDb(); await env.drop(); });

const visitor = () => makeClient(() => app.base, { anonymous: true });
const confirmed = () => makeClient(() => app.base); // auto-signs in a confirmed customer
const raw = (p, opts = {}) => fetch(app.base + p, { redirect: 'manual', ...opts });
const withCookie = (c) => ({ headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
const mailTo = (email) => sent.filter((m) => m.to.includes(email));
const linkIn = (mail) => /href="(https:\/\/shop\.example\.test\/verify-email\.html\?[^"]+)"/.exec(mail.html)?.[1].replace(/&amp;/g, '&');
const product = async (slug = 'cherry-twins') => {
  const p = await one('SELECT * FROM products WHERE slug = ?', slug);
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false, is_active = true WHERE id = ?', p.id);
  return p;
};

async function signUp(extra = {}) {
  const c = visitor();
  const email = `gate-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const r = await c('POST', '/api/auth/signup', { name: 'Riya Sen', email, password: 'lovely-charms-1', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await settleBackground();
  c.email = email;
  c.userId = (await one('SELECT id FROM users WHERE email = ?', email)).id;
  return c;
}

const GATED_PAGES = (slug) => ['/shop', '/shop.html', `/p/${slug}`, '/collection/strawberry', '/cart', '/cart.html', '/checkout', '/checkout.html'];
const GATED_GETS = (slug) => ['/api/products', '/api/products?featured=1', '/api/products?q=cherry', '/api/products?category=strawberry',
  `/api/products/${slug}`, '/api/categories', '/api/account', '/api/account/orders/VB-000000-XXXXX', '/api/pincode/560001'];

/* ───────── public pages ───────── */

test('1. the homepage and other public pages open for anyone; the homepage teaser carries display fields only', async () => {
  for (const page of ['/', '/account.html', '/verify-pending.html', '/verify-email.html', '/track.html', '/privacy.html', '/terms.html', '/shipping.html', '/contact.html', '/care.html']) {
    assert.equal((await raw(page)).status, 200, page);
  }
  const low = await product('cherry-twins');
  await run('UPDATE products SET stock = 2, is_featured = true WHERE id = ?', low.id); // "Only 2 left" must not leak
  const home = await visitor()('GET', '/api/home');
  assert.equal(home.status, 200);
  const { featured, showcase, categories } = home.data;
  assert.ok(featured.length >= 4);
  const CARD = ['availability', 'category', 'comparePrice', 'id', 'image', 'images', 'name', 'price', 'shortDesc', 'slug', 'variants'];
  for (const p of featured) {
    assert.deepEqual(Object.keys(p).sort(), CARD, 'allow-listed fields only');
    assert.ok(['In stock', 'Sold out'].includes(p.availability.label), p.availability.label);
    assert.ok(p.variants.every((v) => Object.keys(v).join() === 'price'), 'variant prices only — no stock, sku or ids');
    assert.ok(!p.category || Object.keys(p.category).join() === 'name');
  }
  if (showcase) assert.ok(!('stock' in showcase) && !('sku' in showcase) && !('description' in showcase));
  for (const c of categories) assert.deepEqual(Object.keys(c).sort(), ['description', 'fromPrice', 'icon', 'name', 'previews', 'slug']);
  const body = JSON.stringify(home.data);
  assert.doesNotMatch(body, /"stock"|"sku"|"weightGrams"|Only \d+ left|"email"/);
  await run('UPDATE products SET stock = 50 WHERE id = ?', low.id);
});

test('Today\'s Special (homepage curtain) never shows stock counts either', async () => {
  const p = await product('cherry-twins');
  await run('UPDATE products SET stock = 1 WHERE id = ?', p.id);
  await run('UPDATE todays_special SET is_active = true, product_1 = ?, product_2 = NULL, product_3 = NULL WHERE id = 1', p.id);
  const r = await visitor()('GET', '/api/todays-special');
  assert.equal(r.data.products[0].availability.label, 'In stock');
  await run('UPDATE todays_special SET is_active = false, product_1 = NULL WHERE id = 1');
  await run('UPDATE products SET stock = 50 WHERE id = ?', p.id);
});

/* ───────── sign-up → confirmation email ───────── */

test('2–3. sign-up works and the confirmation email (fake Resend) links back to a SAFE destination only', async () => {
  const c = await signUp({ next: '/p/cherry-twins?add=1::1' });
  const [mail] = mailTo(c.email);
  assert.ok(mail, 'confirmation email generated');
  const link = new URL(linkIn(mail));
  assert.equal(link.origin, APP_URL, 'link built from APP_URL');
  assert.equal(link.searchParams.get('next'), '/p/cherry-twins?add=1::1');
  for (const evil of ['//evil.example/x', 'https://evil.example', '/\\evil.example', '/api/admin/stats', 'javascript:alert(1)', '/verify-email.html']) {
    const d = await signUp({ next: evil });
    const l = new URL(linkIn(mailTo(d.email)[0]));
    assert.equal(l.searchParams.get('next'), null, `unsafe next dropped: ${evil}`);
  }
});

/* ───────── unconfirmed (and signed-out) customers are kept out — APIs ───────── */

test('4–7. an unconfirmed customer gets 403 from every shopping API; a signed-out visitor gets 401', async () => {
  const p = await product();
  const u = await signUp();
  const v = visitor();
  for (const url of GATED_GETS(p.slug)) {
    const a = await u('GET', url);
    assert.equal(a.status, 403, `unconfirmed ${url}`);
    assert.deepEqual(a.data.details, { verificationRequired: true }, url);
    assert.equal(a.data.error, VERIFY_TO_SHOP);
    const b = await v('GET', url);
    assert.equal(b.status, 401, `signed out ${url}`);
  }
  const writes = [['POST', '/api/cart/items', { productId: p.id, quantity: 1 }], ['PATCH', '/api/cart/items/1', { quantity: 2 }], ['DELETE', '/api/cart/items/1'],
    ['POST', '/api/checkout/quote', { pincode: '560001' }], ['POST', '/api/checkout/order', { customer: { name: 'R', email: u.email, phone: '9876543210' }, address, idempotencyKey: crypto.randomUUID() }],
    ['PATCH', '/api/account', { name: 'Changed' }], ['POST', '/api/account/addresses', address]];
  for (const [m, url, body] of writes) {
    assert.equal((await u(m, url, body)).status, 403, `unconfirmed ${m} ${url}`);
    assert.equal((await v(m, url, body)).status, 401, `signed out ${m} ${url}`);
  }
  // the bag badge request answers, but with an empty bag and the reason — no bag rows are created or read
  const bag = await u('GET', '/api/cart');
  assert.deepEqual([bag.status, bag.data.count, bag.data.verificationRequired, bag.data.loginRequired], [200, 0, true, false]);
  assert.equal((await one('SELECT count(*)::int AS n FROM carts WHERE user_id = ?', u.userId)).n, 0);
  assert.equal((await one('SELECT name FROM users WHERE id = ?', u.userId)).name, 'Riya Sen', 'profile unchanged');
  assert.equal((await v('GET', '/api/cart')).data.loginRequired, true);
  assert.equal((await v('POST', '/api/cart/items', { productId: p.id, quantity: 1 })).data.error, LOGIN_TO_SHOP);
});

/* ───────── … and pages ───────── */

test('8. typing a shopping URL directly cannot get past the gate (and the pages are not public files)', async () => {
  const p = await product();
  const u = await signUp();
  for (const page of GATED_PAGES(p.slug)) {
    const anon = await raw(page);
    assert.equal(anon.status, 302, `signed out ${page}`);
    assert.equal(anon.headers.get('location'), `/account.html?reason=browse&next=${encodeURIComponent(page)}`);
    assert.match(anon.headers.get('cache-control'), /no-store/);
    const unconf = await raw(page, withCookie(u));
    assert.equal(unconf.status, 302, `unconfirmed ${page}`);
    assert.equal(unconf.headers.get('location'), `/verify-pending.html?next=${encodeURIComponent(page)}`);
  }
  // the shopping pages are not in public/, so neither the CDN nor the static server can serve them
  for (const f of ['shop.html', 'product.html', 'cart.html', 'checkout.html']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'public', f)), false, `public/${f} must not exist`);
    assert.ok(fs.existsSync(path.join(ROOT, 'server', 'pages', f)), `server/pages/${f}`);
  }
  for (const sneaky of ['/server/pages/shop.html', '/pages/shop.html', '/shop.html/', '/SHOP.HTML', '/shop.html%00', '/p/../shop.html']) {
    const r = await raw(sneaky, withCookie(u));
    assert.ok([302, 404, 400].includes(r.status), `${sneaky} → ${r.status}`);
    if (r.status === 200) assert.fail(`${sneaky} served a page`);
  }
});

test('9. nothing the browser sends can mark an account confirmed (storage, cookies, headers, parameters, sign-up body)', async () => {
  const p = await product();
  const u = await signUp({ emailVerified: true, email_verified_at: '2020-01-01', email_verified: true, role: 'admin' });
  assert.equal((await one('SELECT email_verified_at, role FROM users WHERE id = ?', u.userId)).email_verified_at, null);
  assert.equal((await one('SELECT role FROM users WHERE id = ?', u.userId)).role, 'customer');
  const session = u.jar.get('vb_session');
  const forged = { headers: { Cookie: `vb_session=${session}; emailVerified=true; email_verified=1; verified=true; role=admin`, 'X-Email-Verified': 'true', 'X-Role': 'admin' } };
  for (const url of ['/api/products?emailVerified=true&verified=1', `/api/products/${p.slug}?email_verified=true`, '/api/categories?role=admin']) {
    assert.equal((await raw(url, forged)).status, 403, url);
  }
  assert.equal((await raw('/shop.html?emailVerified=true', forged)).status, 302);
  const add = await raw('/api/cart/items', { method: 'POST', headers: { ...forged.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: p.id, quantity: 1, emailVerified: true }) });
  assert.equal(add.status, 403);
  // a made-up session cookie is simply "not signed in"
  assert.equal((await raw('/api/products', { headers: { Cookie: 'vb_session=forged-session-token' } })).status, 401);
});

test('10–11. bad links keep the gate shut; the real link unlocks the boutique and returns to where they were heading', async () => {
  const p = await product();
  const u = await signUp({ next: `/p/${p.slug}` });
  for (const token of ['not-a-token', crypto.randomBytes(32).toString('base64url')]) {
    assert.equal((await visitor()('POST', '/api/auth/verify-email', { token })).status, 400);
  }
  const link = new URL(linkIn(mailTo(u.email)[0]));
  await run("UPDATE email_verifications SET expires_at = now() - interval '1 second' WHERE user_id = ?", u.userId);
  assert.equal((await visitor()('POST', '/api/auth/verify-email', { token: link.searchParams.get('token') })).status, 400, 'expired');
  assert.equal((await u('GET', '/api/products')).status, 403, 'still locked');

  await run("UPDATE email_verifications SET expires_at = now() + interval '1 hour' WHERE user_id = ?", u.userId);
  assert.equal((await visitor()('POST', '/api/auth/verify-email', { token: link.searchParams.get('token') })).status, 200, 'on another device, no login');
  assert.equal(link.searchParams.get('next'), `/p/${p.slug}`, 'the page carries on to the intended product');
  assert.equal((await visitor()('POST', '/api/auth/verify-email', { token: link.searchParams.get('token') })).status, 400, 'already used');

  // unlocked: APIs and pages, for the same session (checked against the database on every request)
  assert.equal((await u('GET', '/api/products')).status, 200);
  assert.equal((await u('GET', `/api/products/${p.slug}`)).status, 200);
  assert.equal((await u('POST', '/api/cart/items', { productId: p.id, quantity: 1 })).status, 200);
  for (const page of GATED_PAGES(p.slug)) {
    const r = await raw(page, withCookie(u));
    assert.equal(r.status, 200, page);
    assert.match(r.headers.get('cache-control'), /private, no-store/);
    assert.match(await r.text(), /<script type="module" src="\/js\/pages\/(shop|product|cart|checkout)\.js">/);
  }
});

test('12. confirmed customers keep full access — catalogue, bag, checkout quote, account', async () => {
  const p = await product();
  const c = confirmed();
  for (const url of ['/api/products', `/api/products/${p.slug}`, '/api/categories', '/api/account', '/api/cart']) assert.equal((await c('GET', url)).status, 200, url);
  assert.equal((await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 })).status, 200);
  assert.equal((await c('POST', '/api/checkout/quote', { pincode: '560001' })).status, 200);
  assert.equal((await c('GET', `/api/products/${p.slug}`)).data.shareUrl, `${APP_URL}/share/product/${p.slug}`);
});

test('13. admins are never gated (their email is not "confirmed" in the database, and that is fine)', async () => {
  const admin = visitor();
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  assert.equal((await one("SELECT email_verified_at FROM users WHERE email = 'owner@test.local'")).email_verified_at, null);
  for (const url of ['/api/products', '/api/categories', '/api/admin/stats', '/api/admin/orders']) assert.equal((await admin('GET', url)).status, 200, url);
  assert.equal((await raw('/shop.html', withCookie(admin))).status, 200);
  assert.equal((await raw('/admin/', withCookie(admin))).status, 200);
  // and customers (even confirmed ones) still can't reach admin
  const cust = confirmed();
  assert.equal((await cust('GET', '/api/cart')).status, 200); // signs the confirmed customer in
  assert.equal((await cust('GET', '/api/admin/stats')).status, 403);
});

test('14. public Track Order is unchanged: anyone can look up an order with its number + email', async () => {
  const number = `VB-TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  await run(`INSERT INTO orders(order_number, access_token_hash, customer_name, customer_email, customer_phone, ship_name, ship_phone, ship_line1,
    ship_city, ship_state, ship_pincode, subtotal, shipping_fee, total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  number, 'x', 'Guest', 'guest@example.com', '9876543210', 'Guest', '9876543210', '1 Lane', 'Pune', 'Maharashtra', '411001', 100, 0, 100);
  const v = visitor();
  assert.equal((await raw('/track.html')).status, 200);
  assert.equal((await v('POST', '/api/orders/lookup', { orderNumber: number, email: 'guest@example.com' })).status, 200);
  assert.equal((await v('POST', '/api/orders/lookup', { orderNumber: number, email: 'someone@else.com' })).status, 404);
  const u = await signUp();
  assert.equal((await u('POST', '/api/orders/lookup', { orderNumber: number, email: 'guest@example.com' })).status, 200, 'unconfirmed customers too');
});

/* ───────── public share links ───────── */

const metas = (html) => Object.fromEntries([...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]));

test('15–17, 21. a shared charm opens for anyone (signed out or unconfirmed) with safe fields and correct social metadata', async () => {
  const p = await product('cherry-twins');
  await run("UPDATE products SET stock = 2, sku = 'SECRET-SKU-123', weight_grams = 777 WHERE id = ?", p.id);
  const u = await signUp();
  for (const opts of [{}, withCookie(u)]) {
    const r = await raw(`/share/product/${p.slug}`, opts);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /public/);
    assert.equal(r.headers.get('set-cookie'), null, 'no session or cookie is created');
    const html = await r.text();
    assert.match(html, new RegExp(`<h1>${p.name}</h1>`));
    assert.match(html, /₹\d/);
    assert.match(html, /In stock/);
    assert.doesNotMatch(html, /Only \d+ left|SECRET-SKU-123|777|stock_|"stock"|@example\.com|password|admin/i);
    assert.doesNotMatch(html, /href="\/(p|collection)\/|href="\/shop\.html"|href="\/cart|href="\/checkout/, 'links nowhere into the gated shop');
    assert.doesNotMatch(html, /<script(?! type="module" src="\/js\/pages\/share\.js")/, 'no inline scripts');
    const m = metas(html);
    const url = `${APP_URL}/share/product/${p.slug}`;
    assert.equal(m['og:url'], url);
    assert.match(html, new RegExp(`<link rel="canonical" href="${url}">`));
    assert.equal(m['og:title'], `${p.name} — CLAYSLAY`);
    assert.equal(m['og:type'], 'product');
    assert.ok(m['og:description'].length > 10);
    assert.match(m['og:image'], /^https?:\/\/.+\.(png|jpe?g|webp)$/i, `absolute, non-SVG image: ${m['og:image']}`);
    assert.equal(m['twitter:card'], 'summary_large_image');
    assert.equal(m['twitter:image'], m['og:image']);
    assert.equal(m['product:price:currency'], 'INR');
  }
  await run('UPDATE products SET stock = 50, sku = NULL WHERE id = ?', p.id);
});

test('21. canonical/share URLs come from APP_URL, never from the Host header', async () => {
  const p = await product();
  const { port } = new URL(app.base);
  const html = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/share/product/${p.slug}`, headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, new RegExp(`${APP_URL}/share/product/${p.slug}`));
});

test('18. a share link opens ONLY that charm — it unlocks no other product, listing, search, bag or checkout', async () => {
  const p = await product();
  const v = visitor();
  assert.equal((await raw(`/share/product/${p.slug}`)).status, 200);
  for (const url of GATED_GETS('strawberry-shortcake-charm')) assert.equal((await v('GET', url)).status, 401, url);
  for (const page of GATED_PAGES('strawberry-shortcake-charm')) assert.equal((await raw(page)).status, 302, page);
  assert.equal((await v('POST', '/api/cart/items', { productId: p.id, quantity: 1 })).status, 401);
  // there is no public JSON product API to abuse instead
  for (const url of ['/api/share/products/cherry-twins', '/api/share/product/cherry-twins', '/api/products/share/cherry-twins']) {
    assert.ok([401, 404].includes((await v('GET', url)).status), url);
  }
});

test('19. archived, unknown or malformed share links show a safe "unavailable" page that reveals nothing', async () => {
  const p = await product('cherry-twins');
  await run('UPDATE products SET is_active = false WHERE id = ?', p.id);
  for (const slug of [p.slug, 'no-such-charm', '..%2F..%2Fetc%2Fpasswd', 'a'.repeat(300), '%3Cscript%3E']) {
    const r = await raw(`/share/product/${slug}`);
    assert.equal(r.status, 404, slug);
    const html = await r.text();
    assert.match(html, /wandered off/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html, new RegExp(p.name), 'an archived product\'s name is not shown');
    assert.doesNotMatch(html, /<script>|og:image/);
  }
  await run('UPDATE products SET is_active = true WHERE id = ?', p.id);
});

/* ───────── the "confirm your email" page: was a link ever sent? (accounts from before confirmation existed) ───────── */

test('status: tells the page whether a link was ever sent — read-only, never sends an email', async () => {
  assert.equal((await visitor()('GET', '/api/auth/verify-email/status')).status, 401, 'signed-in customers only');

  // a new sign-up has been sent its link
  const fresh = await signUp();
  const before = sent.length;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await fresh('GET', '/api/auth/verify-email/status')).data, { emailVerified: false, linkSent: true });
  }
  await settleBackground();
  assert.equal(sent.length, before, 'opening/refreshing the page sends nothing');

  // an account created BEFORE email confirmation existed: no link yet
  const { hashPassword } = await import('../server/lib/auth.js');
  const email = `legacy-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const { id } = await run('INSERT INTO users(email, password_hash, name) VALUES (?,?,?)', email, hashPassword('old-password-123'), 'Old Customer');
  const legacy = visitor();
  const login = await legacy('POST', '/api/auth/login', { email, password: 'old-password-123' });
  assert.deepEqual([login.status, login.data.user.emailVerified], [200, false], 'existing customers can still log in');
  await settleBackground();
  assert.equal(mailTo(email).length, 0, 'logging in sends nothing');
  for (let i = 0; i < 3; i++) assert.deepEqual((await legacy('GET', '/api/auth/verify-email/status')).data, { emailVerified: false, linkSent: false });
  await settleBackground();
  assert.equal(mailTo(email).length, 0, 'still nothing until they ask');

  // they ask for their first link → it is sent, and the limits still apply
  assert.equal((await legacy('POST', '/api/auth/verify-email/resend', {})).status, 200);
  await settleBackground();
  assert.equal(mailTo(email).length, 1);
  assert.equal((await legacy('GET', '/api/auth/verify-email/status')).data.linkSent, true);
  const again = await legacy('POST', '/api/auth/verify-email/resend', {});
  assert.deepEqual([again.status, again.data.details.cooldown], [429, true], '60-second cooldown preserved');
  await run("UPDATE email_verifications SET created_at = created_at - interval '2 minutes' WHERE user_id = ?", id);
  // 1 real link + 4 more today = the daily five
  for (let i = 0; i < 4; i++) await run("INSERT INTO email_verifications(token_hash, user_id, expires_at, created_at) VALUES (?, ?, now() + interval '1 day', now() - interval '1 hour')", crypto.randomUUID(), id);
  const capped = await legacy('POST', '/api/auth/verify-email/resend', {});
  assert.deepEqual([capped.status, capped.data.details.dailyLimit], [429, true], 'five-per-24-hours limit preserved');

  // an expired link still counts as "sent before"; confirming flips emailVerified
  await run("UPDATE email_verifications SET expires_at = now() - interval '1 second' WHERE user_id = ?", id);
  assert.equal((await legacy('GET', '/api/auth/verify-email/status')).data.linkSent, true);
  await run('UPDATE email_verifications SET expires_at = now() + interval \'1 hour\' WHERE user_id = ?', id);
  const token = new URL(linkIn(mailTo(email)[0])).searchParams.get('token');
  assert.equal((await visitor()('POST', '/api/auth/verify-email', { token })).status, 200);
  assert.deepEqual((await legacy('GET', '/api/auth/verify-email/status')).data, { emailVerified: true, linkSent: false });
  assert.equal((await legacy('GET', '/api/products')).status, 200, 'and the boutique opens');
});

test('vercel.json routes the gated pages and share links through the server and bundles server/pages', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const toFn = new Set(v.rewrites.filter((r) => r.destination === '/api/index').map((r) => r.source));
  for (const s of ['/share/product/:slug', '/p/:slug', '/collection/:slug', '/shop', '/shop.html', '/cart', '/cart.html', '/checkout', '/checkout.html']) {
    assert.ok(toFn.has(s), `${s} → function`);
  }
  // the gated rewrites come before the catch-all "/:page → /:page.html"
  const catchAll = v.rewrites.findIndex((r) => r.source.startsWith('/:page'));
  assert.ok(v.rewrites.findIndex((r) => r.source === '/shop') < catchAll);
  assert.match(v.functions['api/index.js'].includeFiles, /server\/pages/);
  assert.match(v.functions['api/index.js'].includeFiles, /supabase\/migrations/);
});
