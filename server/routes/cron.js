/**
 * Scheduled jobs over HTTP, for hosts without long-running timers (Vercel). The long-running server
 * (`npm start`) still runs the same jobs on its own timers — see startJobs() in server/index.js.
 *
 *   GET|POST /api/cron/expire-checkouts   release stock held by unpaid checkouts (asks Razorpay first)
 *   GET|POST /api/cron/tracking-sync      poll Shiprocket tracking for active shipments
 *   GET|POST /api/cron/all                both (one daily Vercel Cron on the Hobby plan)
 *
 * Every call must send `Authorization: Bearer <CRON_SECRET>` — Vercel Cron does this automatically when the
 * CRON_SECRET environment variable is set. Without CRON_SECRET the endpoints are switched off (503).
 * A job already running elsewhere is skipped, never run twice at once.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { withLock, LOCK_BUSY } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import * as razorpay from '../services/razorpay.js';
import { expireStaleCheckouts } from '../services/orders.js';
import { syncAllActive } from '../services/fulfillment.js';

const JOBS = {
  'expire-checkouts': async () => ({ checked: await expireStaleCheckouts(razorpay) }),
  'tracking-sync': async () => ({ synced: await syncAllActive() }),
};

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function authorize(req, _res, next) {
  if (!config.cronSecret) return next(new HttpError(503, 'Scheduled jobs are switched off: CRON_SECRET is not set'));
  const ok = crypto.timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${config.cronSecret}`));
  next(ok ? undefined : new HttpError(401, 'Unauthorized'));
}

async function runJob(name) {
  const started = Date.now();
  const out = await withLock(`cron:${name}`, JOBS[name], { wait: false });
  if (out === LOCK_BUSY) return { job: name, skipped: 'already running' };
  return { job: name, ok: true, ...out, ms: Date.now() - started };
}

const r = Router();
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
r.use(authorize);
r.all('/:job', async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Use GET or POST');
  const { job } = req.params;
  if (job === 'all') {
    const results = [];
    for (const name of Object.keys(JOBS)) {
      try { results.push(await runJob(name)); } catch (e) { console.error(`[cron ${name}]`, e.message); results.push({ job: name, ok: false, error: 'failed — see logs' }); }
    }
    return res.status(results.every((x) => x.ok !== false) ? 200 : 500).json({ results });
  }
  if (!JOBS[job]) throw new HttpError(404, 'Unknown job');
  try {
    res.json(await runJob(job));
  } catch (e) {
    console.error(`[cron ${job}]`, e.message);
    res.status(500).json({ job, ok: false, error: 'failed — see logs' });
  }
});

export default r;
