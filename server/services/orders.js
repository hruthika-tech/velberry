import crypto from 'node:crypto';
import { one, all, run, tx, lockKey } from '../db/index.js';
import { config } from '../config.js';
import { bad, conflict, notFound } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/auth.js';
import { resolveLine } from './catalog.js';
import { queueNotification } from './notifications.js';

/** Allowed order state transitions. Anything else is rejected. */
export const TRANSITIONS = {
  pending_payment: ['paid', 'abandoned', 'cancelled'],
  abandoned: ['paid'], // a late payment can still arrive for an expired checkout
  paid: ['preparing', 'packed', 'ready_to_ship', 'shipped', 'cancelled'],
  preparing: ['packed', 'ready_to_ship', 'cancelled'],
  packed: ['preparing', 'ready_to_ship', 'shipped', 'cancelled'],
  ready_to_ship: ['packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated'],
  out_for_delivery: ['shipped', 'delivered', 'delivery_failed', 'rto_initiated'],
  delivery_failed: ['shipped', 'out_for_delivery', 'delivered', 'rto_initiated'],
  rto_initiated: ['rto_delivered', 'delivered'],
  rto_delivered: ['cancelled'],
  delivered: [],
  cancelled: [],
};

export const STATUS_LABELS = {
  pending_payment: 'Awaiting payment', abandoned: 'Checkout expired', paid: 'Payment confirmed',
  preparing: 'Being prepared', packed: 'Packed with love', ready_to_ship: 'Ready for pickup', shipped: 'Shipped',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', delivery_failed: 'Delivery attempt failed',
  rto_initiated: 'Returning to us', rto_delivered: 'Returned to us', cancelled: 'Cancelled',
};

/** The 8-step customer timeline; each order status maps to how far along it is. */
export const TIMELINE = [
  { key: 'placed', label: 'Order placed' },
  { key: 'paid', label: 'Payment confirmed' },
  { key: 'preparing', label: 'Order being prepared' },
  { key: 'packed', label: 'Packed with love' },
  { key: 'ready_to_ship', label: 'Ready for pickup' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
];
const STEP_OF = {
  pending_payment: 0, abandoned: 0, paid: 1, preparing: 2, packed: 3, ready_to_ship: 4, shipped: 5,
  delivery_failed: 5, rto_initiated: 5, rto_delivered: 5, out_for_delivery: 6, delivered: 7, cancelled: -1,
};

const NOTIFY_ON = {
  preparing: 'order_preparing', shipped: 'shipped', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  delivery_failed: 'delivery_failed', cancelled: 'cancelled', rto_initiated: 'rto_initiated',
};

function newOrderNumber() {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(5)) s += alphabet[b % alphabet.length];
  return `VB-${ymd}-${s}`;
}

/** Lock one order row for the rest of the current transaction. */
const lockOrder = (orderId) => one('SELECT * FROM orders WHERE id = ? FOR UPDATE', orderId);

/**
 * Change stock atomically. Decrements are conditional (`stock >= n`): Postgres locks the row, so a
 * concurrent buyer waits and then re-checks — the last piece can only ever be taken once.
 */
async function adjustStock(line, delta, reason, orderId, { force = false } = {}) {
  const table = line.variant_id ? 'product_variants' : 'products';
  const id = line.variant_id || line.product_id;
  if (delta < 0 && !force) {
    const r = await run(`UPDATE ${table} SET stock = stock + ? WHERE id = ? AND stock >= ?`, delta, id, -delta);
    if (r.changes !== 1) return false;
  } else if (delta < 0) {
    await run(`UPDATE ${table} SET stock = GREATEST(0, stock + ?) WHERE id = ?`, delta, id);
  } else {
    await run(`UPDATE ${table} SET stock = stock + ? WHERE id = ?`, delta, id);
  }
  await run('INSERT INTO inventory_movements(product_id, variant_id, delta, reason, order_id) VALUES (?,?,?,?,?)',
    line.product_id, line.variant_id || null, delta, reason, orderId);
  return true;
}

/**
 * Create an order awaiting payment. Prices and stock come from the DB, never the client.
 * Stock is reserved immediately (atomic conditional decrement) so two customers can't buy the last piece.
 * Same idempotencyKey → same order (double-clicks / retries never create duplicates, even when concurrent).
 */
