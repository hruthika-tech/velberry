/**
 * Which Supabase project is this process about to touch? — and the safety rules built on the answer.
 * Pure functions (no I/O, no secrets in messages), used by server/config.js at startup and by the
 * maintenance scripts (db:migrate, setup-storage, seed). Everything fails CLOSED: a Supabase-looking address
 * whose project can't be determined is refused, never guessed.
 *
 * A Supabase project "ref" is the 20-character id in its URLs (e.g. https://<ref>.supabase.co). It is not a
 * secret — it appears in every public image URL — so it is safe to name in configuration and error messages.
 */
const REF = /^[a-z0-9]{20}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

const unknownProject = (what) => new Error(`${what} looks like a Supabase address, but its project can't be determined — refusing to start (check the URL)`);

/** DATABASE_URL → { ref, host, local }. ref is null for a non-Supabase database. Throws on anything ambiguous. */
export function databaseTarget(databaseUrl) {
  const raw = String(databaseUrl || '').trim();
  if (!raw) return { ref: null, host: '', local: true };
  let u;
  try { u = new URL(raw); } catch { throw new Error('DATABASE_URL is not a valid connection URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
  const host = u.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  // Shared pooler (Supavisor): aws-0-<region>.pooler.supabase.com, user "<role>.<ref>"
  if (/\.pooler\.supabase\.com$/.test(host)) {
    const m = /^[a-z_][a-z0-9_]*\.([a-z0-9]{20})$/.exec(decodeURIComponent(u.username));
    if (!m) throw unknownProject('DATABASE_URL');
    return { ref: m[1], host, local };
  }
  // Direct connection / dedicated pooler: db.<ref>.supabase.co
  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(host);
  if (direct) return { ref: direct[1], host, local };
  if (host.includes('supabase')) throw unknownProject('DATABASE_URL');
  return { ref: null, host, local };
}

/** SUPABASE_URL → { ref, host, local }. ref is null for a non-Supabase address (local fakes in tests). */
export function storageTarget(supabaseUrl) {
  const raw = String(supabaseUrl || '').trim();
  if (!raw) return { ref: null, host: '', local: true };
  let u;
  try { u = new URL(raw); } catch { throw new Error('SUPABASE_URL is not a valid URL'); }
  const host = u.hostname.toLowerCase();
  const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
  if (m) return { ref: m[1], host, local: false };
  if (host.includes('supabase')) throw unknownProject('SUPABASE_URL');
  return { ref: null, host, local: LOCAL_HOSTS.has(host) };
}

/** "ref1,ref2" → ['ref1','ref2']; any malformed entry throws (a typo must not silently disable a safeguard). */
export function parseRefList(value, name) {
  const list = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const r of list) if (!REF.test(r)) throw new Error(`${name} must be a comma-separated list of 20-character Supabase project refs`);
  return list;
}

/**
 * Safeguards 2 + 3. DATABASE_URL and SUPABASE_URL must belong to the same project (or both be non-Supabase), and
 * neither may be a project listed in FORBIDDEN_SUPABASE_REF. With requireForbidden (Vercel Preview) the list must
 * be set, so a Preview that was never told which project is Production refuses to start.
 */
export function checkSupabaseTargets({ databaseUrl, supabaseUrl, forbidden, requireForbidden = false }) {
  const db = databaseTarget(databaseUrl);
  const st = storageTarget(supabaseUrl);
  if (db.ref && st.ref && db.ref !== st.ref) {
    throw new Error(`DATABASE_URL (project ${db.ref}) and SUPABASE_URL (project ${st.ref}) belong to different Supabase projects — refusing to start`);
  }
  if (String(supabaseUrl || '').trim() && Boolean(db.ref) !== Boolean(st.ref)) {
    throw new Error('DATABASE_URL and SUPABASE_URL must belong to the same Supabase project (one is a Supabase project, the other is not) — refusing to start');
  }
  const banned = parseRefList(forbidden, 'FORBIDDEN_SUPABASE_REF');
  if (requireForbidden && !banned.length) {
    throw new Error('FORBIDDEN_SUPABASE_REF must be set on Preview (the Production project ref), so Preview can never use the Production database');
  }
  const hit = [db.ref, st.ref].find((r) => r && banned.includes(r));
  if (hit) throw new Error(`This deployment points at Supabase project ${hit}, which FORBIDDEN_SUPABASE_REF lists as off-limits (Production) — refusing to start`);
  return { dbRef: db.ref, storageRef: st.ref, dbLocal: db.local, dbHost: db.host };
}

/**
 * Safeguard 1: what a Vercel Preview deployment may never have. Returns the list of problems (empty = OK).
 * env(name) returns the trimmed value or ''.
 */
export function previewProblems(env) {
  const p = [];
  if (env('PAYMENT_PROVIDER').toLowerCase() !== 'mock') p.push('PAYMENT_PROVIDER must be "mock" (the simulator) on Preview');
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_MODE']) {
    if (env(k)) p.push(`${k} must not be set on Preview (Razorpay credentials belong to Production only)`);
  }
  const booking = env('SHIPROCKET_ALLOW_BOOKING');
  if (booking && booking.toLowerCase() !== 'false') p.push('SHIPROCKET_ALLOW_BOOKING must be unset or "false" on Preview (no real shipments)');
  if (env('RESEND_API_KEY')) p.push('RESEND_API_KEY must not be set on Preview (no real emails to customers)');
  return p;
}

