import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && !process.env.VELBERRY_SKIP_ENV_FILE) process.loadEnvFile(envFile);

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const isProd = env('NODE_ENV') === 'production';
// Vercel sets VERCEL=1 and VERCEL_ENV = production | preview | development on every build and function.
const vercelEnv = env('VERCEL') ? env('VERCEL_ENV', 'production') : null;
const isPreview = vercelEnv === 'preview';

export const config = {
  isProd,
  /** Running as Vercel serverless functions: no writable disk, no background timers, tiny DB pool. */
  serverless: Boolean(vercelEnv),
  vercelEnv,
  port: Number(env('PORT', '3000')),
  appUrl: (env('APP_URL') || defaultAppUrl()).replace(/\/$/, ''),
  sessionSecret: env('SESSION_SECRET', 'dev-secret'),
  db: dbConfig(),
  supabase: {
    url: env('SUPABASE_URL').replace(/\/$/, ''),
    // Publishable/anon key: safe for browsers, but this app's browser code never needs it.
    anonKey: env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY'),
    // Secret/service-role key: SERVER ONLY — used for Storage uploads/deletes.
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'),
    buckets: {
      products: env('SUPABASE_BUCKET_PRODUCTS', 'product-images'),
      angles: env('SUPABASE_BUCKET_360', 'product-360'),
      categories: env('SUPABASE_BUCKET_CATEGORIES', 'category-images'),
    },
  },
  // Local-disk fallback for image uploads when Supabase Storage isn't configured (development only).
  uploadDir: env('UPLOAD_DIR', path.join(ROOT, 'public', 'uploads', 'products')),
  legacySqliteFile: env('SQLITE_FILE', path.join(ROOT, 'data', 'velberry.db')),
  admin: { email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD') },
  razorpay: {
    keyId: env('RAZORPAY_KEY_ID'),
    keySecret: env('RAZORPAY_KEY_SECRET'),
    webhookSecret: env('RAZORPAY_WEBHOOK_SECRET'),
  },
  shiprocket: {
    email: env('SHIPROCKET_EMAIL'),
    password: env('SHIPROCKET_PASSWORD'),
    pickupLocation: env('SHIPROCKET_PICKUP_LOCATION', 'Primary'),
    webhookToken: env('SHIPROCKET_WEBHOOK_TOKEN'),
    // Shiprocket has no sandbox: every booking call is real (and charged to the wallet). Outside production,
    // booking (create order / AWB / pickup / label / cancel) is refused unless explicitly allowed.
    // Vercel Preview deployments count as "outside production" here.
    allowBooking: isProd && !isPreview ? env('SHIPROCKET_ALLOW_BOOKING', 'true') !== 'false' : env('SHIPROCKET_ALLOW_BOOKING') === 'true',
  },
  // Fallback only: the PIN registered for the pickup location in Shiprocket is used when it can be read.
  pickupPincode: env('PICKUP_PINCODE', ''),
  // The parcel as it leaves the studio: one standard box + packing material, plus each item's weight.
  parcel: {
    lengthCm: Number(env('SHIP_BOX_LENGTH_CM', '12')),
    breadthCm: Number(env('SHIP_BOX_BREADTH_CM', '10')),
    heightCm: Number(env('SHIP_BOX_HEIGHT_CM', '6')),
    packagingGrams: Number(env('SHIP_PACKAGING_GRAMS', '50')),
  },
  shipping: {
    feeMode: env('SHIPPING_FEE_MODE', 'flat') === 'courier' ? 'courier' : 'flat',
    flatRate: Math.round(Number(env('SHIPPING_FLAT_RATE', '79')) * 100),
    freeAbove: Math.round(Number(env('FREE_SHIPPING_ABOVE', '999')) * 100),
  },
  email: {
    resendKey: env('RESEND_API_KEY'),
    from: env('EMAIL_FROM', 'Velberry <hello@example.com>'),
    owner: env('SHOP_OWNER_EMAIL'),
  },
  /** Reservation window for unpaid checkouts before stock is released */
  checkoutTtlMinutes: 30,
  /** Bearer token Vercel Cron (or any scheduler) must send to /api/cron/* — see server/routes/cron.js. */
  cronSecret: env('CRON_SECRET'),
  // Serverless has no 5-minute timer, so expired checkouts are also released when a new checkout starts
  // (at most once per 5 minutes across all instances). Default: on for Vercel, off for the long-running server.
  checkoutExpiryOnRequest: env('CHECKOUT_EXPIRY_ON_REQUEST', vercelEnv ? 'true' : 'false') === 'true',
};

config.payments = resolvePayments();
config.razorpay.enabled = config.payments.provider === 'razorpay' && !config.payments.problem;
config.mockPayments = config.payments.provider === 'mock';
// Test-only override so automated tests can talk to a local fake of the Razorpay API (never in production).
config.razorpay.apiBase = (!isProd && env('RAZORPAY_API_BASE')) || 'https://api.razorpay.com/v1';
config.shiprocket.enabled = Boolean(config.shiprocket.email && config.shiprocket.password);
config.shiprocket.apiBase = ((!isProd && env('SHIPROCKET_API_BASE')) || 'https://apiv2.shiprocket.in/v1/external').replace(/\/$/, '');
for (const [k, v] of Object.entries(config.parcel)) {
  if (!Number.isFinite(v) || v <= 0 || v > 200 * (k === 'packagingGrams' ? 100 : 1)) throw new Error(`Invalid parcel setting ${k}: ${v}`);
}
config.supabase.storageEnabled = Boolean(config.supabase.url && config.supabase.serviceKey);

if (isProd && config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}
if (isProd && /^change[-_ ]?me/i.test(config.sessionSecret)) {
  throw new Error('SESSION_SECRET is still the placeholder from .env.example — generate a new random one for production');
}
if (isProd && config.payments.problem) {
  throw new Error(`Payments are misconfigured: ${config.payments.problem}`);
}
if (isProd && !config.supabase.storageEnabled) {
  throw new Error('In production, product images must live in Supabase Storage: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
}
// Real payments, secure session cookies and Razorpay webhooks all need the public HTTPS address.
if (isProd && (!/^https:\/\//i.test(config.appUrl) || /^https:\/\/(localhost|127\.|\[::1\])/i.test(config.appUrl))) {
  throw new Error('In production, APP_URL must be the public https:// address of the shop (not http:// or localhost)');
}

/**
 * Which payment provider is in use — always explicit, never a silent fallback.
 *   PAYMENT_PROVIDER=razorpay  real Razorpay. RAZORPAY_MODE=test (default) needs rzp_test_ keys, live needs rzp_live_ keys.
 *                              If anything is missing or mismatched, payments are DISABLED with a clear reason
 *                              (and the server refuses to start in production) — it never drops to the simulator.
 *   PAYMENT_PROVIDER=mock      the local simulator (development and automated tests only; refused in production).
 *   (unset)                    legacy behaviour: Razorpay if keys are present, else the simulator if ALLOW_MOCK_PAYMENTS=true.
 * Returns { provider: 'razorpay'|'mock'|'none', env: 'test'|'live'|null, problem: string|null, explicit: boolean }.
 */
/** APP_URL fallback: the deployment's own https address on Vercel, localhost otherwise. */
function defaultAppUrl() {
  const host = vercelEnv === 'production' ? env('VERCEL_PROJECT_PRODUCTION_URL') || env('VERCEL_URL')
    : vercelEnv ? env('VERCEL_BRANCH_URL') || env('VERCEL_URL') : '';
  return host ? `https://${host}` : 'http://localhost:3000';
}

function resolvePayments() {
  const chosen = env('PAYMENT_PROVIDER').toLowerCase();
  const keyId = env('RAZORPAY_KEY_ID');
  const keySecret = env('RAZORPAY_KEY_SECRET');
  const allowMock = env('ALLOW_MOCK_PAYMENTS', 'false') === 'true';
  if (chosen && !['razorpay', 'mock'].includes(chosen)) {
    return { provider: 'none', env: null, problem: `PAYMENT_PROVIDER must be "razorpay" or "mock" (got "${chosen}")`, explicit: true };
  }
  if (chosen === 'mock' || (!chosen && !keyId && !keySecret)) {
    // The simulator is allowed on a Vercel *Preview* deployment (NODE_ENV is production there too), never on the
    // production deployment or a production server.
    if (chosen === 'mock' && isProd && !isPreview) throw new Error('PAYMENT_PROVIDER=mock (the payment simulator) cannot be used in production');
    if (chosen === 'mock' || (allowMock && !isProd)) return { provider: 'mock', env: 'test', problem: null, explicit: chosen === 'mock' };
    return { provider: 'none', env: null, problem: 'No payment provider configured: set PAYMENT_PROVIDER=razorpay and the Razorpay keys', explicit: false };
  }
  const mode = env('RAZORPAY_MODE', 'test').toLowerCase();
  const out = { provider: 'razorpay', env: mode, problem: null, explicit: chosen === 'razorpay' };
  if (!['test', 'live'].includes(mode)) out.problem = `RAZORPAY_MODE must be "test" or "live" (got "${mode}")`;
  else if (!keyId || !keySecret) out.problem = 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when PAYMENT_PROVIDER=razorpay';
  else if (!keyId.startsWith(`rzp_${mode}_`)) {
    out.problem = `RAZORPAY_MODE=${mode} but RAZORPAY_KEY_ID is not a ${mode} key (it should start with rzp_${mode}_)`;
  } else if (mode === 'live' && !env('RAZORPAY_WEBHOOK_SECRET')) {
    out.problem = 'RAZORPAY_WEBHOOK_SECRET is required in live mode (webhooks confirm payments the browser never reported)';
  }
  return out;
}

/**
 * Postgres connection. Supabase requires TLS; we encrypt by default for any non-local host.
 * DATABASE_SSL: "require" (encrypt, default for remote hosts) | "verify" (encrypt + verify with DATABASE_CA_CERT) | "disable".
 */
function dbConfig() {
  const raw = env('DATABASE_URL');
  let url = raw;
  let host = '';
  try {
    const u = new URL(raw);
    host = u.hostname;
    u.searchParams.delete('sslmode'); // TLS is configured below; a URL sslmode would override it inconsistently
    url = u.toString();
  } catch { /* empty or invalid → reported when the pool is created */ }
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  const mode = env('DATABASE_SSL', local ? 'disable' : 'require');
  let ssl = false;
  if (mode === 'require') ssl = { rejectUnauthorized: false };
  if (mode === 'verify') {
    const caFile = env('DATABASE_CA_CERT');
    if (!caFile) throw new Error('DATABASE_SSL=verify needs DATABASE_CA_CERT (path to the Supabase CA certificate)');
    ssl = { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  }
  // Serverless instances each open their own pool: keep it tiny so many instances can't exhaust Supabase's pooler.
  return { url, ssl, poolMax: Number(env('DB_POOL_MAX', vercelEnv ? '2' : '10')) };
}
