/**
 * Test environment: each test file gets its own fresh PostgreSQL database on the test server,
 * prepared like a Supabase project (anon / authenticated / service_role roles + Supabase's default grants),
 * so RLS policies are exercised exactly as they would be on Supabase.
 *
 * TEST_DATABASE_URL — a Postgres superuser connection (default: the local Docker container used in development):
 *   docker run -d --name velberry-pg -e POSTGRES_PASSWORD=localdev -p 54329:5432 postgres:17-alpine
 *
 * Import this BEFORE any server module (server config is read at import time).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

export const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:localdev@127.0.0.1:54329/postgres';

export async function setupTestEnv(name, extraEnv = {}) {
  const dbName = `velberry_test_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Supabase's built-in API roles (cluster-wide; created once).
  for (const [role, extra] of [['anon', ''], ['authenticated', ''], ['service_role', 'BYPASSRLS']]) {
    await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  }
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  // Reproduce Supabase's defaults: API roles can use the public schema and get ALL on new tables
  // (which is exactly why RLS + our revokes matter).
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
                  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
                  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`);
  await db.end();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `velberry-${name}-`));
  Object.assign(process.env, {
    VELBERRY_SKIP_ENV_FILE: '1', NODE_ENV: 'test', DATABASE_URL: url.toString(), DATABASE_SSL: 'disable', DB_POOL_MAX: '20',
    OUTBOX_DIR: path.join(tmp, 'outbox'), UPLOAD_DIR: path.join(tmp, 'uploads'), ALLOW_MOCK_PAYMENTS: 'true',
    ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test', SHIPPING_FLAT_RATE: '79', FREE_SHIPPING_ABOVE: '999', SHOP_OWNER_EMAIL: 'owner@test.local',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: '',
    ...extraEnv,
  });

  return {
    url: url.toString(),
    tmp,
    /** Drop the throwaway database (call after closing the app's pool). */
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    },
  };
}

/**
 * Minimal browser-like client with a cookie jar.
 * The shopping experience (catalogue, bag, checkout, account) needs a signed-in customer with a CONFIRMED email, so
 * unless { anonymous: true } is passed, the client signs in as a brand-new confirmed customer just before its first
 * such request — only if it isn't signed in already (a test that logs in or signs up itself keeps that account, and
 * must confirm it like a real customer). { unverified: true } makes the auto-created customer unconfirmed instead.
 * The user + session are created directly in the throwaway test database, so login/signup rate limits don't skew
 * tests that use many shoppers.
 */
export function makeClient(base, { anonymous = false, unverified = false } = {}) {
  const jar = new Map();
  let signingIn = null;
  const signIn = () => (signingIn ??= (async () => {
    const { run } = await import('../../server/db/index.js');
    const { sha256, randomToken } = await import('../../server/lib/auth.js');
    const email = `shopper-${crypto.randomBytes(6).toString('hex')}@example.com`;
    const { id } = await run(`INSERT INTO users(email, password_hash, name, phone, email_verified_at) VALUES (?,?,?,?, ${unverified ? 'NULL' : 'now()'})`,
      email, 'test-only-no-password', 'Asha Rao', '9876543210');
    const token = randomToken(24);
    await run("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, now() + interval '1 day')", sha256(token), id);
    jar.set('vb_session', token);
    call.user = { id, email };
  })());
  async function call(method, url, body, headers = {}) {
    if (!anonymous && !jar.has('vb_session') && /^\/api\/(cart|checkout|products|categories|account|pincode)\b/.test(url)) await signIn();
    const res = await fetch(base() + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  call.jar = jar;
  return call;
}

/** Boot the app on a random port; returns { base, close }. */
export async function startApp() {
  const { createApp } = await import('../../server/index.js');
  const { migrate } = await import('../../server/db/index.js');
  const { ensureAdmin } = await import('../../server/db/bootstrap.js');
  const { seedCatalog } = await import('../../server/db/seed.js');
  await migrate();
  await ensureAdmin();
  await seedCatalog();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** What clicking the emailed link does, for tests that sign up through the real API and then go shopping. */
export async function confirmEmail(userIdOrEmail) {
  const { run } = await import('../../server/db/index.js');
  const col = typeof userIdOrEmail === 'number' ? 'id' : 'email';
  await run(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE ${col} = ?`, userIdOrEmail);
}

export const customer = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };
export const address = { name: 'Asha Rao', phone: '9876543210', line1: '12 Rose Lane', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };
