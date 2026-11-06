/**
 * Vercel compatibility: one-connection locks (the whole file runs with DB_POOL_MAX=1, stricter than Vercel's 2),
 * direct browser → Supabase Storage uploads, emails without a writable disk, secured cron endpoints, releasing
 * expired checkouts without a timer, the serverless entry (api/index.js), vercel.json and the Vercel config rules.
 * Storage and Shiprocket are local fakes; payments use the simulator. Nothing real is called.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { setupTestEnv, makeClient, startApp, customer, address } from './helpers/env.js';
import { startFakeStorage } from './helpers/fake-storage.js';
import { startFakeShiprocket } from './helpers/fake-shiprocket.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVICE_KEY = 'sb_secret_vercel_test_key';
const CRON_SECRET = 'cron-secret-for-tests-0123456789';
const SR = { email: 'api-user@velberry.test', password: 'fake-shiprocket-password-never-shown' };
const storageFake = await startFakeStorage({ serviceKey: SERVICE_KEY });
const srFake = await startFakeShiprocket(SR);
const env = await setupTestEnv('vercel', {
  DB_POOL_MAX: '1', CRON_SECRET, CHECKOUT_EXPIRY_ON_REQUEST: 'true',
  SUPABASE_URL: storageFake.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SHIPROCKET_EMAIL: SR.email, SHIPROCKET_PASSWORD: SR.password, SHIPROCKET_API_BASE: srFake.url, SHIPROCKET_ALLOW_BOOKING: 'true',
  SHIPROCKET_PICKUP_LOCATION: 'Velberry Studio', PICKUP_PINCODE: '', SHIPPING_FEE_MODE: 'flat', RESEND_API_KEY: '',
});
const db = await import('../server/db/index.js');
const { one, run, closeDb, withLock, tx, LOCK_BUSY, pool } = db;
const { resetRateLimits } = await import('../server/lib/auth.js');
const { config } = await import('../server/config.js');
const storage = await import('../server/services/storage.js');
const { settleBackground, runInBackground } = await import('../server/lib/background.js');
const { NOT_SENT } = await import('../server/services/notifications.js');
const { SECURITY_HEADERS } = await import('../server/lib/security-headers.js');

let app;
before(async () => { await storage.ensureBuckets(); app = await startApp(); });
beforeEach(() => resetRateLimits());
after(async () => { await settleBackground(); await app.close(); await closeDb(); await env.drop(); await storageFake.close(); await srFake.close(); });

const client = () => makeClient(() => app.base);
let adminClient;
async function admin() {
  if (!adminClient) {
    adminClient = client();
    assert.equal((await adminClient('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  }
  return adminClient;
}
/** Session cookie for raw fetches (HTML responses). */
async function adminCookie() {
  const r = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.local', password: 'test-password-123' }) });
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
/** Hold a lock from OUTSIDE the app's pool (the pool has a single connection in this file). */
async function holdLock(key) {
  const c = new pg.Client({ connectionString: env.url });
  await c.connect();
  await c.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
  return () => c.end();
}
async function product() {
  const p = await one("SELECT * FROM products WHERE slug = 'cherry-twins'");
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false WHERE id = ?', p.id);
  return p;
}
async function pendingOrder() {
  const c = client();
  const p = await product();
  await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  const o = await c('POST', '/api/checkout/order', { customer, address, idempotencyKey: crypto.randomUUID() });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  return { c, o: o.data, p };
}
async function paidOrder() {
  const { c, o } = await pendingOrder();
  const pay = await c('POST', '/api/checkout/mock-pay', { orderNumber: o.orderNumber, accessToken: o.accessToken });
  const v = await c('POST', '/api/checkout/verify', { orderNumber: o.orderNumber, accessToken: o.accessToken, ...pay.data });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return o;
}
const orderRow = (n) => one('SELECT * FROM orders WHERE order_number = ?', n);
const cron = (job, auth = `Bearer ${CRON_SECRET}`, method = 'GET') =>
  fetch(`${app.base}/api/cron/${job}`, { method, headers: auth ? { Authorization: auth } : {} }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
/** Exactly what the admin page does: FormData PUT to the signed URL. */
const putSigned = (uploadUrl, bytes, type = 'image/png') => {
  const fd = new FormData();
  fd.append('cacheControl', '31536000');
  fd.append('', new Blob([bytes], { type }), 'photo');
  return fetch(uploadUrl, { method: 'PUT', body: fd, headers: { 'x-upsert': 'false' } });
};
async function signFor(target, id, files) {
  return (await admin())('POST', '/api/admin/uploads/sign', { target, id, files });
}
const objectKey = (ticket) => Buffer.from(ticket.split('.')[0], 'base64url').toString().split('|').slice(0, 2).join('/');

/* ───────── one connection is enough ───────── */

test('locks share one connection: nested locks + transactions finish with a pool of ONE; errors release the lock', async () => {
  assert.equal(config.db.poolMax, 1);
  const out = await withLock('outer', () => withLock('inner', () => tx(async () => tx(async () => (await one('SELECT 41 + 1 AS n')).n))));
  assert.equal(out, 42);

  await assert.rejects(withLock('boom', async () => { throw new Error('fail inside'); }), /fail inside/);
  const probe = new pg.Client({ connectionString: env.url });
  await probe.connect();
  const { rows } = await probe.query("SELECT pg_try_advisory_lock(hashtextextended('boom', 0)) AS ok");
  assert.equal(rows[0].ok, true, 'lock released after the error');
  await probe.end();

  const release = await holdLock('busy-key');
  let ran = false;
  assert.equal(await withLock('busy-key', async () => { ran = true; }, { wait: false }), LOCK_BUSY);
  assert.equal(ran, false);
  await release();
  assert.ok(pool.totalCount <= 1);
});

test('booking a shipment (ship lock → Shiprocket login lock → transactions) and cancel + refund work with a pool of ONE', async () => {
  const o = await paidOrder();
  const t0 = Date.now();
  const b = await (await admin())('POST', `/api/admin/orders/${o.orderNumber}/ship`, {});
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const s = await one('SELECT s.* FROM shipments s JOIN orders o ON o.id = s.order_id WHERE o.order_number = ?', o.orderNumber);
  assert.ok(s.awb_code);
  const c = await (await admin())('POST', `/api/admin/orders/${o.orderNumber}/cancel`, { reason: 'test' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const row = await orderRow(o.orderNumber);
  assert.deepEqual([row.status, row.payment_status], ['cancelled', 'refunded']);
  assert.ok(Date.now() - t0 < 10_000, 'no waiting for a second connection');
  assert.ok(pool.totalCount <= 1);
});

/* ───────── direct uploads ───────── */

test('direct upload: signed URL → browser PUT → server verifies magic bytes → image attached; service key never sent to the browser', async () => {
  const p = await product();
  const s = await signFor('gallery', p.id, [{ name: 'front.png', type: 'image/png', size: PNG.length }]);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.direct, true);
  const [u] = s.data.uploads;
  assert.ok(u.uploadUrl.startsWith(`${storageFake.url}/storage/v1/object/upload/sign/product-images/${p.id}/`));
  assert.ok(!JSON.stringify(s.data).includes(SERVICE_KEY));
  assert.equal((await putSigned(u.uploadUrl, PNG)).status, 200);

  const a = await (await admin())('POST', `/api/admin/products/${p.id}/images`, { kind: 'gallery', uploads: [{ ticket: u.ticket, alt: 'Front' }] });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const url = storage.publicUrl('product-images', objectKey(u.ticket).replace(/^product-images\//, ''));
  assert.ok(a.data.images.some((i) => i.url === url && i.alt === 'Front'));

  const again = await (await admin())('POST', `/api/admin/products/${p.id}/images`, { kind: 'gallery', uploads: [{ ticket: u.ticket }] });
  assert.equal(again.status, 409, 'a ticket can be used once');
  assert.ok(storageFake.objects.has(objectKey(u.ticket)), 'the image in use is not deleted by a repeated claim');
});

test('direct upload rejects: wrong type/size at signing, forged or foreign tickets, a file lying about its type, a missing upload, non-admins', async () => {
  const p = await product();
  const other = await one('SELECT id FROM products WHERE id <> ? ORDER BY id LIMIT 1', p.id);
  const gif = await signFor('gallery', p.id, [{ name: 'anim.gif', type: 'image/gif', size: 100 }]);
  assert.equal(gif.status, 400);
  assert.match(gif.data.error, /anim\.gif is not a JPG, PNG, WebP or AVIF/);
  const big = await signFor('gallery', p.id, [{ name: 'huge.jpg', type: 'image/jpeg', size: 11 * 1024 * 1024 }]);
  assert.equal(big.status, 400);
  assert.match(big.data.error, /huge\.jpg is larger than 10 MB/);
  assert.equal((await client()('POST', '/api/admin/uploads/sign', { target: 'gallery', id: p.id, files: [{ name: 'a.png', type: 'image/png', size: 10 }] })).status, 401);

  const [u] = (await signFor('gallery', p.id, [{ name: 'a.png', type: 'image/png', size: PNG.length }])).data.uploads;
  const forged = `${u.ticket.split('.')[0]}.${'A'.repeat(43)}`;
  assert.equal((await (await admin())('POST', `/api/admin/products/${p.id}/images`, { kind: 'gallery', uploads: [{ ticket: forged }] })).status, 400);
  const foreign = await (await admin())('POST', `/api/admin/products/${other.id}/images`, { kind: 'gallery', uploads: [{ ticket: u.ticket }] });
  assert.equal(foreign.status, 400);
  assert.match(foreign.data.error, /different item/);
  const wrongBucket = await (await admin())('POST', `/api/admin/products/${p.id}/images`, { kind: 'angle', uploads: [{ ticket: u.ticket }] });
  assert.equal(wrongBucket.status, 400);
  const missing = await (await admin())('POST', `/api/admin/products/${p.id}/images`, { kind: 'gallery', uploads: [{ ticket: u.ticket }] });
  assert.equal(missing.status, 400, 'signed but never uploaded');
  assert.match(missing.data.error, /did not finish uploading/);

  const [liar] = (await signFor('gallery', p.id, [{ name: 'x.png', type: 'image/png', size: 40 }])).data.uploads;
  assert.equal((await putSigned(liar.uploadUrl, Buffer.from('<script>alert(1)</script> not an image'))).status, 200);
  const l = await (await admin())('POST', `/api/admin/products/${p.id}/images`, { kind: 'gallery', uploads: [{ ticket: liar.ticket }] });
  assert.equal(l.status, 400);
  assert.match(l.data.error, /not the JPG, PNG, WebP or AVIF image it claimed to be/);
  assert.equal(storageFake.objects.has(objectKey(liar.ticket)), false, 'the bad file is deleted');
  assert.equal(await one('SELECT 1 FROM product_images WHERE url LIKE ?', `%${objectKey(liar.ticket).split('/').pop()}`), undefined);

  const [wrongType] = (await signFor('gallery', p.id, [{ name: 'y.png', type: 'image/png', size: 40 }])).data.uploads;
  assert.equal((await putSigned(wrongType.uploadUrl, PNG, 'text/html')).status, 400, 'the bucket refuses other content types');
});

test('direct upload for a category image, and the local (no Supabase) fallback answer', async () => {
  const cat = await one('SELECT * FROM categories ORDER BY id LIMIT 1');
  const s = await signFor('category', cat.id, [{ name: 'cat.png', type: 'image/png', size: PNG.length }]);
  assert.equal(s.status, 200);
  const [u] = s.data.uploads;
  assert.equal((await putSigned(u.uploadUrl, PNG)).status, 200);
  const r = await (await admin())('POST', `/api/admin/categories/${cat.id}/image`, { ticket: u.ticket });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await one('SELECT image_url FROM categories WHERE id = ?', cat.id)).image_url, r.data.imageUrl);
  assert.equal((await signFor('nonsense', cat.id, [])).status, 400);

  config.supabase.storageEnabled = false;
  try {
    assert.deepEqual((await signFor('gallery', (await product()).id, [{ name: 'a.png', type: 'image/png', size: 9 }])).data, { direct: false });
  } finally {
    config.supabase.storageEnabled = true;
  }
});

/* ───────── emails ───────── */

test('without Resend nothing is written to disk: the email is logged and can be previewed by the admin only', async () => {
  const o = await paidOrder();
  await settleBackground();
  const row = await one("SELECT n.* FROM notifications n JOIN orders o ON o.id = n.order_id WHERE o.order_number = ? AND n.type = 'order_confirmed'", o.orderNumber);
  assert.equal(row.status, 'logged');
  assert.equal(row.error, NOT_SENT);
  assert.equal(fs.existsSync(path.join(env.tmp, 'outbox')), false, 'no outbox folder');

  const html = await fetch(`${app.base}/api/admin/notifications/${row.id}/preview`, { headers: { Cookie: await adminCookie() } });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok((await html.text()).includes(o.orderNumber));
  assert.equal((await fetch(`${app.base}/api/admin/notifications/${row.id}/preview`)).status, 401);
  assert.equal((await fetch(`${app.base}/api/admin/notifications/99999999/preview`, { headers: { Cookie: await adminCookie() } })).status, 404);
});

test('background work is handed to Vercel\'s waitUntil when the platform provides it', async () => {
  const KEY = Symbol.for('@vercel/request-context');
  const seen = [];
  globalThis[KEY] = { get: () => ({ waitUntil: (p) => seen.push(p) }) };
  try {
    let done = false;
    runInBackground(new Promise((r) => setTimeout(r, 20)).then(() => { done = true; }));
    assert.equal(seen.length, 1);
    await seen[0];
    assert.equal(done, true);
  } finally {
    delete globalThis[KEY];
  }
  runInBackground(Promise.reject(new Error('logged, not thrown'))); // never an unhandled rejection
  await settleBackground();
});

/* ───────── cron ───────── */

test('cron endpoints: bearer secret required, jobs run, unknown job 404, overlapping run skipped, off without CRON_SECRET', async () => {
  assert.equal((await cron('expire-checkouts', null)).status, 401);
  assert.equal((await cron('expire-checkouts', 'Bearer wrong')).status, 401);
  assert.equal((await cron('expire-checkouts', CRON_SECRET)).status, 401, 'the Bearer prefix is required');

  const { o } = await pendingOrder();
  await run("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE order_number = ?", o.orderNumber);
  const e = await cron('expire-checkouts');
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.equal(e.data.ok, true);
  assert.ok(e.data.checked >= 1);
  assert.equal((await orderRow(o.orderNumber)).status, 'abandoned');

  const all = await cron('all', `Bearer ${CRON_SECRET}`, 'POST');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.results.map((x) => [x.job, x.ok]), [['expire-checkouts', true], ['tracking-sync', true]]);
  assert.equal((await cron('nope')).status, 404);
  assert.equal((await cron('expire-checkouts', `Bearer ${CRON_SECRET}`, 'PUT')).status, 405);

  const release = await holdLock('cron:tracking-sync');
  try {
    assert.deepEqual((await cron('tracking-sync')).data, { job: 'tracking-sync', skipped: 'already running' });
  } finally {
    await release();
  }

  config.cronSecret = '';
  try {
    assert.equal((await cron('expire-checkouts')).status, 503);
  } finally {
    config.cronSecret = CRON_SECRET;
  }
});

test('without a timer, expired checkouts are released when a checkout starts — at most once per 5 minutes', async () => {
  const first = await pendingOrder(); // (starting this checkout used the current 5-minute slot)
  const p = first.p;
  const stockBefore = (await one('SELECT stock FROM products WHERE id = ?', p.id)).stock;
  await run("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE order_number = ?", first.o.orderNumber);
  await run("UPDATE settings SET value = '0' WHERE key = 'job_expire_checkouts_last_run'"); // last run long ago
  const q = await client()('POST', '/api/checkout/quote', { pincode: '560001' }); // empty bag → 400, but the check ran first
  assert.equal(q.status, 400);
  assert.equal((await orderRow(first.o.orderNumber)).status, 'abandoned');
  assert.equal((await one('SELECT stock FROM products WHERE id = ?', p.id)).stock, stockBefore + 1, 'stock released');

  const second = await pendingOrder();
  await run("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE order_number = ?", second.o.orderNumber);
  await client()('POST', '/api/checkout/quote', { pincode: '560001' });
  assert.equal((await orderRow(second.o.orderNumber)).status, 'pending_payment', 'throttled: ran less than 5 minutes ago');
  await run("UPDATE settings SET value = '0' WHERE key = 'job_expire_checkouts_last_run'");
  await client()('POST', '/api/checkout/quote', { pincode: '560001' });
  assert.equal((await orderRow(second.o.orderNumber)).status, 'abandoned');
});

/* ───────── serverless entry + vercel.json ───────── */

test('api/index.js serves the app, and answers 503 (without changing the schema) when a migration is missing', async () => {
  const serve = async (mod) => {
    const srv = http.createServer(mod.default);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
  };
  const ok = await serve(await import('../api/index.js'));
  try {
    const h = await fetch(`${ok.base}/healthz`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).ok, true);
    assert.equal((await fetch(`${ok.base}/api/products`)).status, 200);
    assert.equal((await fetch(`${ok.base}/api/cron/all`)).status, 401);
  } finally { await ok.close(); }

  await run("DELETE FROM schema_migrations WHERE name = '004_todays_special.sql'");
  try {
    const blocked = await serve(await import('../api/index.js?fresh=1'));
    try {
      const r = await fetch(`${blocked.base}/api/products`);
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /being updated/);
      assert.equal(await one("SELECT 1 FROM schema_migrations WHERE name = '004_todays_special.sql'"), undefined, 'did not migrate by itself');
    } finally { await blocked.close(); }
  } finally {
    await run("INSERT INTO schema_migrations(name) VALUES ('004_todays_special.sql')");
  }
});