export async function createPendingOrder({ lines, customer, address, userId, idempotencyKey, giftNote, shippingFee }) {
  if (!lines.length) throw bad('Your bag is empty');
  return tx(async () => {
    const resolved = [];
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) throw bad('Invalid quantity');
      resolved.push({ ...(await resolveLine(l.productId, l.variantId)), quantity: l.quantity });
    }
    // Always lock stock rows in the same order, so two multi-item checkouts can't deadlock.
    resolved.sort((a, b) => a.productId - b.productId || (a.variantId || 0) - (b.variantId || 0));
    const subtotal = resolved.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

    if (idempotencyKey) {
      await lockKey(`checkout:${idempotencyKey}`); // concurrent requests with the same key queue here
      const existing = await one('SELECT * FROM orders WHERE idempotency_key = ? FOR UPDATE', idempotencyKey);
      if (existing && SETTLED.includes(existing.payment_status)) {
        throw conflict('This checkout was already completed', { orderNumber: existing.order_number });
      }
      if (existing && existing.status === 'pending_payment') {
        // Reuse it only if it is still exactly what the server-side bag says now (items, prices, delivery fee).
        const items = await all('SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ? ORDER BY product_id, variant_id', existing.id);
        const same = existing.subtotal === subtotal && existing.shipping_fee === shippingFee && items.length === resolved.length
          && items.every((it, i) => it.product_id === resolved[i].productId && (it.variant_id || null) === (resolved[i].variantId || null) && it.quantity === resolved[i].quantity);
        if (same) {
          const token = randomToken();
          await run('UPDATE orders SET access_token_hash = ? WHERE id = ?', sha256(token), existing.id);
          return { order: existing, accessToken: token, reused: true };
        }
        // The bag changed since this checkout started: retire it (its stock goes back; a payment that still
        // arrives for it is honoured like any late payment) and start a fresh one below.
        await transition(existing.id, 'abandoned', { note: 'Bag changed before payment — replaced by a new checkout', notify: false });
      }
      // Unpaid and no longer payable here (expired, cancelled or replaced): free the key for a fresh checkout.
      if (existing) await run('UPDATE orders SET idempotency_key = NULL WHERE id = ?', existing.id);
    }
    const token = randomToken();
    const expires = new Date(Date.now() + config.checkoutTtlMinutes * 60e3).toISOString();

    let orderNumber = newOrderNumber();
    while (await one('SELECT 1 FROM orders WHERE order_number = ?', orderNumber)) orderNumber = newOrderNumber();

    const { id: orderId } = await run(
      `INSERT INTO orders(order_number, user_id, idempotency_key, access_token_hash, customer_name, customer_email, customer_phone,
        ship_name, ship_phone, ship_line1, ship_line2, ship_city, ship_state, ship_pincode, subtotal, shipping_fee, total, gift_note, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderNumber, userId || null, idempotencyKey || null, sha256(token), customer.name, customer.email, customer.phone,
      address.name, address.phone, address.line1, address.line2 || null, address.city, address.state, address.pincode,
      subtotal, shippingFee, subtotal + shippingFee, giftNote || null, expires);

    for (const l of resolved) {
      const ok = await adjustStock({ product_id: l.productId, variant_id: l.variantId }, -l.quantity, 'reserve', orderId);
      if (!ok) {
        const now = await one(`SELECT stock FROM ${l.variantId ? 'product_variants' : 'products'} WHERE id = ?`, l.variantId || l.productId);
        throw conflict(!now?.stock ? `${l.name} just sold out 🥺` : `Only ${now.stock} of ${l.name} left — please update your bag`,
          { productId: l.productId, available: now?.stock ?? 0 });
      }
      await run(`INSERT INTO order_items(order_id, product_id, variant_id, product_name, variant_name, sku, image_url, unit_price, quantity, line_total)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
        orderId, l.productId, l.variantId, l.name, l.variantName, l.sku, l.image, l.unitPrice, l.quantity, l.unitPrice * l.quantity);
    }
    await addHistory(orderId, null, 'pending_payment', 'Checkout started', 'customer');
    return { order: await one('SELECT * FROM orders WHERE id = ?', orderId), accessToken: token, reused: false };
  });
}

const addHistory = (orderId, from, to, note, actor = 'system') =>
  run('INSERT INTO order_status_history(order_id, from_status, to_status, note, actor) VALUES (?,?,?,?,?)', orderId, from, to, note || null, actor);

/** Return reserved stock. Must be called with the order row locked; the stock_reserved flag makes it run once. */
async function releaseStock(order, reason) {
  if (!order.stock_reserved) return;
  const items = await all('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id, variant_id', order.id);
  for (const it of items) if (it.product_id) await adjustStock(it, it.quantity, reason, order.id);
  await run('UPDATE orders SET stock_reserved = false WHERE id = ?', order.id);
}

/**
 * How far along a payment is. Events can arrive late or out of order (a webhook for "authorized" after the
 * one for "captured"), so a stored status only ever moves forward — a captured payment is never downgraded.
 */
/** Order payment states that mean money was received (whether or not some of it was refunded since). */
const SETTLED = ['paid', 'partially_refunded', 'refunded'];
const SETTLED_SQL = `(${SETTLED.map((s) => `'${s}'`).join(',')})`;

const PAY_RANK_SQL =(col) => `CASE ${col} WHEN 'refunded' THEN 4 WHEN 'captured' THEN 3 WHEN 'authorized' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END`;

/** Record a payment attempt (any status). Unique by provider payment id. */
export async function recordPayment(orderId, p) {
  await run(`INSERT INTO payments(order_id, provider_order_id, provider_payment_id, status, method, amount, error_reason, raw)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT (provider_payment_id) DO UPDATE SET
               status = CASE WHEN ${PAY_RANK_SQL('excluded.status')} >= ${PAY_RANK_SQL('payments.status')} THEN excluded.status ELSE payments.status END,
               method = COALESCE(excluded.method, payments.method),
               error_reason = CASE WHEN ${PAY_RANK_SQL('excluded.status')} >= ${PAY_RANK_SQL('payments.status')} THEN excluded.error_reason ELSE payments.error_reason END,
               raw = CASE WHEN ${PAY_RANK_SQL('excluded.status')} >= ${PAY_RANK_SQL('payments.status')} THEN excluded.raw ELSE payments.raw END,
               updated_at = now()
             RETURNING id`,
  orderId, p.orderId || null, p.id, p.status, p.method || null, p.amount, p.errorReason || null, JSON.stringify(p.raw || {}));
  return one('SELECT * FROM payments WHERE provider_payment_id = ?', p.id);
}

/**
 * Mark an order paid from a VERIFIED payment (server-fetched from Razorpay). Idempotent and race-safe:
 * the browser's verify call and the webhook may arrive at the same moment — the order row lock makes
 * them take turns, and only the first one changes anything.
 */
export async function markPaid(orderId, payment, source) {
  let changed = false;
  const result = await tx(async () => {
    const order = await lockOrder(orderId);
    if (!order) throw notFound('Order not found');
    // A payment can only ever settle the order it was made for.
    if (payment.orderId && order.razorpay_order_id && payment.orderId !== order.razorpay_order_id) {
      throw conflict('Payment does not belong to this order');
    }
    await recordPayment(order.id, payment);
    // Already settled — including after a (partial) refund: a late or repeated "captured" event must not
    // turn a refunded order back into "paid" or move a shipped order back to "Payment confirmed".
    if (SETTLED.includes(order.payment_status)) return { order, alreadyPaid: true };
    if (payment.status !== 'captured') return { order, notPaid: true }; // authorized/created/failed are never "paid"
    if (payment.amount !== order.total || (payment.currency && payment.currency !== 'INR')) {
      await addHistory(order.id, order.status, order.status,
        `Payment ${payment.id} of ${payment.amount} ${payment.currency || ''} ≠ order total ${order.total} INR — NOT marked paid`, source);
      return { order, amountMismatch: true };
    }
    if (order.status === 'cancelled') {
      // Money arrived for an order that was already cancelled: record it as paid so the admin sees it and can refund,
      // but never revive the order or re-reserve stock.
      await run(`UPDATE orders SET payment_status = 'paid', paid_at = now(), updated_at = now() WHERE id = ? AND payment_status NOT IN ${SETTLED_SQL}`, order.id);
      await addHistory(order.id, 'cancelled', 'cancelled', `⚠ Payment ${payment.id} received after cancellation — please refund it`, source);
      return { order: await one('SELECT * FROM orders WHERE id = ?', order.id), paidAfterCancel: true };
    }
    let note = `Payment ${payment.id} verified via ${source}`;
    if (!order.stock_reserved) {
      // Late payment for an expired checkout: re-reserve (clamped) and flag shortfalls for the admin.
      const short = [];
      for (const it of await all('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id, variant_id', order.id)) {
        if (!it.product_id) continue;
        if (!(await adjustStock(it, -it.quantity, 'reserve', order.id))) {
          await adjustStock(it, -it.quantity, 'reserve', order.id, { force: true });
          short.push(it.product_name);
        }
      }
      await run('UPDATE orders SET stock_reserved = true WHERE id = ?', order.id);
      if (short.length) note += ` · ⚠ paid after checkout expired; stock was short for: ${short.join(', ')}`;
    }
    const r = await run(`UPDATE orders SET status = 'paid', payment_status = 'paid', paid_at = now(), updated_at = now()
                         WHERE id = ? AND payment_status NOT IN ${SETTLED_SQL}`, order.id);
    changed = r.changes === 1;
    if (changed) await addHistory(order.id, order.status, 'paid', note, source);
    return { order: await one('SELECT * FROM orders WHERE id = ?', order.id), alreadyPaid: !changed };
  });
  if (changed) {
    queueNotification(orderId, 'order_confirmed');
    queueNotification(orderId, 'owner_new_order');
  }
  return result;
}

export async function recordFailedPayment(orderId, payment) {
  await tx(async () => {
    const order = await lockOrder(orderId);
    if (payment.orderId && order.razorpay_order_id && payment.orderId !== order.razorpay_order_id) return;
    const row = await recordPayment(orderId, payment);
    // A late "failed" event for a payment we already know succeeded changes nothing and adds no note.
    if (row.status === 'failed') {
      await addHistory(orderId, order.status, order.status, `Payment attempt failed: ${payment.errorReason || 'unknown reason'}`, 'razorpay');
    }
  });
}

/** Move an order to a new status, enforcing allowed transitions. Returns false if already there. */
export async function transition(orderId, to, { note, actor = 'system', notify = true } = {}) {
  const { order, changed } = await tx(async () => {
    const o = await lockOrder(orderId);
    if (!o) throw notFound('Order not found');
    if (o.status === to) return { order: o, changed: false };
    if (!TRANSITIONS[o.status]?.includes(to)) {
      throw bad(`Can't move an order from "${STATUS_LABELS[o.status]}" to "${STATUS_LABELS[to] || to}"`);
    }
    await run('UPDATE orders SET status = ?, updated_at = now() WHERE id = ?', to, orderId);
    if (to === 'cancelled' || to === 'abandoned') await releaseStock(o, to === 'cancelled' ? 'cancel' : 'release');
    if (to === 'abandoned') await run("UPDATE orders SET payment_status = 'expired' WHERE id = ? AND payment_status = 'pending'", orderId);
    if (to === 'rto_delivered') await releaseStock(o, 'restock');
    await addHistory(orderId, o.status, to, note, actor);
    return { order: o, changed: true };
  });
  if (changed && notify && NOTIFY_ON[to] && order.payment_status !== 'pending') queueNotification(orderId, NOTIFY_ON[to]);
  return changed;
}

/** Load a full order view (items, payments, shipment, tracking, history). */
export async function orderDetail(orderId, { admin = false } = {}) {
  const o = await one('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) throw notFound('Order not found');
  const [items, shipment, events, history, payments, refunds] = await Promise.all([
    all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', o.id),
    one('SELECT * FROM shipments WHERE order_id = ?', o.id),
    all('SELECT status, description, location, occurred_at FROM tracking_events WHERE order_id = ? ORDER BY occurred_at DESC, id DESC', o.id),
    all('SELECT from_status, to_status, note, actor, created_at FROM order_status_history WHERE order_id = ? ORDER BY id', o.id),
    all('SELECT id, provider_payment_id, status, method, amount, error_reason, created_at FROM payments WHERE order_id = ? ORDER BY id', o.id),
    all('SELECT id, provider_refund_id, amount, status, reason, created_at FROM refunds WHERE order_id = ? ORDER BY id', o.id),
  ]);

  const step = STEP_OF[o.status] ?? 0;
  const reachedAt = (st) => history.find((h) => h.to_status === st)?.created_at || null;
  const timeline = TIMELINE.map((t, i) => ({
    ...t, done: o.status !== 'cancelled' && i <= step, current: i === step,
    at: i === 0 ? o.created_at : i === 1 ? o.paid_at : reachedAt(t.key),
  }));

  const view = {
    orderNumber: o.order_number, status: o.status, statusLabel: STATUS_LABELS[o.status] || o.status,
    paymentStatus: o.payment_status, createdAt: o.created_at, paidAt: o.paid_at,
    customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
    address: { name: o.ship_name, phone: o.ship_phone, line1: o.ship_line1, line2: o.ship_line2, city: o.ship_city, state: o.ship_state, pincode: o.ship_pincode },
    items: items.map((i) => ({ name: i.product_name, variantName: i.variant_name, image: i.image_url, unitPrice: i.unit_price, quantity: i.quantity, lineTotal: i.line_total, productId: i.product_id })),
    subtotal: o.subtotal, shippingFee: o.shipping_fee, total: o.total, giftNote: o.gift_note,
    refundedAmount: refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amount, 0),
    shipment: shipment ? {
      courier: shipment.courier_name, awb: shipment.awb_code, trackingUrl: shipment.tracking_url, etd: shipment.etd,
      status: shipment.status, pickupScheduledAt: shipment.pickup_scheduled_at, provider: shipment.provider,
    } : null,
    timeline, isCancelled: o.status === 'cancelled', isException: ['delivery_failed', 'rto_initiated', 'rto_delivered'].includes(o.status),
    trackingEvents: events,
  };
  if (admin) {
    Object.assign(view, {
      id: o.id, userId: o.user_id, razorpayOrderId: o.razorpay_order_id, expiresAt: o.expires_at, history, payments, refunds,
      shipmentRaw: shipment || null, allowedTransitions: TRANSITIONS[o.status] || [],
      items: items.map((i, idx) => ({ ...view.items[idx], id: i.id, sku: i.sku, variantId: i.variant_id })),
    });
  }
  return view;
}

