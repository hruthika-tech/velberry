/**
 * Today's Special — admin selection, publishing rules, public board, and graceful handling of
 * hidden / deleted products. Runs against a throwaway Postgres database like the other tests.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, makeClient, startApp } from './helpers/env.js';

const env = await setupTestEnv('special');
const { one, run, closeDb } = await import('../server/db/index.js');

let app;
let admin;
const ids = {};
before(async () => {
  app = await startApp();
  admin = makeClient(() => app.base);
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  for (const slug of ['cherry-twins', 'daisy-dream', 'bunny-bun', 'coquette-bow', 'tulip-bouquet']) {
    ids[slug] = (await one('SELECT id FROM products WHERE slug = ?', slug)).id;
  }
});
after(async () => { await app.close(); await closeDb(); await env.drop(); });

const visitor = () => makeClient(() => app.base);
const save = (body) => admin('PUT', '/api/admin/todays-special', { isActive: true, showAgain: 'session', ...body });
const counts = async () => one('SELECT (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM product_images)::int AS images');

test('nothing is published until the admin publishes it', async () => {
  assert.deepEqual((await visitor()('GET', '/api/todays-special')).data, { active: false });
  const cfg = (await admin('GET', '/api/admin/todays-special')).data;
  assert.equal(cfg.isActive, false);
  assert.deepEqual(cfg.slots.map((s) => s.problem), ['empty', 'empty', 'empty']);
});

test('only admins can see or change the selection', async () => {
  const v = visitor();
  assert.equal((await v('GET', '/api/admin/todays-special')).status, 401);
  assert.equal((await v('PUT', '/api/admin/todays-special', { isActive: true, showAgain: 'session', productIds: [1, 2, 3] })).status, 401);
  const customer = visitor();
  assert.equal((await customer('POST', '/api/auth/signup', { name: 'Mira', email: 'mira@example.com', password: 'mira-password-1' })).status, 201);
  assert.equal((await customer('GET', '/api/admin/todays-special')).status, 403);
  assert.equal((await customer('PUT', '/api/admin/todays-special', { isActive: true, showAgain: 'session', productIds: [1, 2, 3] })).status, 403);
  assert.equal((await one('SELECT is_active FROM todays_special WHERE id = 1')).is_active, false, 'nothing changed');
});

test('publishing needs exactly three different, existing, live products', async () => {
  const two = await save({ productIds: [ids['cherry-twins'], ids['daisy-dream'], null] });
  assert.equal(two.status, 400);
  assert.ok(two.data.details.slot3);
  assert.equal((await save({ productIds: [ids['cherry-twins'], ids['cherry-twins'], ids['bunny-bun']] })).status, 400, 'duplicates refused');
  const ghost = await save({ productIds: [ids['cherry-twins'], ids['daisy-dream'], 999999] });
  assert.equal(ghost.status, 400);
  assert.match(ghost.data.details.slot3, /no longer exists/);
  assert.equal((await save({ productIds: [1, 2] })).status, 400, 'must send three places');
  assert.equal((await save({ productIds: [ids['cherry-twins'], ids['daisy-dream'], ids['bunny-bun']], showAgain: 'forever' })).status, 400);
  // a draft (switched off) may be incomplete
  assert.equal((await save({ isActive: false, productIds: [ids['cherry-twins'], null, null] })).status, 200);
});

test('publish → the public board shows the three real products in the chosen order, with their original photos', async () => {
  const before = await counts();
  const r = await save({ productIds: [ids['cherry-twins'], ids['daisy-dream'], ids['bunny-bun']], showAgain: 'day' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const board = (await visitor()('GET', '/api/todays-special')).data;
  assert.equal(board.active, true);
  assert.equal(board.showAgain, 'day');
  assert.deepEqual(board.products.map((p) => p.slug), ['cherry-twins', 'daisy-dream', 'bunny-bun']);
  for (const p of board.products) {
    const full = (await visitor()('GET', `/api/products/${p.slug}`)).data;
    assert.equal(p.name, full.name);
    assert.equal(p.image, full.image, 'same original image URL as the product page');
    assert.equal(p.shortDesc, full.shortDesc);
    assert.equal(p.price, Math.min(full.price, ...full.variants.map((v) => v.price)));
    assert.ok(['in_stock', 'low', 'sold_out'].includes(p.availability.status));
  }
  assert.deepEqual(await counts(), before, 'no products or images were duplicated');
  const row = await one('SELECT * FROM todays_special WHERE id = 1');
  assert.equal(row.updated_by, (await one("SELECT id FROM users WHERE email = 'owner@test.local'")).id);
});

test('reorder, and replace one product without touching the other two', async () => {
  let cfg = (await admin('GET', '/api/admin/todays-special')).data;
  let r = await save({ productIds: [ids['bunny-bun'], ids['cherry-twins'], ids['daisy-dream']], updatedAt: cfg.updatedAt });
  assert.equal(r.status, 200);
  assert.deepEqual((await visitor()('GET', '/api/todays-special')).data.products.map((p) => p.slug), ['bunny-bun', 'cherry-twins', 'daisy-dream']);
  r = await save({ productIds: [ids['bunny-bun'], ids['coquette-bow'], ids['daisy-dream']], updatedAt: r.data.updatedAt });
  assert.equal(r.status, 200);
  assert.deepEqual((await visitor()('GET', '/api/todays-special')).data.products.map((p) => p.slug), ['bunny-bun', 'coquette-bow', 'daisy-dream']);
  // a save based on an out-of-date copy (another tab) is refused instead of silently overwriting
  const stale = await save({ productIds: [ids['cherry-twins'], ids['coquette-bow'], ids['daisy-dream']], updatedAt: cfg.updatedAt });
  assert.equal(stale.status, 409);
  cfg = (await admin('GET', '/api/admin/todays-special')).data;
  assert.deepEqual(cfg.slots.map((s) => s.productId), [ids['bunny-bun'], ids['coquette-bow'], ids['daisy-dream']]);
});

test('a hidden product disappears from the board and is flagged for the admin', async () => {
  await run('UPDATE products SET is_active = false WHERE id = ?', ids['coquette-bow']);
  const board = (await visitor()('GET', '/api/todays-special')).data;
  assert.deepEqual(board.products.map((p) => p.slug), ['bunny-bun', 'daisy-dream']);
  const cfg = (await admin('GET', '/api/admin/todays-special')).data;
  assert.equal(cfg.slots[1].problem, 'hidden');
  const r = await save({ productIds: cfg.slots.map((s) => s.productId) });
  assert.equal(r.status, 400, 'cannot re-publish with a hidden product');
  assert.match(r.data.details.slot2, /hidden/);
  await run('UPDATE products SET is_active = true WHERE id = ?', ids['coquette-bow']);
});

test('a sold-out product stays on the board, marked sold out', async () => {
  await run('UPDATE products SET sold_out = true WHERE id = ?', ids['daisy-dream']);
  const p = (await visitor()('GET', '/api/todays-special')).data.products.find((x) => x.slug === 'daisy-dream');
  assert.equal(p.availability.status, 'sold_out');
  assert.equal((await admin('GET', '/api/admin/todays-special')).data.slots[2].problem, 'sold_out');
  await run('UPDATE products SET sold_out = false WHERE id = ?', ids['daisy-dream']);
});

test('a deleted product leaves an empty place the admin can fill; the others stay', async () => {
  // tulip-bouquet has no orders, so the admin delete really deletes it
  let r = await save({ productIds: [ids['bunny-bun'], ids['tulip-bouquet'], ids['daisy-dream']] });
  assert.equal(r.status, 200);
  assert.equal((await admin('DELETE', `/api/admin/products/${ids['tulip-bouquet']}`)).data.deleted, true);
  assert.deepEqual((await visitor()('GET', '/api/todays-special')).data.products.map((p) => p.slug), ['bunny-bun', 'daisy-dream']);
  const cfg = (await admin('GET', '/api/admin/todays-special')).data;
  assert.deepEqual(cfg.slots.map((s) => s.problem), [null, 'empty', null]);
  r = await save({ productIds: [ids['bunny-bun'], ids['cherry-twins'], ids['daisy-dream']] });
  assert.equal(r.status, 200);
  assert.deepEqual((await visitor()('GET', '/api/todays-special')).data.products.map((p) => p.slug), ['bunny-bun', 'cherry-twins', 'daisy-dream']);
});

test('switching it off hides the board but keeps the selection', async () => {
  const r = await save({ isActive: false, productIds: [ids['bunny-bun'], ids['cherry-twins'], ids['daisy-dream']] });
  assert.equal(r.status, 200);
  assert.deepEqual((await visitor()('GET', '/api/todays-special')).data, { active: false });
  assert.deepEqual(r.data.slots.map((s) => s.productId), [ids['bunny-bun'], ids['cherry-twins'], ids['daisy-dream']]);
});

test('the homepage loads the curtain assets and still contains every original section', async () => {
  const html = await (await fetch(`${app.base}/`)).text();
  assert.match(html, /<link rel="stylesheet" href="\/css\/curtain\.css">/);
  assert.match(html, /<script src="\/js\/curtain-boot\.js"><\/script>/);
  for (const marker of ['class="hero', 'class="gift-stage"', 'id="featured"', 'id="closer-look"', 'id="menu"', 'id="story"']) assert.ok(html.includes(marker), marker);
  for (const f of ['/js/curtain.js', '/js/curtain-boot.js', '/css/curtain.css']) assert.equal((await fetch(app.base + f)).status, 200, f);
});