test('vercel.json: same security headers as Express, API + cron routed to the function, migrations bundled', async () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const site = v.headers.find((h) => h.source === '/((?!api/).*)');
  assert.deepEqual(Object.fromEntries(site.headers.map((h) => [h.key, h.value])), SECURITY_HEADERS);
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /connect-src [^;]*https:\/\/\*\.supabase\.co/);
  const page = await fetch(`${app.base}/`);
  assert.equal(page.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
  assert.deepEqual(v.rewrites[0], { source: '/api/(.*)', destination: '/api/index' });
  assert.ok(v.rewrites.some((r) => r.source === '/healthz'));
  assert.equal(v.outputDirectory, 'public');
  assert.match(v.functions['api/index.js'].includeFiles, /supabase\/migrations/);
  for (const c of v.crons) assert.match(c.path, /^\/api\/cron\/(all|expire-checkouts|tracking-sync)$/);
  assert.equal(v.crons.length, 1, 'Hobby: one daily cron');
});

/* ───────── Vercel configuration rules (fresh processes) ───────── */

function runNode(args, extra) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VELBERRY_SKIP_ENV_FILE: '1', SESSION_SECRET: 'q'.repeat(40),
        DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/x', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ...extra },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
async function cfg(extra) {
  const { out } = await runNode(['--input-type=module', '-e', `const { config: c } = await import('./server/config.js');
    console.log(JSON.stringify({ appUrl: c.appUrl, pay: c.payments.provider, pool: c.db.poolMax, booking: c.shiprocket.allowBooking,
      expiry: c.checkoutExpiryOnRequest, serverless: c.serverless, prod: c.isProd }));`], extra);
  try { return JSON.parse(out.trim().split('\n').pop()); } catch { return { error: out }; }
}
const VERCEL_PROD = { VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'velberry.example',
  PAYMENT_PROVIDER: 'razorpay', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };

test('Vercel config: Preview may use the simulator (booking off, pool 2, own https URL); Production never may', async () => {
  const preview = await cfg({ VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', VERCEL_BRANCH_URL: 'velberry-git-main-shop.vercel.app', PAYMENT_PROVIDER: 'mock' });
  assert.deepEqual(preview, { appUrl: 'https://velberry-git-main-shop.vercel.app', pay: 'mock', pool: 2, booking: false, expiry: true, serverless: true, prod: true });
  assert.equal((await cfg({ VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', VERCEL_URL: 'x.vercel.app', PAYMENT_PROVIDER: 'mock', SHIPROCKET_ALLOW_BOOKING: 'true' })).booking, true, 'only if asked');

  const mockProd = await cfg({ ...VERCEL_PROD, PAYMENT_PROVIDER: 'mock' });
  assert.match(mockProd.error, /cannot be used in production/);
  const prod = await cfg(VERCEL_PROD);
  assert.deepEqual([prod.appUrl, prod.pay, prod.pool, prod.booking], ['https://velberry.example', 'razorpay', 2, true]);
  assert.equal((await cfg({ ...VERCEL_PROD, SHIPROCKET_ALLOW_BOOKING: 'false' })).booking, false);
  assert.equal((await cfg({ ...VERCEL_PROD, APP_URL: 'https://shop.velberry.example' })).appUrl, 'https://shop.velberry.example', 'APP_URL wins');
  assert.equal((await cfg({ ...VERCEL_PROD, DB_POOL_MAX: '3' })).pool, 3);
  const local = await cfg({});
  assert.deepEqual([local.appUrl, local.pool, local.serverless, local.expiry], ['http://localhost:3000', 10, false, false]);
});

test('vercel-build copies three.js into public/ and fails the build on an unsafe production setting', async () => {
  const ok = await runNode(['scripts/vercel-build.js'], { VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', VERCEL_URL: 'x.vercel.app', PAYMENT_PROVIDER: 'mock' });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /config ok — preview · app https:\/\/x\.vercel\.app · payments mock/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'vendor', 'three', 'three.module.js')));
  assert.ok(!ok.out.includes('q'.repeat(40)), 'no secrets in the build log');
  const bad = await runNode(['scripts/vercel-build.js'], { ...VERCEL_PROD, PAYMENT_PROVIDER: 'mock' });
  assert.notEqual(bad.code, 0);
});
