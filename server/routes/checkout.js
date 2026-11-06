import { Router } from 'express';
import { config } from '../config.js';
import { one, run, withLock } from '../db/index.js';
import { validate, addressRules } from '../lib/validate.js';
import { bad, conflict, notFound, forbidden } from '../lib/errors.js';
import { rateLimit } from '../lib/auth.js';
import * as cart from '../services/cart.js';
import * as razorpay from '../services/razorpay.js';
import { quoteForCheckout } from '../services/shipping.js';
import { expireStaleCheckoutsThrottled, createPendingOrder, markPaid, recordFailedPayment, recordPayment, transition, findOrderForCustomer } from '../services/orders.js';

const r = Router();

async function readyCart(req, res) {
  // Serverless: no background timer releases abandoned checkouts, so do it (throttled) before checking stock.
  if (config.checkoutExpiryOnRequest) await expireStaleCheckoutsThrottled(razorpay);
  const c = await cart.getCart(req, res);
  const s = await cart.summarize(c);
  if (!s.items.length) throw bad('Your bag is empty');
  const problem = s.items.find((i) => i.problem);
  if (problem) throw conflict(`${problem.name}: ${problem.problem}. Please update your bag.`);
  return { c, s };
}

/** Shipping quote for a PIN code against the current bag. */
// Rate-limited: every quote may ask Shiprocket, and this endpoint is public.
r.post('/quote', rateLimit('quote', { max: 60 }), async (req, res) => {
  const { s } = await readyCart(req, res);
  const q = await quoteForCheckout({ subtotal: s.subtotal, pincode: String(req.body?.pincode || ''), lines: s.items });
  res.json({ ...q, subtotal: s.subtotal, total: s.subtotal + q.fee });
});

/**
 * Create the order (stock reserved) + matching Razorpay order. Prices come from the server-side cart only.
 */
r.post('/order', rateLimit('checkout', { max: 30, windowMs: 10 * 60e3 }), async (req, res) => {
  razorpay.ensure(); // payments unavailable → say so before reserving any stock
  const { s } = await readyCart(req, res);
  const customer = validate(req.body?.customer, { name: { required: true, max: 80 }, email: { required: true, type: 'email', max: 120 }, phone: { required: true, type: 'phone' } });
  let address;
  try {
    address = validate(req.body?.address, addressRules);
  } catch (e) {
    // receiver name/phone share names with the contact fields — prefix them so the form highlights the right box
    const d = Object.fromEntries(Object.entries(e.details || {}).map(([k, v]) => [k === 'name' || k === 'phone' ? `a_${k}` : k, v]));
    throw bad(e.message, d);
  }
  const giftNote = String(req.body?.giftNote || '').trim().slice(0, 300);
  const idempotencyKey = String(req.body?.idempotencyKey || '').slice(0, 100) || null;

  const quote = await quoteForCheckout({ subtotal: s.subtotal, pincode: address.pincode, lines: s.items });

  const { order, accessToken, reused } = await createPendingOrder({
    lines: s.items.map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity })),
    customer, address, userId: req.user?.id, idempotencyKey, giftNote, shippingFee: quote.fee,
  });

  if (req.user && req.body?.saveAddress && !reused) {
    const dup = await one('SELECT 1 FROM addresses WHERE user_id = ? AND line1 = ? AND pincode = ?', req.user.id, address.line1, address.pincode);
    if (!dup) {
      const first = !(await one('SELECT 1 FROM addresses WHERE user_id = ?', req.user.id));
      await run('INSERT INTO addresses(user_id, name, phone, line1, line2, city, state, pincode, is_default) VALUES (?,?,?,?,?,?,?,?,?)',
        req.user.id, address.name, address.phone, address.line1, address.line2, address.city, address.state, address.pincode, first);
    }
  }

  // One Razorpay order per internal order: concurrent duplicate requests queue on this lock, and the
  // later ones find the id the first one stored (so Razorpay never gets a second order for the same checkout).
  const rzpOrderId = await withLock(`razorpay-order:${order.id}`, async () => {
    const current = await one('SELECT razorpay_order_id, total, status FROM orders WHERE id = ?', order.id);
    if (current.razorpay_order_id) return current.razorpay_order_id;
    try {
      // Amount = the order total in integer paise, computed on the server from database prices + shipping.
      const ro = await razorpay.createOrder({ amount: current.total, receipt: order.order_number, notes: { order_number: order.order_number } });
      await run('UPDATE orders SET razorpay_order_id = ? WHERE id = ? AND razorpay_order_id IS NULL', ro.id, order.id);
      return ro.id;
    } catch (e) {
      await transition(order.id, 'cancelled', { note: `Payment gateway error: ${e.message}`, notify: false });
      throw e;
    }
  });

  res.status(reused ? 200 : 201).json({
    orderNumber: order.order_number, accessToken, amount: order.total, currency: 'INR',
    razorpayOrderId: rzpOrderId, razorpayKeyId: razorpay.mode() === 'razorpay' ? config.razorpay.keyId : null,
    paymentMode: razorpay.mode(), paymentEnv: razorpay.environment(), prefill: { name: customer.name, email: customer.email, contact: customer.phone },
  });
});

