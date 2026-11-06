/**
 * Vercel serverless entry: the same Express app as `npm start`, as one function behind /api/* and /healthz
 * (see vercel.json). Static pages are served by Vercel's CDN from public/.
 *
 * Differences from the long-running server, on purpose:
 *  • No schema changes at runtime. Migrations are applied deliberately with `npm run db:migrate`; if this deploy's
 *    code expects a migration the database doesn't have yet, the API answers 503 instead of running half-broken.
 *  • No catalogue seeding (the production database already holds the real catalogue).
 *  • Scheduled jobs run through /api/cron/* (Vercel Cron) instead of in-process timers.
 */
import { createApp } from '../server/index.js';
import { pendingMigrations } from '../server/db/index.js';
import { ensureAdmin } from '../server/db/bootstrap.js';

const app = createApp();
let ready = null;

function prepare() {
  ready ??= (async () => {
    const pending = await pendingMigrations();
    if (pending.length) {
      const e = new Error(`Database migrations not applied yet: ${pending.join(', ')} — run \`npm run db:migrate\` against this database`);
      e.pending = pending;
      throw e;
    }
    await ensureAdmin(); // only creates an admin if none exists
  })().catch((e) => { ready = null; throw e; }); // retry on the next request
  return ready;
}

export default async function handler(req, res) {
  try {
    await prepare();
  } catch (e) {
    console.error('[startup]', e.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: e.pending ? 'The shop is being updated — please try again in a few minutes' : 'Service temporarily unavailable' }));
    return;
  }
  return app(req, res);
}
