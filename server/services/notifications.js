import { one, all, run, detached } from '../db/index.js';
import { config } from '../config.js';
import { renderEmail } from './email-templates.js';
import { runInBackground } from '../lib/background.js';

/**
 * Queue a branded email for an order event. Each (order, type) is sent at most once thanks to a
 * partial unique index — a webhook arriving twice can never double-email a customer.
 * Without RESEND_API_KEY nothing is sent: the email is recorded as "logged" (one log line, no personal data) and
 * can be previewed in Admin → Emails, which re-renders it on demand. No files are written, so this works on
 * serverless hosts with a read-only disk.
 * Delivery runs after the response; on Vercel the function is kept alive for it (waitUntil).
 */
export function queueNotification(orderId, type, extra = {}) {
  detached(() => runInBackground(new Promise((r) => setImmediate(r)).then(() => deliver(orderId, type, extra))
    .catch((e) => console.error('[notify]', type, e.message))));
}

export async function deliver(orderId, type, extra = {}) {
  const order = await one('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) return;
  const items = await all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', orderId);
  const shipment = await one('SELECT * FROM shipments WHERE order_id = ?', orderId);
  const to = type.startsWith('owner_') ? config.email.owner : order.customer_email;
  if (!to) return;

  const { subject, html } = renderEmail(type, { order, items, shipment, extra, appUrl: config.appUrl });

  // At most one email per (order, type): the partial unique index turns a duplicate into a no-op.
  const rowId = (await run(`INSERT INTO notifications(order_id, type, recipient, subject, status) VALUES (?,?,?,?,?)
    ON CONFLICT (order_id, type) WHERE status <> 'failed' DO NOTHING RETURNING id`, orderId, type, to, subject, 'pending')).id;
  if (!rowId) return; // already sent

  if (!config.email.resendKey) {
    console.log(`[email] not sent (RESEND_API_KEY not set): ${type} for order ${order.order_number}`);
    await run("UPDATE notifications SET status = 'logged', error = ? WHERE id = ?", NOT_SENT, rowId);
    return;
  }

  try {
    const providerId = await sendViaResend({ to, subject, html, idempotencyKey: `${orderId}-${type}` });
    await run("UPDATE notifications SET status = 'sent', provider_id = ? WHERE id = ?", providerId, rowId);
  } catch (e) {
    await run("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?", e.message, rowId);
  }
}

/** One email through the Resend API. Resolves to Resend's email id; throws with Resend's message on failure. */
export async function sendViaResend({ to, subject, html, idempotencyKey }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: config.email.from, to: [to], subject, html }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body.id || null;
}

export const NOT_SENT = 'Not sent — no email provider configured (RESEND_API_KEY). Use Preview to see it.';

/**
 * Re-render a recorded email for the admin preview, from the order as it is now. Details that were only passed
 * at send time are looked up again (refund amount, latest tracking scan, cancellation note).
 */
export async function previewEmail(notificationId) {
  const n = await one('SELECT * FROM notifications WHERE id = ?', notificationId);
  if (!n) return null;
  const order = await one('SELECT * FROM orders WHERE id = ?', n.order_id);
  if (!order) return null;
  const items = await all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  const shipment = await one('SELECT * FROM shipments WHERE order_id = ?', order.id);
  const extra = {};
  const [kind, ref] = n.type.split(':');
  if (kind === 'refund' && ref) {
    const r = await one('SELECT amount, status FROM refunds WHERE provider_refund_id = ?', ref);
    if (r) Object.assign(extra, { amount: r.amount, status: n.type.endsWith(':processed') ? 'processed' : r.status, refundId: ref });
  } else if (kind === 'tracking') {
    const ev = await one('SELECT status, description, location FROM tracking_events WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
    if (ev) Object.assign(extra, { label: ev.status, description: ev.description, location: ev.location });
  } else if (kind === 'cancelled') {
    const h = await one("SELECT note FROM order_status_history WHERE order_id = ? AND to_status = 'cancelled' ORDER BY id DESC LIMIT 1", order.id);
    if (h) extra.reason = h.note;
  }
  const { subject, html } = renderEmail(n.type, { order, items, shipment, extra, appUrl: config.appUrl });
  return { subject, html };
}
