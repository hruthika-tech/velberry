import crypto from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import { one, run } from '../db/index.js';
import { config } from '../config.js';
import * as razorpay from '../services/razorpay.js';
import { markPaid, recordFailedPayment, recordPayment } from '../services/orders.js';
import { handleShiprocketWebhook } from '../services/fulfillment.js';
import { queueNotification } from '../services/notifications.js';

const r = Router();

/** Returns false if this event was already processed. */
async function firstTime(provider, eventId, type, payload) {
  const r = await run(`INSERT INTO webhook_events(provider, event_id, event_type, payload) VALUES (?,?,?,?)
                       ON CONFLICT (provider, event_id) DO NOTHING`, provider, eventId, type, payload);
  return r.changes === 1;
}

/**
 * Razorpay → Dashboard → Webhooks → URL: {APP_URL}/api/webhooks/razorpay
 * Events: payment.captured, payment.failed, order.paid (required); payment.authorized, refund.processed, refund.failed (optional)
 *
 * Safe to receive any number of times, in any order: every event id is processed once; a payment's stored
 * status only moves forward; an order is marked paid once (row lock); only a captured INR payment for the
 * exact order total, belonging to that order's Razorpay order, can mark it paid.
 */
r.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
  // The signature is computed over the exact bytes Razorpay sent. If the host consumed/parsed the body before
  // Express could read it raw, verification can't work — say so clearly instead of a misleading "bad signature".
  if (!raw.length && Number(req.headers['content-length'] || 0) > 0) {
    console.error('[webhook razorpay] the raw request body was not available for signature verification — on Vercel, set NODEJS_HELPERS=0');
    return res.status(400).json({ error: 'request body unavailable' });
  }
  if (!razorpay.verifyWebhookSignature(raw, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'bad signature' });
  let evt;
  try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid JSON' }); }
  if (typeof evt?.event !== 'string') return res.status(400).json({ error: 'not a Razorpay event' });
  const eventId = String(req.headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(raw).digest('hex')).slice(0, 100);
  const pay = evt.payload?.payment?.entity;
  const refund = evt.payload?.refund?.entity;
  // Store only a redacted copy (no customer contact or card/bank/UPI details).
  const stored = JSON.stringify({ event: evt.event, created_at: evt.created_at, payment: pay ? razorpay.redact(pay) : undefined,
    order_id: evt.payload?.order?.entity?.id, refund: refund ? { id: refund.id, payment_id: refund.payment_id, amount: refund.amount, status: refund.status } : undefined });
  if (!(await firstTime('razorpay', eventId, evt.event, stored))) return res.json({ ok: true, duplicate: true });

  try {
    const asPayment = (status) => ({ id: pay.id, orderId: pay.order_id, status, amount: pay.amount, currency: pay.currency, method: pay.method,
      errorReason: pay.error_description || null, raw: razorpay.redact(pay) });
    const PAYMENT_EVENTS = ['payment.captured', 'order.paid', 'payment.authorized', 'payment.failed'];
    if (pay && PAYMENT_EVENTS.includes(evt.event)) {
      if (!razorpay.isPaymentId(pay.id) || !razorpay.isOrderId(pay.order_id)) return res.json({ ok: true, ignored: 'no matching order' });
      const order = await one('SELECT * FROM orders WHERE razorpay_order_id = ?', pay.order_id);
      if (!order) return res.json({ ok: true, ignored: 'no matching order' });
      if (pay.currency && pay.currency !== 'INR') {
        await recordPayment(order.id, asPayment(pay.status));
        console.warn(`[webhook razorpay] ${order.order_number}: payment ${pay.id} is in ${pay.currency} — not accepted`);
      } else if (evt.event === 'payment.failed') {
        await recordFailedPayment(order.id, asPayment('failed'));
      } else if (pay.status === 'captured') {
        await markPaid(order.id, asPayment('captured'), 'webhook');
      } else {
        // payment.authorized (or order.paid without a captured payment): recorded, never treated as paid.
        // Auto-capture, the browser's verification or the expiry reconciliation completes it.
        await recordPayment(order.id, asPayment(pay.status));
      }
    } else if (refund && evt.event.startsWith('refund.')) {
      const row = await one('SELECT * FROM refunds WHERE provider_refund_id = ?', refund.id);
      if (row) {
        const status = evt.event === 'refund.processed' ? 'processed' : evt.event === 'refund.failed' ? 'failed' : row.status;
        await run("UPDATE refunds SET status = ?, updated_at = now() WHERE id = ?", status, row.id);
        if (status === 'failed' && row.status !== 'failed') {
          // The money did not go back: the order's payment status must again reflect only refunds that went through.
          const { s } = await one("SELECT COALESCE(SUM(amount), 0) AS s FROM refunds WHERE order_id = ? AND status <> 'failed'", row.order_id);
          const paid = await one('SELECT amount FROM payments WHERE id = ?', row.payment_id);
          const refunded = Number(s);
          const ps = refunded <= 0 ? 'paid' : paid && refunded >= Number(paid.amount) ? 'refunded' : 'partially_refunded';
          const o = await one('SELECT status FROM orders WHERE id = ?', row.order_id);
          await run("UPDATE orders SET payment_status = ?, updated_at = now() WHERE id = ? AND payment_status IN ('partially_refunded','refunded')", ps, row.order_id);
          await run('INSERT INTO order_status_history(order_id, from_status, to_status, note, actor) VALUES (?,?,?,?,?)',
            row.order_id, o.status, o.status, `⚠ Refund ${refund.id} of ₹${row.amount / 100} FAILED at Razorpay — the money was not returned`, 'razorpay');
        }
        if (status === 'processed') queueNotification(row.order_id, `refund:${refund.id}:processed`, { amount: row.amount, status, refundId: refund.id });
      }
    }
  } catch (e) {
    // Let Razorpay retry: forget the event so the retry is processed.
    await run('DELETE FROM webhook_events WHERE provider = ? AND event_id = ?', 'razorpay', String(eventId));
    console.error('[webhook razorpay]', e);
    return res.status(500).json({ error: 'processing failed' });
  }
  res.json({ ok: true });
});

/**
 * Shiprocket → Settings → API → Webhooks → URL: {APP_URL}/api/webhooks/courier-tracking
 * (Shiprocket rejects URLs containing "shiprocket"), header x-api-key = SHIPROCKET_WEBHOOK_TOKEN.
 */
r.post('/courier-tracking', express.json({ limit: '1mb' }), async (req, res) => {
  const token = config.shiprocket.webhookToken;
  const given = String(req.headers['x-api-key'] || '');
  if (!token || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    res.json(await handleShiprocketWebhook(req.body || {}));
  } catch (e) {
    console.error('[webhook courier]', e);
    res.status(200).json({ ok: false }); // Shiprocket expects 200; we'll catch up via polling
  }
});

export default r;
