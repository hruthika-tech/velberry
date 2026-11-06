/**
 * Vercel build step (`npm run vercel-build`). Velberry has no bundler; this only prepares the static output:
 *  • copies three.js (the 360° viewer) from node_modules to public/vendor/three — the long-running server serves
 *    it straight from node_modules, Vercel's CDN can only serve files inside public/;
 *  • checks that the code can load with this deployment's environment variables, so a missing or unsafe
 *    production setting fails the build instead of every request.
 * It never connects to the database or changes data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(ROOT, 'node_modules', 'three', 'build');
const to = path.join(ROOT, 'public', 'vendor', 'three');
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) if (f.endsWith('.js')) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log(`✿ three.js copied to public/vendor/three (${fs.readdirSync(to).length} files)`);

// Loading the config runs every production safety check (https APP_URL, session secret, payment provider, …).
// It needs DATABASE_URL etc. to be set for this environment in Vercel → Settings → Environment Variables.
const { config } = await import('../server/config.js');
if (!config.db.url) throw new Error('DATABASE_URL is not set for this Vercel environment');
console.log(`✿ config ok — ${config.vercelEnv || 'local'} · app ${config.appUrl} · payments ${config.payments.provider}${config.payments.env ? ` (${config.payments.env})` : ''}`
  + ` · Shiprocket booking ${config.shiprocket.allowBooking ? 'ON' : 'off'} · DB pool ${config.db.poolMax}`);
