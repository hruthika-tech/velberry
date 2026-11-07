/**
 * What the long-running server (`npm start` / `npm run dev`) may do to the database before it opens.
 * (Vercel never gets here: api/index.js only checks for pending migrations and never runs them.)
 *
 * Production is recognised by PRODUCTION_SUPABASE_REF; permission comes ONLY from the `--production`
 * command-line argument (`npm start -- --production`), never from an environment variable.
 *   • local / non-Supabase database, or a non-Production project → migrate + seed-if-empty, as before
 *   • the Production project WITH --production                   → migrate + seed-if-empty
 *   • the Production project WITHOUT --production — or a Supabase project when PRODUCTION_SUPABASE_REF is unset
 *     (it might be Production; we don't guess)                    → NOTHING is written: no migration, no seeding.
 *     A read-only check runs instead; if migrations are pending the server refuses to start (it would run against
 *     a schema it doesn't match), otherwise it opens normally.
 *   • --production given but the target isn't Production         → refuses to start (the flag must match reality)
 */
import { scriptTarget } from '../lib/supabase-target.js';

export class StartupRefused extends Error {}

/** Decide, without touching the database. */
export function startupPlan({ argv, dbRef, storageRef, productionRefs }) {
  const d = scriptTarget({ script: 'start', argv, dbRef, storageRef, productionRefs });
  if (d.ok) return { write: true, production: d.production, message: d.message };
  const flagMismatch = argv.includes('--production');
  if (flagMismatch) return { refuse: d.message };
  return {
    write: false,
    production: true,
    message: `${d.ref ? `Supabase project ${d.ref}` : 'this database'} is (or may be) PRODUCTION — not running migrations or seeding automatically`
      + ' (start with `npm start -- --production` to allow it, or apply migrations with `npm run db:migrate -- --production`)',
  };
}

/**
 * Run the plan. db = { migrate, pendingMigrations, seedCatalog, ensureAdmin } (injected so tests can watch the calls).
 * Returns { migrated, seeded }. Throws StartupRefused instead of opening against a mismatched schema.
 */
export async function prepareDatabase({ plan, db, log = console.log }) {
  if (plan.refuse) throw new StartupRefused(plan.refuse);
  log(`   startup → ${plan.message}`);
  if (plan.write) {
    await db.migrate({ log });
    await db.ensureAdmin();
    const seeded = await db.seedCatalog();
    if (seeded) log('✿ Starter catalogue seeded (replace the artwork with your photos in /admin)');
    return { migrated: true, seeded };
  }
  const pending = await db.pendingMigrations(); // read-only
  if (pending.length) {
    throw new StartupRefused(`Production has migrations that are not applied yet (${pending.join(', ')}). Nothing was changed. `
      + 'Apply them deliberately with `npm run db:migrate -- --production`, or start with `npm start -- --production`.');
  }
  return { migrated: false, seeded: false };
}
