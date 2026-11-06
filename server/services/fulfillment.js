import { one, all, run, tx, withLock } from '../db/index.js';
import { bad, conflict, notFound, unavailable } from '../lib/errors.js';
import * as shiprocket from './shiprocket.js';
import * as razorpay from './razorpay.js';
import { parcelFor } from './shipping.js';
import { transition, TRANSITIONS } from './orders.js';
import { queueNotification } from './notifications.js';

/** Order statuses in which a parcel can be booked (paid, not yet with the courier). */
const SHIPPABLE = ['paid', 'preparing', 'packed', 'ready_to_ship'];

async function loadOrder(orderId) {
  const o = await one('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) throw notFound('Order not found');
  return o;
}

const updateShipment = (id, fields) => {
  const keys = Object.keys(fields);
  return run(`UPDATE shipments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, ...keys.map((k) => fields[k]), id);
};

const addHistory = (orderId, status, note, actor = 'system') =>
  run('INSERT INTO order_status_history(order_id, from_status, to_status, note, actor) VALUES (?,?,?,?,?)', orderId, status, status, note, actor);

/** Order lines with each product's current weight — the input for the parcel. */
const orderLines = (orderId) => all(`SELECT oi.*, COALESCE(p.weight_grams, 30) AS weight_grams FROM order_items oi
                                     LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`, orderId);

/** The parcel for an existing order (weight from its items + packing, configured box size). */
export async function parcelForOrder(orderId) {
  return parcelFor(await orderLines(orderId));
}

/** Courier options for an order's delivery PIN and actual parcel. */
export async function couriersForOrder(orderId) {
  const o = await loadOrder(orderId);
  const parcel = await parcelForOrder(orderId);
  const s = await shiprocket.serviceability({ deliveryPincode: o.ship_pincode, parcel, declaredValue: Math.round(o.subtotal / 100) });
  return { ...s, parcel };
}

function assertCanBook() {
  if (!shiprocket.isEnabled()) throw unavailable('Shiprocket is not configured. Add SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD to .env.');
  if (!shiprocket.bookingAllowed()) {
    throw unavailable('Booking real Shiprocket shipments is switched off on this server (development). Set SHIPROCKET_ALLOW_BOOKING=true only when you really mean to book.');
  }
}

/**
 * Book a paid order with Shiprocket: create the Shiprocket order → assign courier + AWB → schedule pickup →
 * generate the label. Idempotent and resumable:
 *  - one booking per order at a time (per-order lock; also taken by cancellation), one shipment row per order;
 *  - every confirmed step is saved immediately, so a failure midway is retried from where it stopped;
 *  - if our earlier attempt timed out after Shiprocket acted, the existing Shiprocket order / AWB / pickup is
 *    found and reused instead of booking a second time.
 */
export function createShiprocketShipment(orderId, { courierId } = {}) {
  if (courierId != null && courierId !== '' && !/^\d{1,10}$/.test(String(courierId))) throw bad('Invalid courier');
  return withLock(`ship:${orderId}`, async () => {
    const order = await loadOrder(orderId);
    if (order.payment_status !== 'paid') throw bad('Only paid orders can be shipped');
    if (!SHIPPABLE.includes(order.status)) throw bad(`Order is "${order.status}" — cannot book a shipment`);
    let s = await one('SELECT * FROM shipments WHERE order_id = ?', orderId);
    if (s && s.provider !== 'shiprocket') throw conflict('This order already has a manual shipment recorded');
    if (s?.status === 'cancelled') throw conflict('This order\'s Shiprocket shipment was cancelled; it cannot be rebooked automatically');
    if (s?.awb_code && s.pickup_scheduled_at && s.label_url) return s; // nothing left to do
    assertCanBook();

    if (!s) {
      // Claim the order's single shipment row before talking to Shiprocket.
      await run(`INSERT INTO shipments(order_id, provider, status) VALUES (?, 'shiprocket', 'creating') ON CONFLICT (order_id) DO NOTHING`, orderId);
      s = await one('SELECT * FROM shipments WHERE order_id = ?', orderId);
    }

    if (!s.provider_shipment_id) {
      const items = await orderLines(orderId);
      const created = (await shiprocket.findOrder(order.order_number)) || (await shiprocket.createOrder(order, items, parcelFor(items)));
      await updateShipment(s.id, { provider_order_id: created.providerOrderId, provider_shipment_id: created.providerShipmentId, status: 'created' });
      await addHistory(orderId, order.status, `Shiprocket order ${created.providerOrderId} created (shipment ${created.providerShipmentId})`, 'admin');
      s = await one('SELECT * FROM shipments WHERE id = ?', s.id);
    }

    if (!s.awb_code) {
      const awb = await shiprocket.assignAwb(s.provider_shipment_id, courierId || undefined);
      await updateShipment(s.id, { awb_code: awb.awb, courier_name: awb.courierName, courier_id: awb.courierId, status: 'awb_assigned',
        tracking_url: `https://shiprocket.co/tracking/${encodeURIComponent(awb.awb)}` });
      s = await one('SELECT * FROM shipments WHERE id = ?', s.id);
    }

    if (!s.pickup_scheduled_at) {
      const p = await shiprocket.schedulePickup(s.provider_shipment_id);
      await updateShipment(s.id, { pickup_scheduled_at: p.pickupScheduledAt || new Date().toISOString(), status: 'pickup_scheduled' });
      s = await one('SELECT * FROM shipments WHERE id = ?', s.id);
    }

    if (!s.label_url) {
      // A missing label never blocks the booking; it can be generated again from the admin.
      try {
        const l = await shiprocket.generateLabel(s.provider_shipment_id);
        await updateShipment(s.id, { label_url: l.labelUrl });
      } catch (e) { console.warn(`[ship] ${order.order_number} label:`, e.message); }
    }

    const fresh = await loadOrder(orderId);
    if (TRANSITIONS[fresh.status]?.includes('ready_to_ship')) {
      const { awb_code: awbCode, courier_name: courier } = await one('SELECT awb_code, courier_name FROM shipments WHERE order_id = ?', orderId);
      await transition(orderId, 'ready_to_ship', { note: `Shiprocket AWB ${awbCode}${courier ? ` · ${courier}` : ''}`, actor: 'admin' });
    }
    return one('SELECT * FROM shipments WHERE order_id = ?', orderId);
  });
}

/** (Re)generate the shipping label for a booked Shiprocket shipment. */
export function regenerateLabel(orderId) {
  return withLock(`ship:${orderId}`, async () => {
    const s = await one('SELECT * FROM shipments WHERE order_id = ?', orderId);
    if (!s || s.provider !== 'shiprocket' || !s.awb_code) throw bad('Book the shipment (with an AWB) before generating a label');
    if (s.status === 'cancelled') throw bad('This shipment was cancelled');
    assertCanBook();
    const l = await shiprocket.generateLabel(s.provider_shipment_id);
    await updateShipment(s.id, { label_url: l.labelUrl });
    return one('SELECT * FROM shipments WHERE id = ?', s.id);
  });
}

/** For parcels booked outside Shiprocket (e.g. India Post at the counter). Real AWB required. */
export async function recordManualShipment(orderId, { courierName, awb, trackingUrl }) {
  if (!courierName || !awb) throw bad('Courier name and tracking number are required');
  const order = await tx(async () => {
    const o = await one('SELECT * FROM orders WHERE id = ? FOR UPDATE', orderId);
    if (!o) throw notFound('Order not found');
    if (o.payment_status !== 'paid') throw bad('Only paid orders can be shipped');
    if (!SHIPPABLE.includes(o.status)) throw bad(`Order is "${o.status}" — cannot record a shipment`);
    const inserted = await one(`INSERT INTO shipments(order_id, provider, courier_name, awb_code, tracking_url, status) VALUES (?,?,?,?,?,?)
                                ON CONFLICT (order_id) DO NOTHING RETURNING id`, orderId, 'manual', courierName, awb, trackingUrl || null, 'shipped');
    if (!inserted) throw conflict('A shipment already exists for this order');
    return o;
  });
  await transition(orderId, 'shipped', { note: `Shipped with ${courierName} (${awb})`, actor: 'admin' });
  await addTrackingEvent(order, await one('SELECT * FROM shipments WHERE order_id = ?', orderId), {
    status: 'Shipped', description: `Handed over to ${courierName}`, at: new Date().toISOString(), source: 'manual',
  });
}

/** Returns true if the event is new (dedupe_key makes repeated webhook/poll deliveries harmless). */
async function addTrackingEvent(order, shipment, { status, description, location, at, source }) {
  const when = shiprocket.parseTime(at) || String(at);
  const key = `${order.id}|${String(status).toUpperCase().trim()}|${when}|${description || ''}`.slice(0, 500);
  const r = await run(`INSERT INTO tracking_events(order_id, shipment_id, status, description, location, occurred_at, source, dedupe_key)
                       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (dedupe_key) DO NOTHING`,
  order.id, shipment?.id || null, status, description || null, location || null, when, source, key);
  return r.changes === 1;
}

/** Time of the newest courier event we know for a shipment (ms), or 0. */
async function latestEventTime(shipmentId) {
  const rows = await all('SELECT occurred_at FROM tracking_events WHERE shipment_id = ?', shipmentId);
  return rows.reduce((m, r) => Math.max(m, Date.parse(shiprocket.parseTime(r.occurred_at) || r.occurred_at) || 0), 0);
}

/**
 * Route an order to the status the courier reports, stepping through intermediate states when updates were
 * missed (e.g. shipped → rto_delivered goes via rto_initiated). Never passes through or ends in "cancelled".
 */
async function advanceTo(orderId, target, note) {
  const order = await loadOrder(orderId);
  if (!target || order.status === target || ['cancelled', 'delivered', 'rto_delivered'].includes(order.status)) return;
  const prev = new Map([[order.status, null]]);
  const queue = [order.status];
  while (queue.length && !prev.has(target)) {
    const cur = queue.shift();
    for (const nxt of TRANSITIONS[cur] || []) {
      if (nxt === 'cancelled' || prev.has(nxt)) continue;
      prev.set(nxt, cur);
      queue.push(nxt);
    }
  }
  if (!prev.has(target)) return;
  const path = [];
  for (let s = target; s !== order.status; s = prev.get(s)) path.unshift(s);
  for (const [i, step] of path.entries()) {
    await transition(orderId, step, { note, actor: 'courier', notify: i === path.length - 1 });
  }
}

const TRACKING_EMAIL_FOR = /IN TRANSIT|REACHED AT DESTINATION|REACHED DESTINATION/i;

/**
 * Apply a courier status (from webhook or poll). Every event is kept in the timeline; only an event at least
 * as new as the newest one we know may change the shipment/order status, so late or out-of-order deliveries
 * never move a parcel backwards.
 */
export async function applyCourierUpdate(shipment, { statusText, description, location, at, source, record = true }) {
  const order = await loadOrder(shipment.order_id);
  const when = shiprocket.parseTime(at) || new Date().toISOString();
  const latest = await latestEventTime(shipment.id);
  const isNew = record ? await addTrackingEvent(order, shipment, { status: statusText, description, location, at: when, source }) : false;
  if (latest && Date.parse(when) < latest) return { stale: true };
  await updateShipment(shipment.id, { status: String(statusText).toLowerCase().slice(0, 60), last_synced_at: new Date().toISOString() });
  if (isNew && shiprocket.needsAttention(statusText)) {
    await addHistory(order.id, order.status, `⚠ Courier reports "${statusText}"${location ? ` at ${location}` : ''} — please check with Shiprocket`, 'courier');
  }
  const target = shiprocket.mapStatus(statusText);
  await advanceTo(order.id, target, `${statusText}${location ? ` · ${location}` : ''}`);
  if (isNew && !target?.match(/out_for_delivery|delivered|delivery_failed|rto/) && TRACKING_EMAIL_FOR.test(statusText)) {
    const slug = statusText.toLowerCase().replace(/[^a-z]+/g, '_');
    queueNotification(order.id, `tracking:${slug}`, { label: statusText, description, location });
  }
  return { stale: false };
}

/** Courier delivery estimates arrive as Indian local time without a zone → store ISO when readable. */
const normEtd = (v) => shiprocket.parseTime(v) || String(v).slice(0, 40);

/** Pull the latest tracking from Shiprocket for one order. */
export async function syncTracking(orderId) {
  const s = await one('SELECT * FROM shipments WHERE order_id = ?', orderId);
  if (!s?.awb_code) throw bad('No AWB assigned yet');
  if (s.provider !== 'shiprocket') throw bad('Manual shipments are updated by hand');
  const t = await shiprocket.track(s.awb_code);
  const fields = { last_synced_at: new Date().toISOString() };
  if (t.etd) fields.etd = normEtd(t.etd);
  if (t.trackUrl) fields.tracking_url = t.trackUrl;
  if (t.courierName && !s.courier_name) fields.courier_name = t.courierName;
  await updateShipment(s.id, fields);
  const order = await loadOrder(orderId);
  for (const a of t.activities.slice().reverse()) {
    await addTrackingEvent(order, s, { status: a.status, description: a.description, location: a.location, at: a.at, source: 'poll' });
  }
  if (t.currentStatus) {
    // The current status is as old as the newest scan (not "now"), and adds no extra timeline entry.
    const newest = t.activities.map((a) => shiprocket.parseTime(a.at)).filter(Boolean).sort().at(-1);
    await applyCourierUpdate(await one('SELECT * FROM shipments WHERE id = ?', s.id),
      { statusText: t.currentStatus, description: t.currentStatus, at: newest || new Date().toISOString(), source: 'poll', record: false });
  }
  return one('SELECT * FROM shipments WHERE id = ?', s.id);
}

/** Background job: refresh every active Shiprocket shipment. */
/** Poll tracking for every active Shiprocket shipment. Returns how many were checked (0 if Shiprocket is off). */
export async function syncAllActive() {
  if (!shiprocket.isEnabled()) return 0;
  const rows = await all(`SELECT s.order_id FROM shipments s JOIN orders o ON o.id = s.order_id
                          WHERE s.provider = 'shiprocket' AND s.awb_code IS NOT NULL AND s.status <> 'cancelled'
                          AND o.status IN ('ready_to_ship','shipped','out_for_delivery','delivery_failed','rto_initiated')`);
  for (const r of rows) {
    try { await syncTracking(r.order_id); } catch (e) { console.warn('[tracking]', r.order_id, e.message); }
  }
  return rows.length;
}

/** Shiprocket tracking webhook payload → update. */
export async function handleShiprocketWebhook(p) {
  const awb = String(p.awb || p.awb_code || '').trim().slice(0, 60);
  if (!awb) return { ignored: 'no awb' };
  const s = await one('SELECT * FROM shipments WHERE awb_code = ?', awb);
  if (!s) return { ignored: 'unknown awb' };
  if (s.status === 'cancelled') return { ignored: 'shipment cancelled' };
  const statusText = String(p.current_status || p.shipment_status || '').trim().slice(0, 80);
  if (!statusText) return { ignored: 'no status' };
  if (p.etd) await updateShipment(s.id, { etd: normEtd(p.etd) });
  const latest = Array.isArray(p.scans) && p.scans.length ? p.scans[p.scans.length - 1] : null;
  const r = await applyCourierUpdate(s, {
    statusText,
    description: latest?.activity || statusText, location: latest?.location || p.current_location || null,
    at: p.current_timestamp || latest?.date || new Date().toISOString(), source: 'webhook',
  });
  return { ok: true, ...(r.stale ? { stale: true } : {}) };
}

