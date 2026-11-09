/**
 * SQLite → PostgreSQL migration + Supabase Storage setup, end to end:
 * a fixture SQLite file (built from the legacy schema) is migrated into a throwaway Postgres database,
 * with images uploaded to an in-memory fake of Supabase Storage.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setupTestEnv, makeClient, startApp } from './helpers/env.js';
import { startFakeStorage } from './helpers/fake-storage.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVICE_KEY = 'sb_secret_test_service_key';
const fake = await startFakeStorage({ serviceKey: SERVICE_KEY });
const env = await setupTestEnv('migration', { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: 'sb_publishable_test' });
const { one, all, run, closeDb } = await import('../server/db/index.js');
const { hashPassword } = await import('../server/lib/auth.js');

/* ── fixture: SQLite file + the public/ folder its image URLs point into ── */
const pub = path.join(env.tmp, 'public');
const sqliteFile = path.join(env.tmp, 'legacy.db');
const png = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.createHash('sha256').update(seed).digest()]);
function write(rel, buf) { fs.mkdirSync(path.dirname(path.join(pub, rel)), { recursive: true }); fs.writeFileSync(path.join(pub, rel), buf); }
write('uploads/seed/cherry-twins-1.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
write('uploads/seed/cherry-twins-1.png', png('twin'));
write('uploads/products/7/photo.png', png('photo'));
write('uploads/products/7/frame-01.png', png('frame'));
write('uploads/products/7/clash.png', png('local clash'));

const lite = new DatabaseSync(sqliteFile);
lite.exec(fs.readFileSync(path.join(ROOT, 'server', 'db', 'legacy-sqlite-schema.sql'), 'utf8'));
lite.exec(`
  INSERT INTO users(id, email, password_hash, name, role, created_at) VALUES
    (1, 'owner@test.local', '${hashPassword('migrated-admin-pass')}', 'Shop Owner', 'admin', '2026-01-02 03:04:05'),
    (5, 'Mixed.Case@Example.com', '${hashPassword('customer-pass-1')}', 'Asha', 'customer', '2026-01-03T10:00:00.000Z');
  INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES ('${'a'.repeat(64)}', 5, '2027-01-01T00:00:00.000Z', '2026-01-03 10:00:00');
  INSERT INTO addresses(id, user_id, name, phone, line1, city, state, pincode, is_default) VALUES (3, 5, 'Asha', '9876543210', '12 Rose Lane', 'Bengaluru', 'Karnataka', '560001', 1);
  INSERT INTO categories(id, slug, name, icon, sort_order) VALUES (2, 'sweets', 'Sweets', 'cake', 1);
  INSERT INTO products(id, slug, name, category_id, price, stock, weight_grams, is_active, is_featured, sold_out, created_at, updated_at) VALUES
    (7, 'cherry-twins', 'Cherry Twins', 2, 29900, 4, 30, 1, 1, 0, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
    (9, 'retired-charm', 'Retired Charm', 2, 19900, 0, 30, 0, 0, 1, '2026-01-02 03:04:05', '2026-01-02 03:04:05');
  INSERT INTO product_images(id, product_id, url, alt, kind, sort_order) VALUES
    (10, 7, '/uploads/seed/cherry-twins-1.svg', 'seed art', 'gallery', 0),
    (11, 7, '/uploads/products/7/photo.png', 'photo', 'gallery', 1),
    (12, 7, '/uploads/products/7/frame-01.png', NULL, 'angle', 0),
    (13, 9, '/uploads/products/9/missing.png', NULL, 'gallery', 0),
    (14, 9, '/uploads/products/7/clash.png', NULL, 'gallery', 1);
  INSERT INTO product_variants(id, product_id, name, price, stock, is_active, sort_order) VALUES (4, 7, 'Rose', NULL, 2, 1, 0), (6, 7, 'Mint', 31900, 0, 0, 1);
  INSERT INTO carts(id, user_id, guest_token, updated_at) VALUES (2, 5, NULL, '2026-01-03 10:00:00');
  INSERT INTO cart_items(id, cart_id, product_id, variant_id, quantity) VALUES (1, 2, 7, 4, 1);
  INSERT INTO orders(id, order_number, user_id, idempotency_key, access_token_hash, status, payment_status, customer_name, customer_email, customer_phone,
                     ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_pincode, subtotal, shipping_fee, total, stock_reserved,
                     razorpay_order_id, expires_at, paid_at, created_at, updated_at) VALUES
    (21, 'VB-260103-TEST1', 5, 'k1', '${'b'.repeat(64)}', 'paid', 'paid', 'Asha', 'mixed.case@example.com', '9876543210',
     'Asha', '9876543210', '12 Rose Lane', 'Bengaluru', 'Karnataka', '560001', 29900, 7900, 37800, 1,
     'order_x1', '2026-01-03T10:30:00.000Z', '2026-01-03 10:05:00', '2026-01-03 10:00:00', '2026-01-03 10:05:00');
  INSERT INTO order_items(id, order_id, product_id, variant_id, product_name, variant_name, image_url, unit_price, quantity, line_total)
    VALUES (31, 21, 7, 4, 'Cherry Twins', 'Rose', '/uploads/products/7/photo.png', 29900, 1, 29900);
  INSERT INTO order_status_history(id, order_id, from_status, to_status, note, actor, created_at) VALUES (41, 21, 'pending_payment', 'paid', 'ok', 'razorpay', '2026-01-03 10:05:00');
  INSERT INTO payments(id, order_id, provider_order_id, provider_payment_id, status, method, amount, raw, created_at, updated_at) VALUES
    (51, 21, 'order_x1', 'pay_x1', 'captured', 'upi', 37800, '{"b":2,"a":{"c":[1,2]}}', '2026-01-03 10:05:00', '2026-01-03 10:05:00'),
    (52, 21, 'order_x1', 'pay_x0', 'failed', 'card', 37800, 'not json at all', '2026-01-03 10:01:00', '2026-01-03 10:01:00');
  INSERT INTO inventory_movements(id, product_id, variant_id, delta, reason, order_id) VALUES (61, 7, 4, -1, 'reserve', 21);
  INSERT INTO notifications(id, order_id, type, recipient, subject, status) VALUES (71, 21, 'order_confirmed', 'mixed.case@example.com', 'Hi', 'logged');
  INSERT INTO settings(key, value) VALUES ('shop_note', 'hello');
`);
lite.close();
const sqliteHash = () => crypto.createHash('sha256').update(fs.readFileSync(sqliteFile)).digest('hex');
const originalHash = sqliteHash();

function runScript(file, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', file), ...args], { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const migrateArgs = ['--sqlite', sqliteFile, '--public-dir', pub];
const tableCount = async () => (await one("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).n;
const pubUrl = (bucket, p) => `${fake.url}/storage/v1/object/public/${bucket}/${p}`;

let app;
after(async () => { if (app) await app.close(); await closeDb(); await env.drop(); await fake.close(); });

test('setup-storage creates the three public-read buckets, and the public key cannot upload', async () => {
  const r = await runScript('setup-storage.js');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...fake.buckets.keys()].sort(), ['category-images', 'product-360', 'product-images']);
  for (const b of fake.buckets.values()) assert.equal(b.public, true);
  assert.equal(fake.buckets.get('product-360').allowed_mime_types.includes('image/svg+xml'), false);
  assert.match(r.out, /anonymous upload to product-images is refused/);
  assert.ok(!r.out.includes(SERVICE_KEY), 'secret key never printed');
  assert.equal((await runScript('setup-storage.js')).code, 0, 'safe to re-run');
});

test('dry run reports everything but writes nothing (no tables, no uploads)', async () => {
  const r = await runScript('migrate-sqlite-to-supabase.js', [...migrateArgs, '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Dry run OK/);
  assert.match(r.out, /would upload → product-images\/migrated\/7\/photo\.png/);
  assert.equal(await tableCount(), 0, 'schema creation rolled back too');
  assert.equal(fake.objects.size, 0);
  assert.ok(!r.out.includes('localdev'), 'connection password never printed');
});

test('a Storage object already at the target path is never overwritten', async () => {
  fake.objects.set('product-images/migrated/7/clash.png', { body: png('someone else'), type: 'image/png' });
  // first migrate WITHOUT images: rows keep their local URLs
  const r = await runScript('migrate-sqlite-to-supabase.js', [...migrateArgs, '--skip-images']);
  assert.equal(r.code, 0, r.out);
  assert.equal((await one('SELECT url FROM product_images WHERE id = 11')).url, '/uploads/products/7/photo.png');
});

test('migration copies every row with ids, booleans, timestamps and JSON converted', async () => {
  const counts = await all(`SELECT 'users' t, COUNT(*)::int n FROM users UNION ALL SELECT 'products', COUNT(*) FROM products
    UNION ALL SELECT 'images', COUNT(*) FROM product_images UNION ALL SELECT 'variants', COUNT(*) FROM product_variants
    UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'payments', COUNT(*) FROM payments
    UNION ALL SELECT 'sessions', COUNT(*) FROM sessions UNION ALL SELECT 'settings', COUNT(*) FROM settings`);
  assert.deepEqual(Object.fromEntries(counts.map((c) => [c.t, c.n])), { users: 2, products: 2, images: 5, variants: 2, orders: 1, payments: 2, sessions: 1, settings: 1 });

  const p7 = await one('SELECT * FROM products WHERE id = 7');
  assert.equal(p7.is_active, true); assert.equal(p7.is_featured, true); assert.equal(p7.sold_out, false);
  assert.equal(p7.created_at, '2026-01-02T03:04:05.000Z', 'SQLite datetime() text is read as UTC');
  const p9 = await one('SELECT * FROM products WHERE id = 9');
  assert.equal(p9.is_active, false); assert.equal(p9.sold_out, true);
  assert.equal((await one('SELECT is_active FROM product_variants WHERE id = 6')).is_active, false);
  assert.equal((await one('SELECT is_default FROM addresses WHERE id = 3')).is_default, true);

  const o = await one('SELECT * FROM orders WHERE id = 21');
  assert.equal(o.stock_reserved, true);
  assert.equal(o.paid_at, '2026-01-03T10:05:00.000Z');
  assert.equal(o.expires_at, '2026-01-03T10:30:00.000Z');
  assert.equal(o.user_id, 5, 'foreign keys point at the same records');
  assert.equal((await one('SELECT email FROM users WHERE id = 5')).email, 'mixed.case@example.com');
  assert.deepEqual((await one('SELECT raw FROM payments WHERE id = 51')).raw, { a: { c: [1, 2] }, b: 2 });
  assert.deepEqual((await one('SELECT raw FROM payments WHERE id = 52')).raw, { legacy_text: 'not json at all' });

  // identity sequences continue after the copied ids
  const { id } = await run("INSERT INTO categories(slug, name) VALUES ('new-cat', 'New')");
  assert.ok(id > 2, `new id ${id} is above the migrated ones`);
  await run('DELETE FROM categories WHERE id = ?', id);
});

test('second run uploads images, then switches only the successfully uploaded URLs', async () => {
  const r = await runScript('migrate-sqlite-to-supabase.js', migrateArgs);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 rows added/);
  const urls = Object.fromEntries((await all('SELECT id, url FROM product_images')).map((x) => [x.id, x.url]));
  assert.equal(urls[10], pubUrl('product-images', 'seed/cherry-twins-1.svg'), 'starter art goes where npm run seed puts it');
  assert.equal(urls[11], pubUrl('product-images', 'migrated/7/photo.png'));
  assert.equal(urls[12], pubUrl('product-360', 'migrated/7/frame-01.png'), '360° frames go to the 360 bucket');
  assert.equal(urls[13], '/uploads/products/9/missing.png', 'missing file → URL kept');
  assert.equal(urls[14], '/uploads/products/7/clash.png', 'different object already in Storage → URL kept');
  assert.deepEqual(fake.objects.get('product-images/migrated/7/clash.png').body, png('someone else'), 'existing object not overwritten');
  assert.ok(fake.objects.has('product-images/seed/cherry-twins-1.png'), 'PNG twin uploaded for emails');
  assert.equal((await one('SELECT image_url FROM order_items WHERE id = 31')).image_url, pubUrl('product-images', 'migrated/7/photo.png'));
  assert.deepEqual(fake.objects.get('product-images/migrated/7/photo.png').body, fs.readFileSync(path.join(pub, 'uploads/products/7/photo.png')));
  assert.match(r.out, /file not found on disk/);
  assert.match(r.out, /DIFFERENT file already exists/);
});

test('re-running is a no-op: nothing added, nothing changed, images reused', async () => {
  const before = await all('SELECT * FROM product_images ORDER BY id');
  const r = await runScript('migrate-sqlite-to-supabase.js', migrateArgs);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 rows added/);
  assert.match(r.out, /already in Storage \(identical\)/);
  assert.deepEqual(await all('SELECT * FROM product_images ORDER BY id'), before);
});

test('a record changed in PostgreSQL is never overwritten: the run is rolled back', async () => {
  await run('UPDATE products SET price = 1 WHERE id = 7');
  await run("INSERT INTO settings(key, value) VALUES ('postgres_only', 'x')");
  const r = await runScript('migrate-sqlite-to-supabase.js', migrateArgs);
  assert.equal(r.code, 1);
  assert.match(r.out, /products id=7: already exists in PostgreSQL with different price/);
  assert.match(r.out, /ROLLED BACK/);
  assert.equal((await one('SELECT price FROM products WHERE id = 7')).price, 1, 'PostgreSQL value kept');
  assert.equal((await one("SELECT value FROM settings WHERE key = 'postgres_only'")).value, 'x');
  await run('UPDATE products SET price = 29900 WHERE id = 7');
});

test('the original SQLite file is byte-for-byte unchanged', () => {
  assert.equal(sqliteHash(), originalHash);
});

test('the shop runs on the migrated data: migrated admin logs in, products show Storage images', async () => {
  app = await startApp();
  const c = makeClient(() => app.base);
  const login = await c('POST', '/api/auth/login', { email: 'owner@test.local', password: 'migrated-admin-pass' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const cust = await c('POST', '/api/auth/login', { email: 'Mixed.Case@Example.com', password: 'customer-pass-1' });
  assert.equal(cust.status, 200, 'customer can log in with the same password (any email case)');
  assert.equal((await c('GET', '/api/products/cherry-twins')).status, 403, 'a migrated customer confirms their email before shopping');
  assert.equal((await c('POST', '/api/auth/login', { email: 'owner@test.local', password: 'migrated-admin-pass' })).status, 200);
  const p = await c('GET', '/api/products/cherry-twins'); // admins are never gated
  assert.equal(p.status, 200);
  const product = p.data.product || p.data;
  assert.equal(product.image, pubUrl('product-images', 'seed/cherry-twins-1.svg'));
  assert.equal(product.angleImages.length, 1);
  const lookup = await makeClient(() => app.base)('POST', '/api/orders/lookup', { orderNumber: 'VB-260103-TEST1', email: 'mixed.case@example.com' });
  assert.equal(lookup.status, 200, JSON.stringify(lookup.data));
});
