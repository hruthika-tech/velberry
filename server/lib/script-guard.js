/**
 * Safeguard 4 for maintenance scripts (db:migrate, setup-storage, seed): stop before touching anything unless the
 * target is known and — for Production — confirmed with an explicit `--production` argument. Production is
 * identified by PRODUCTION_SUPABASE_REF; permission is never taken from .env or environment variables.
 * Call it before the script makes its first database or Storage request.
 */
import { config } from '../config.js';
import { scriptTarget } from './supabase-target.js';

export function guardScript(script, argv = process.argv.slice(2)) {
  const d = scriptTarget({
    script, argv,
    dbRef: config.supabase.dbRef, storageRef: config.supabase.storageRef,
    productionRefs: process.env.PRODUCTION_SUPABASE_REF || '',
  });
  if (!d.ok) {
    console.error(`\n✗ ${script}: ${d.message}\n`);
    process.exit(2);
  }
  console.log(`   ${script} → ${d.message}`);
  return d;
}


// Pure helpers for migrate:sqlite live with the other rules (no config needed): re-exported for convenience.
export { nonEmptyTables, importDecision } from './supabase-target.js';