/**
 * Refund via Razorpay (full or partial). Amount in paise.
 * The per-order lock makes the "remaining amount" check and the Razorpay call atomic, so two clicks can't over-refund.
 */
export function refundOrder(orderId, { amount, reason }) {
  return withLock(`refund:${orderId}`, async () => {
    const order = await loadOrder(orderId);
    const payment = await one("SELECT * FROM payments WHERE order_id = ? AND status = 'captured' ORDER BY id DESC LIMIT 1", orderId);
    if (!payment) throw bad('No captured payment to refund');
    const { s: refunded } = await one("SELECT COALESCE(SUM(amount), 0) AS s FROM refunds WHERE order_id = ? AND status <> 'failed'", orderId);
    const remaining = payment.amount - refunded;
    const amt = amount ? Number(amount) : remaining;
    if (!Number.isInteger(amt) || amt <= 0 || amt > remaining) throw bad(`Refund must be between ₹1 and ₹${remaining / 100}`);

    const r = await razorpay.refundPayment(payment.provider_payment_id, amt, { order: order.order_number, reason: reason || '' });
    await tx(async () => {
      await run('INSERT INTO refunds(order_id, payment_id, provider_refund_id, amount, status, reason) VALUES (?,?,?,?,?,?)',
        orderId, payment.id, r.id, amt, r.status === 'processed' ? 'processed' : 'pending', reason || null);
      const status = refunded + amt >= payment.amount ? 'refunded' : 'partially_refunded';
      await run('UPDATE orders SET payment_status = ?, updated_at = now() WHERE id = ?', status, orderId);
      await run('INSERT INTO order_status_history(order_id, from_status, to_status, note, actor) VALUES (?,?,?,?,?)',
        orderId, order.status, order.status, `Refund ${r.id} of ₹${amt / 100} ${r.status}`, 'admin');
    });
    queueNotification(orderId, `refund:${r.id}`, { amount: amt, status: r.status, refundId: r.id });
    return r;
  });
}

/**
 * Cancel an order: cancels the Shiprocket booking if the parcel hasn't been picked up, releases stock,
 * optionally refunds in full. Takes the same per-order lock as booking, so a booking can't slip in meanwhile.
 * Safe to retry: a shipment already cancelled is not cancelled again.
 */
export function cancelOrder(orderId, { reason, refund = true }) {
  return withLock(`ship:${orderId}`, async () => {
    const order = await loadOrder(orderId);
    if (!TRANSITIONS[order.status]?.includes('cancelled')) throw bad('This order can no longer be cancelled (already shipped?)');
    const s = await one('SELECT * FROM shipments WHERE order_id = ?', orderId);
    if (s && s.status !== 'cancelled') {
      let providerOrderId = s.provider_order_id;
      if (s.provider === 'shiprocket' && !providerOrderId && shiprocket.isEnabled()) {
        // An earlier booking attempt may have reached Shiprocket without us hearing back.
        providerOrderId = (await shiprocket.findOrder(order.order_number))?.providerOrderId || null;
      }
      const atShiprocket = s.provider === 'shiprocket' && providerOrderId && SHIPPABLE.includes(order.status);
      if (atShiprocket) await shiprocket.cancelOrder(providerOrderId);
      await updateShipment(s.id, { status: 'cancelled' });
      await addHistory(orderId, order.status, `Shipment cancelled${atShiprocket ? ` at Shiprocket (order ${providerOrderId}${s.awb_code ? `, AWB ${s.awb_code}` : ''})` : ''}`, 'admin');
    }
    let refundResult = null;
    if (refund && order.payment_status === 'paid') refundResult = await refundOrder(orderId, { reason: reason || 'Order cancelled' });
    await transition(orderId, 'cancelled', { note: reason || 'Cancelled by admin', actor: 'admin', notify: false });
    queueNotification(orderId, 'cancelled', { reason });
    return { refund: refundResult };
  });
}