/**
 * Safeguard 4: may a maintenance script run against this target? Production is recognised ONLY by
 * PRODUCTION_SUPABASE_REF, and permission comes ONLY from an explicit `--production` command-line argument —
 * never from .env or any other environment variable.
 *   • local / non-Supabase database                → allowed (refused if --production is passed: it isn't Production)
 *   • Supabase project, PRODUCTION_SUPABASE_REF unset → refused (can't tell Production apart — won't guess)
 *   • the Production project without --production   → refused
 *   • another project with --production             → refused (the flag must match reality)
 * Returns { ok, production, ref, message }.
 */
export function scriptTarget({ script, dbRef, storageRef, productionRefs, argv }) {
  const flag = argv.includes('--production');
  const ref = dbRef || storageRef || null;
  const cmd = `npm run ${script} -- --production`;
  if (!ref) {
    if (flag) return { ok: false, ref, message: `--production was given, but this ${script} run does not target a Supabase project — refusing` };
    return { ok: true, production: false, ref, message: 'target: local / non-Supabase database' };
  }
  let prod;
  try { prod = parseRefList(productionRefs, 'PRODUCTION_SUPABASE_REF'); } catch (e) { return { ok: false, ref, message: e.message }; }
  if (!prod.length) {
    return { ok: false, ref, message: `PRODUCTION_SUPABASE_REF is not set, so ${script} can't tell whether project ${ref} is Production — refusing. Set it to your Production project's ref (in .env or the shell).` };
  }
  const isProd = [dbRef, storageRef].some((r) => r && prod.includes(r));
  if (isProd && !flag) {
    return { ok: false, ref, production: true, message: `Supabase project ${ref} is PRODUCTION. Nothing was changed. If you really mean it, run:  ${cmd}` };
  }
  if (!isProd && flag) {
    return { ok: false, ref, production: false, message: `--production was given, but project ${ref} is not listed in PRODUCTION_SUPABASE_REF — refusing` };
  }
  return { ok: true, production: isProd, ref, message: `target: Supabase project ${ref}${isProd ? ' — PRODUCTION (confirmed with --production)' : ' (not Production)'}` };
}

/** Business tables that make a database "nonempty" for an import. Read-only check; missing tables count as empty. */
const DATA_TABLES = ['users', 'products', 'orders', 'categories'];
export async function nonEmptyTables(query) {
  const filled = [];
  for (const t of DATA_TABLES) {
    const exists = (await query(`SELECT to_regclass('public.${t}') IS NOT NULL AS ok`)).ok;
    if (exists && (await query(`SELECT EXISTS (SELECT 1 FROM ${t}) AS has`)).has) filled.push(t);
  }
  return filled;
}

/**
 * migrate:sqlite into Production: refused while Production already holds data (re-importing could bring back
 * records deleted since) unless --force-into-nonempty is given. The flag means nothing outside Production.
 */
export function importDecision({ production, force, filled }) {
  if (force && !production) return { ok: false, message: '--force-into-nonempty only applies to a Production import (together with --production) — refusing' };
  if (production && filled.length && !force) {
    return { ok: false, message: `Production already holds data (${filled.join(', ')}). Nothing was changed. Importing again could bring back records`
      + ' deleted since the first import. If you really mean it, add --force-into-nonempty.' };
  }
  return { ok: true, message: production && filled.length ? `importing into a nonempty Production database (${filled.join(', ')}) — confirmed with --force-into-nonempty` : null };
}

/**
 * Vercel PRODUCTION payment rules: real Razorpay in live mode, or the deployment refuses to start (so checkout can
 * never run on the simulator, on test keys, or on a half-configured gateway). Returns the problems (empty = OK).
 * Messages name variables only — never their values.
 */
export function productionPaymentProblems(env) {
  const p = [];
  const provider = env('PAYMENT_PROVIDER').toLowerCase();
  if (provider === 'mock') p.push('PAYMENT_PROVIDER=mock is not allowed on Vercel Production (the payment simulator cannot be used in production) — set PAYMENT_PROVIDER=razorpay');
  else if (provider !== 'razorpay') p.push('PAYMENT_PROVIDER must be set to "razorpay" on Vercel Production');
  const allowMock = env('ALLOW_MOCK_PAYMENTS').toLowerCase();
  if (allowMock && allowMock !== 'false') p.push('ALLOW_MOCK_PAYMENTS must not be set on Vercel Production');
  if (env('RAZORPAY_MODE').toLowerCase() !== 'live') p.push('RAZORPAY_MODE must be "live" on Vercel Production');
  if (!/^rzp_live_[A-Za-z0-9]+$/.test(env('RAZORPAY_KEY_ID'))) p.push('RAZORPAY_KEY_ID must be a live key (rzp_live_…) on Vercel Production');
  if (!env('RAZORPAY_KEY_SECRET')) p.push('RAZORPAY_KEY_SECRET is not set');
  if (!env('RAZORPAY_WEBHOOK_SECRET')) p.push('RAZORPAY_WEBHOOK_SECRET is not set (CLAYSLAY\'s own webhook secret)');
  return p;
}
