/**
 * Create an admin, or reset an existing admin's password:
 *   npm run create-admin -- owner@example.com "A strong password" "Your Name"
 *
 * Options (strictly parsed — a look-alike such as "--production=yes" is an error, never ignored):
 *   --production        required when the target is the Production project (PRODUCTION_SUPABASE_REF)
 *   --promote-existing  allow turning an existing CUSTOMER account into an admin (this also replaces its password).
 *                       Without it, an existing customer account is never touched.
 *
 * Schema changes are NOT made here: run `npm run db:migrate` first on a new database.
 */
import { parseArgs } from 'node:util';

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { production: { type: 'boolean', default: false }, 'promote-existing': { type: 'boolean', default: false } },
  });
} catch (e) {
  console.error(`\n✗ create-admin: ${e.message}\n`);
  process.exit(1);
}
const { values: opt, positionals } = parsed;
const [email, password, name = 'Shop Owner', ...extra] = positionals;
if (!email || !password || password.length < 10 || extra.length) {
  console.error('Usage: npm run create-admin -- <email> "<password (10+ chars)>" ["Name"] [--production] [--promote-existing]');
  process.exit(1);
}

// Before any database request: Production needs --production (see server/lib/script-guard.js).
const { guardScript } = await import('../server/lib/script-guard.js');
guardScript('create-admin', opt.production ? ['--production'] : []);

const { one, run, closeDb } = await import('../server/db/index.js');
const { hashPassword } = await import('../server/lib/auth.js');
try {
  const u = await one('SELECT id, role FROM users WHERE email = ?', email.toLowerCase());
  if (u && u.role !== 'admin' && !opt['promote-existing']) {
    console.error(`\n✗ create-admin: ${email} is an existing CUSTOMER account. Nothing was changed.`
      + '\n  To make it an admin (this also replaces its password), run again with --promote-existing.\n');
    process.exitCode = 2;
  } else if (u) {
    await run("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?", hashPassword(password), u.id);
    console.log(u.role === 'admin' ? `✿ Admin ${email}: password updated.` : `✿ ${email} promoted to admin (--promote-existing; password replaced).`);
  } else {
    await run("INSERT INTO users(email, password_hash, name, role) VALUES (?,?,?,'admin')", email.toLowerCase(), hashPassword(password), name);
    console.log(`✿ Admin ${email} created.`);
  }
} catch (e) {
  if (e.code !== '42P01') throw e; // undefined_table
  console.error('\n✗ create-admin: the users table does not exist yet — run `npm run db:migrate` first.\n');
  process.exitCode = 1;
} finally {
  await closeDb();
}
