/**
 * Database permissions, checked as Supabase's public API roles would see them
 * (the test database is prepared with Supabase's anon / authenticated roles and default grants).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env.js';

const env = await setupTestEnv('security');
const { query, one, all, migrate, closeDb, tx } = await import('../server/db/index.js');
const { seedCatalog } = await import('../server/db/seed.js');

before(async () => { await migrate(); await seedCatalog(); });
after(async () => { await closeDb(); await env.drop(); });

/** Run sql as a public API role inside a transaction that is always rolled back. */
async function asRole(role, sql) {
  try {
    await tx(async () => {
      await query(`SET LOCAL ROLE ${role}`);
      const r = await query(sql);
      const e = new Error('__ok__'); e.rows = r.rows; throw e;
    });
  } catch (e) {
    if (e.message === '__ok__') return { ok: true, rows: e.rows };
    return { ok: false, code: e.code, message: e.message };
  }
}

for (const role of ['anon', 'authenticated']) {
  test(`${role}: cannot read, change or truncate the migration log`, async () => {
    for (const sql of ['SELECT * FROM public.schema_migrations', "INSERT INTO public.schema_migrations(name) VALUES ('x')",
      "DELETE FROM public.schema_migrations", "UPDATE public.schema_migrations SET name = 'x'", 'TRUNCATE public.schema_migrations']) {
      const r = await asRole(role, sql);
      assert.equal(r.ok, false, `${sql} should be refused`);
      assert.equal(r.code, '42501', `${sql}: permission denied (${r.message})`);
    }
  });

  test(`${role}: reads only the live catalogue, nothing private, writes nothing`, async () => {
    assert.ok((await asRole(role, 'SELECT id FROM public.products')).rows.length > 0, 'live products readable');
    for (const t of ['users', 'sessions', 'orders', 'payments', 'addresses', 'carts', 'settings']) {
      assert.equal((await asRole(role, `SELECT 1 FROM public.${t} LIMIT 1`)).code, '42501', `${t} must be private`);
    }
    for (const sql of ["UPDATE public.products SET price = 1", 'TRUNCATE public.products', "DELETE FROM public.categories"]) {
      assert.equal((await asRole(role, sql)).ok, false, `${sql} should be refused`);
    }
  });
}

test('public roles hold exactly SELECT on the catalogue and nothing on any other table', async () => {
  const grants = await all(`SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
    FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    GROUP BY 1, 2 ORDER BY 1, 2`);
  const tables = [...new Set(grants.map((g) => g.table_name))];
  assert.deepEqual(tables, ['categories', 'product_images', 'product_variants', 'products', 'todays_special']);
  assert.ok(grants.every((g) => g.p === 'SELECT'), JSON.stringify(grants));
});

test('every public table has RLS on, and the catalogue + Today\'s Special read policies are intact', async () => {
  const off = await all("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity");
  assert.deepEqual(off, []);
  const pols = await all("SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY 1");
  assert.deepEqual(pols.map((p) => [p.tablename, p.cmd]),
    [['categories', 'SELECT'], ['product_images', 'SELECT'], ['product_variants', 'SELECT'], ['products', 'SELECT'], ['todays_special', 'SELECT']]);
});

for (const role of ['anon', 'authenticated']) {
  test(`${role}: reads Today's Special only while it is published, and can never change it`, async () => {
    await query('UPDATE todays_special SET is_active = false WHERE id = 1');
    assert.equal((await asRole(role, 'SELECT * FROM public.todays_special')).rows.length, 0, 'unpublished → invisible');
    await query('UPDATE todays_special SET is_active = true WHERE id = 1');
    assert.equal((await asRole(role, 'SELECT * FROM public.todays_special')).rows.length, 1, 'published → readable');
    for (const sql of ['UPDATE public.todays_special SET is_active = false', 'DELETE FROM public.todays_special',
      'INSERT INTO public.todays_special (id) VALUES (1)', 'TRUNCATE public.todays_special']) {
      assert.equal((await asRole(role, sql)).code, '42501', `${sql} should be refused`);
    }
    await query('UPDATE todays_special SET is_active = false WHERE id = 1');
  });
}

test('the server role still reads and writes the migration log (and re-running migrations is a no-op)', async () => {
  const before = (await all('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
  assert.ok(before.includes('003_lock_schema_migrations.sql'));
  await migrate();
  assert.deepEqual((await all('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name), before);
  await tx(async () => {
    await query("INSERT INTO schema_migrations(name) VALUES ('zz_probe.sql')");
    assert.ok(await one("SELECT 1 FROM schema_migrations WHERE name = 'zz_probe.sql'"));
    await query("DELETE FROM schema_migrations WHERE name = 'zz_probe.sql'");
  });
});