async function orderFromRequest(body, req) {
  const o = await findOrderForCustomer({ orderNumber: body?.orderNumber, token: body?.accessToken, user: req.user });
  if (!o) throw notFound('Order not found');
  return o;
}

/**
 * Verify a payment reported by Razorpay Checkout. We never trust the browser: the signature must match
 * AND the payment fetched from Razorpay must belong to this order and be for the exact amount.
 */
r.post('/verify', rateLimit('verify', { max: 40 }), async (req, res) => {
  razorpay.ensure();
  const o = await orderFromRequest(req.body, req);
  const { razorpay_order_id: browserOrderId, razorpay_payment_id: payId, razorpay_signature: sig } = req.body || {};
  // Source of truth is OUR stored Razorpay order id. The browser's copy must merely agree with it.
  const expectedOrderId = o.razorpay_order_id;
  if (!expectedOrderId) throw bad('This order has no payment in progress');
  if (browserOrderId !== undefined && browserOrderId !== expectedOrderId) throw forbidden('Payment does not belong to this order');
  if (!razorpay.isPaymentId(payId)) throw bad('Invalid payment details');
  if (!razorpay.verifyCheckoutSignature({ razorpayOrderId: expectedOrderId, razorpayPaymentId: payId, signature: sig })) {
    throw bad('Payment signature could not be verified');
  }
  // The signature proves Razorpay issued this payment id for our order; the API tells us what actually happened.
  let p = await razorpay.fetchPayment(payId);
  if (p.orderId !== expectedOrderId) throw forbidden('Payment does not belong to this order');
  if (p.currency !== 'INR' || p.amount !== o.total) {
    await markPaid(o.id, p, 'checkout'); // records the attempt and flags the mismatch in the order history
    throw bad('Payment amount mismatch — our team has been alerted');
  }
  if (p.status === 'authorized') p = await razorpay.capturePayment(p.id, p.amount); // returns Razorpay's current state
  if (p.status === 'failed') {
    await recordFailedPayment(o.id, p);
    throw bad(p.errorReason || 'Payment failed — no money was taken. You can try again.');
  }
  if (p.status !== 'captured') {
    // Authorized but not yet captured (or still processing): never treated as paid. The webhook or the
    // expiry reconciliation completes it; the success page keeps checking.
    await recordPayment(o.id, p);
    return res.status(202).json({ ok: false, pending: true, orderNumber: o.order_number, paymentStatus: 'pending' });
  }
  const result = await markPaid(o.id, p, 'checkout');
  if (result.amountMismatch) throw bad('Payment amount mismatch — our team has been alerted');
  if (result.notPaid) throw bad(`Payment is ${p.status}`);
  if (result.paidAfterCancel) throw conflict('This order had already been cancelled, so your payment will be refunded in full. Sorry for the trouble!');
  const c = await cart.getCart(req, res);
  if (c) await cart.clearCart(c.id);
  res.json({ ok: true, orderNumber: o.order_number, paymentStatus: 'paid' });
});

/** Customer saw a failure / closed the modal. Recorded for the admin; order stays payable until it expires. */
r.post('/failed', rateLimit('pay-failed', { max: 60 }), async (req, res) => {
  const o = await orderFromRequest(req.body, req);
  const payId = String(req.body?.razorpay_payment_id || '');
  if (razorpay.isPaymentId(payId) && razorpay.mode() !== 'disabled') {
    try {
      const p = await razorpay.fetchPayment(payId);
      if (p.orderId === o.razorpay_order_id && p.status === 'failed') await recordFailedPayment(o.id, p);
    } catch { /* unknown payment id — ignore */ }
  }
  res.json({ ok: true });
});

/** LOCAL TEST MODE ONLY — simulate the Razorpay modal. 404s whenever real keys are configured or in production. */
r.post('/mock-pay', async (req, res) => {
  if (razorpay.mode() !== 'mock') throw notFound();
  const o = await orderFromRequest(req.body, req);
  res.json(razorpay.simulatePayment(o.razorpay_order_id, o.total, req.body?.outcome === 'fail' ? 'fail' : 'success'));
});

export default r;
