#!/usr/bin/env node
/**
 * Create / update the PostgreSQL schema (applies supabase/migrations/*.sql that haven't run yet). Safe to re-run.
 * The server also does this on start; this command lets you prepare the database without starting the shop.
 *   npm run db:migrate
 */
const { config } = await import('../server/config.js');
if (!config.db.url) {
  console.error('\n✗ DATABASE_URL is not set (see README → Supabase).\n');
  process.exit(1);
}
// Refuses Production unless run as `npm run db:migrate -- --production` (see server/lib/script-guard.js).
(await import('../server/lib/script-guard.js')).guardScript('db:migrate');
const { migrate, all, closeDb } = await import('../server/db/index.js');
try {
  await migrate({ log: (m) => console.log(`   ${m}`) });
  const done = await all('SELECT name, applied_at FROM schema_migrations ORDER BY name');
  console.log(`\n✓ Schema up to date on ${new URL(config.db.url).hostname}: ${done.map((d) => d.name).join(', ')}\n`);
} finally {
  await closeDb();
}
