import { one, run } from './index.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/auth.js';

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if no admin exists yet. */
export async function ensureAdmin() {
  if (await one("SELECT 1 FROM users WHERE role = 'admin'")) return;
  const { email, password } = config.admin;
  if (!email || !password) {
    console.warn('⚠ No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env or run `npm run create-admin`.');
    return;
  }
  if (config.isProd && (password.length < 12 || password === 'change-this-password')) {
    throw new Error('Set a strong ADMIN_PASSWORD (12+ characters) before starting in production');
  }
  const existing = await one('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) await run("UPDATE users SET role = 'admin' WHERE id = ?", existing.id);
  else await run("INSERT INTO users(email, password_hash, name, role) VALUES (?,?,?,'admin')", email.toLowerCase(), hashPassword(password), 'Shop Owner');
  console.log(`✿ Admin account ready: ${email}`);
}