/** Customer access: logged-in owner, or the secret token from the confirmation link, or order number + email/phone. */
export async function findOrderForCustomer({ orderNumber, token, email, user }) {
  const o = await one('SELECT * FROM orders WHERE order_number = ?', String(orderNumber || '').trim().toUpperCase());
  if (!o) return null;
  if (user && (o.user_id === user.id || user.role === 'admin')) return o;
  if (token && crypto.timingSafeEqual(Buffer.from(sha256(String(token))), Buffer.from(o.access_token_hash))) return o;
  if (email) {
    const e = String(email).trim().toLowerCase();
    const digits = e.replace(/\D/g, '').slice(-10);
    if (e === o.customer_email.toLowerCase() || (digits.length === 10 && (digits === o.customer_phone || digits === o.ship_phone))) return o;
  }
  return null;
}

/**
 * Expire unpaid checkouts past their reservation window and release stock.
 * Before expiring, ask Razorpay whether a payment actually went through (webhook may have been missed).
 */
export async function expireStaleCheckouts(razorpay) {
  const stale = await all("SELECT * FROM orders WHERE status = 'pending_payment' AND expires_at < now()");
  for (const o of stale) {
    try {
      if (o.razorpay_order_id) {
        // Never release stock without asking Razorpay first. If we can't ask (gateway down or misconfigured),
        // leave the order reserved and try again on the next run.
        const simulated = o.razorpay_order_id.startsWith('order_mock');
        if (razorpay.mode() === 'disabled' || (razorpay.mode() === 'mock') !== simulated) {
          console.warn(`[orders] ${o.order_number}: cannot check its payment with the current payment provider — not expiring it yet`);
          continue;
        }
        const pays = await razorpay.fetchOrderPayments(o.razorpay_order_id);
        const captured = pays.find((p) => p.status === 'captured');
        if (captured) { await markPaid(o.id, captured, 'reconciliation'); continue; }
        const authorized = pays.find((p) => p.status === 'authorized');
        if (authorized) {
          const now = await razorpay.capturePayment(authorized.id, authorized.amount);
          if (now.status === 'captured') { await markPaid(o.id, now, 'reconciliation'); continue; }
          await recordPayment(o.id, now);
          console.warn(`[orders] ${o.order_number}: payment ${now.id} is ${now.status} — keeping the order reserved`);
          continue;
        }
      }
      await transition(o.id, 'abandoned', { note: `No payment within ${config.checkoutTtlMinutes} minutes — stock released` });
    } catch (e) {
      console.error(`[orders] could not reconcile ${o.order_number}:`, e.message);
    }
  }
  return stale.length;
}

/**
 * Release expired checkouts at most once per `everyMs` across ALL server instances — for serverless hosts, where
 * no 5-minute timer runs. Called when a new checkout starts, so a sold-out item held by an abandoned checkout is
 * freed before the next customer is told it's unavailable. One instance wins the slot (atomic UPDATE on settings);
 * the others skip. Never throws: a failure here must not block a customer's checkout.
 */
export async function expireStaleCheckoutsThrottled(razorpay, { everyMs = 5 * 60e3 } = {}) {
  try {
    const now = Date.now();
    const won = await one(`INSERT INTO settings(key, value) VALUES ('job_expire_checkouts_last_run', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
      WHERE CASE WHEN settings.value ~ '^[0-9]{1,15}$' THEN settings.value::bigint < ? ELSE true END
      RETURNING key`, String(now), now - everyMs);
    if (!won) return null;
    return await expireStaleCheckouts(razorpay);
  } catch (e) {
    console.warn('[orders] expiring stale checkouts failed:', e.message);
    return null;
  }
}
