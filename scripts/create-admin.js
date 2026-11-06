/**
 * Create or promote an admin:  npm run create-admin -- owner@example.com "A strong password" "Your Name"
 */
import { one, run, migrate, closeDb } from '../server/db/index.js';
import { hashPassword } from '../server/lib/auth.js';

const [email, password, name = 'Shop Owner'] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Usage: npm run create-admin -- <email> "<password (10+ chars)>" ["Name"]');
  process.exit(1);
}
await migrate();
const u = await one('SELECT id FROM users WHERE email = ?', email.toLowerCase());
if (u) {
  await run("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?", hashPassword(password), u.id);
  console.log(`✿ ${email} is now an admin (password updated).`);
} else {
  await run("INSERT INTO users(email, password_hash, name, role) VALUES (?,?,?,'admin')", email.toLowerCase(), hashPassword(password), name);
  console.log(`✿ Admin ${email} created.`);
}
await closeDb();
