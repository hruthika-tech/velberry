import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, ROOT } from './config.js';
import { migrate, pendingMigrations, one, closeDb } from './db/index.js';
import { startupPlan, prepareDatabase, StartupRefused } from './db/startup.js';
import * as storage from './services/storage.js';
import { ensureAdmin } from './db/bootstrap.js';
import { seedCatalog } from './db/seed.js';
import { sessionMiddleware, csrfGuard } from './lib/auth.js';
import store from './routes/store.js';
import checkout from './routes/checkout.js';
import webhooks from './routes/webhooks.js';
import admin from './routes/admin.js';
import special, { specialAdmin } from './routes/special.js';
import * as razorpay from './services/razorpay.js';
import { expireStaleCheckouts } from './services/orders.js';
import { syncAllActive } from './services/fulfillment.js';
import { SECURITY_HEADERS } from './lib/security-headers.js';
import cron from './routes/cron.js';
import pages from './routes/pages.js';
import { settleBackground } from './lib/background.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  // Webhooks need the raw body for signature checks → mounted before JSON parsing.
  // Health check for the host/load balancer: verifies the database connection.
  app.get('/healthz', async (_req, res) => {
    try {
      await one('SELECT 1 AS ok');
      res.json({ ok: true, db: 'up', storage: storage.isRemote() ? 'supabase' : 'local' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.use('/api/webhooks', webhooks);
  app.use('/api/cron', cron); // scheduled jobs (Vercel Cron / external scheduler), bearer-token protected
  app.use('/api/admin', express.json({ limit: '60mb' }));
  app.use('/api', express.json({ limit: '200kb' }));
  app.use(sessionMiddleware);
  app.use('/api', csrfGuard);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.use('/api/checkout', checkout);
  app.use('/api/admin/todays-special', specialAdmin); // Today's Special (admin-only, see routes/special.js)
  app.use('/api/admin', admin);
  app.use('/api', special);                           // GET /api/todays-special (public, published board only)
  app.use('/api', store);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Shopping pages (confirmed customers only) + public share pages — see routes/pages.js
  app.use(pages);

  app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three', 'build'), { maxAge: '30d' }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
  app.use((_req, res) => res.status(404).sendFile(path.join(ROOT, 'public', '404.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500 && !err.status) console.error(`[${req.method} ${req.path}]`, err);
    const message = status >= 500 && !err.status ? 'Something went wrong on our side — please try again' : err.message;
    if (req.path.startsWith('/api')) return res.status(status).json({ error: message, details: err.details });
    res.status(status).send(message);
  });
  return app;
}

function startJobs() {
  const every = (ms, name, fn) => setInterval(() => fn().catch((e) => console.error(`[job ${name}]`, e.message)), ms).unref();
  every(5 * 60e3, 'expire-checkouts', () => expireStaleCheckouts(razorpay));
  every(60 * 60e3, 'tracking-sync', syncAllActive);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Before the first database request: Production is never migrated or seeded without `npm start -- --production`.
  const plan = startupPlan({ argv: process.argv.slice(2), dbRef: config.supabase.dbRef, storageRef: config.supabase.storageRef,
    productionRefs: process.env.PRODUCTION_SUPABASE_REF || '' });
  try {
    await prepareDatabase({ plan, db: { migrate, pendingMigrations, seedCatalog, ensureAdmin } });
  } catch (e) {
    if (!(e instanceof StartupRefused)) throw e;
    console.error(`\n✗ Not starting: ${e.message}\n`);
    await closeDb();
    process.exit(2);
  }
  const server = createApp().listen(config.port, () => {
    console.log(`\n  🍓 CLAYSLAY is open at ${config.appUrl}`);
    const pay = razorpay.mode();
    console.log(`     payments: ${pay === 'razorpay' ? `Razorpay (${razorpay.environment().toUpperCase()} mode)`
      : pay === 'mock' ? `local simulator — no real payments (${config.payments.explicit ? 'PAYMENT_PROVIDER=mock' : 'PAYMENT_PROVIDER not set, ALLOW_MOCK_PAYMENTS=true'})`
        : `DISABLED — ${razorpay.problem() || 'no payment provider configured'}`}`);
    if (pay === 'razorpay' && !config.razorpay.webhookSecret) console.log('     ⚠ RAZORPAY_WEBHOOK_SECRET is not set: payments the browser never reports will only be found by reconciliation');
    console.log(`     shipping: ${config.shiprocket.enabled ? `Shiprocket (${config.shiprocket.allowBooking ? 'booking ON — real shipments' : 'rates & tracking only — booking off'})` : 'flat rate (Shiprocket not configured)'}`);
    console.log(`     email:    ${config.email.resendKey ? 'Resend' : 'not sent — logged, preview in Admin → Emails (Resend not configured)'}`);
    console.log(`     database: Postgres @ ${new URL(config.db.url).hostname}`);
    console.log(`     images:   ${storage.isRemote() ? 'Supabase Storage' : 'local disk (Supabase Storage not configured)'}\n`);
  });
  startJobs();
  // Graceful shutdown: finish in-flight requests, then close the DB pool.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      server.close(() => settleBackground().then(closeDb).finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}
