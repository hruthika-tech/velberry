/**
 * Razorpay client (https://razorpay.com/docs/api/).
 * The secret key never leaves the server. A payment is only trusted after BOTH:
 *   1. the checkout signature verifies (HMAC-SHA256 of "<our stored razorpay order id>|payment_id"), and
 *   2. the payment is fetched from Razorpay's API, belongs to that order, is in INR, for the exact amount,
 *      and its status is `captured`.
 *
 * Provider (see config.js → resolvePayments): 'razorpay' (test or live keys), 'mock' (local simulator for
 * development and tests — refused in production), or 'disabled' (with a reason). Razorpay being selected but
 * misconfigured never falls back to the simulator.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError, unavailable } from '../lib/errors.js';

const mockSecret = crypto.createHash('sha256').update(`mock:${config.sessionSecret}`).digest('hex');
const mockPayments = new Map(); // paymentId -> { orderId, amount, status }

/** 'razorpay' | 'mock' | 'disabled' */
export const mode = () => (config.razorpay.enabled ? 'razorpay' : config.mockPayments ? 'mock' : 'disabled');
/** 'test' | 'live' | null — Razorpay's own test/live mode (the simulator reports 'test'). */
export const environment = () => (mode() === 'disabled' ? null : config.payments.env);
/** Why payments are disabled, if they are (safe to show to the shop owner — contains no secrets). */
export const problem = () => config.payments.problem;
const secret = () => (mode() === 'razorpay' ? config.razorpay.keySecret : mockSecret);

export function ensure() {
  if (mode() === 'disabled') {
    throw unavailable(config.payments.provider === 'razorpay'
      ? 'Online payments are temporarily unavailable. Please try again a little later.'
      : 'Payments are not configured yet.');
  }
}

async function api(method, path, body) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  let res;
  try {
    res = await fetch(`${config.razorpay.apiBase}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new HttpError(502, `Razorpay could not be reached (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(502, `Razorpay: ${data?.error?.description || `HTTP ${res.status}`}`);
    err.razorpay = { status: res.status, code: data?.error?.code, description: data?.error?.description };
    throw err;
  }
  return data;
}

const safeEqualHex = (a, b) => {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

/* Shapes of Razorpay identifiers — anything else is rejected before it reaches the API or the database. */
export const isOrderId = (v) => typeof v === 'string' && /^order_[A-Za-z0-9]{6,40}$/.test(v);
export const isPaymentId = (v) => typeof v === 'string' && /^pay_[A-Za-z0-9]{6,40}$/.test(v);
const isSignature = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/**
 * Create a Razorpay order for an internal order. Amount is integer paise (₹1 = 100) computed by the server.
 * The response is checked: Razorpay must echo back exactly our amount, INR and our receipt.
 */
export async function createOrder({ amount, receipt, notes }) {
  ensure();
  if (!Number.isSafeInteger(amount) || amount < 100) throw new HttpError(400, 'Order amount must be at least ₹1');
  const rcpt = String(receipt).slice(0, 40); // Razorpay's receipt limit
  if (mode() === 'mock') return { id: `order_mock${crypto.randomBytes(7).toString('hex')}`, amount, currency: 'INR', receipt: rcpt };
  const ro = await api('POST', '/orders', { amount, currency: 'INR', receipt: rcpt, notes, payment_capture: 1 });
  if (!isOrderId(ro.id) || ro.amount !== amount || ro.currency !== 'INR' || ro.receipt !== rcpt) {
    throw new HttpError(502, 'Razorpay returned an order that does not match ours');
  }
  return { id: ro.id, amount: ro.amount, currency: ro.currency, receipt: ro.receipt };
}

/** Checkout signature over OUR stored Razorpay order id (never the browser's copy) and the payment id. */
export function verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  ensure();
  if (!isOrderId(razorpayOrderId) || !isPaymentId(razorpayPaymentId) || !isSignature(signature)) return false;
  const expected = crypto.createHmac('sha256', secret()).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !signature || !isSignature(String(signature))) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

/**
 * Keep only what the shop needs about a payment. Contact details, card/bank/UPI identifiers and the like
 * are dropped before anything is stored or logged.
 */
export function redact(p = {}) {
  const keep = ['id', 'entity', 'order_id', 'status', 'amount', 'currency', 'method', 'captured', 'amount_refunded', 'refund_status',
    'international', 'bank', 'wallet', 'error_code', 'error_description', 'error_source', 'error_step', 'error_reason', 'fee', 'tax', 'created_at'];
  const out = Object.fromEntries(keep.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  if (p.card?.network) out.card_network = p.card.network;
  return out;
}

const normalise = (p) => ({
  id: p.id, orderId: p.order_id, status: p.status, amount: p.amount, currency: p.currency, method: p.method,
  errorReason: p.error_description || null, raw: redact(p),
});

/** Normalised payment: { id, orderId, status, amount, currency, method, errorReason, raw } */
export async function fetchPayment(paymentId) {
  ensure();
  if (!isPaymentId(paymentId)) throw new HttpError(400, 'Invalid payment id');
  if (mode() === 'mock') {
    const p = mockPayments.get(paymentId);
    if (!p) throw new HttpError(404, 'Unknown payment');
    return { id: paymentId, orderId: p.orderId, status: p.status, amount: p.amount, currency: 'INR', method: 'mock', errorReason: null, raw: { ...p } };
  }
  return normalise(await api('GET', `/payments/${encodeURIComponent(paymentId)}`));
}

export async function fetchOrderPayments(razorpayOrderId) {
  ensure();
  if (!isOrderId(razorpayOrderId)) throw new HttpError(400, 'Invalid order id');
  if (mode() === 'mock') {
    return [...mockPayments.entries()].filter(([, p]) => p.orderId === razorpayOrderId)
      .map(([id, p]) => ({ id, orderId: p.orderId, status: p.status, amount: p.amount, currency: 'INR', method: 'mock', raw: { ...p } }));
  }
  const data = await api('GET', `/orders/${encodeURIComponent(razorpayOrderId)}/payments`);
  return (data.items || []).map(normalise);
}

/**
 * Capture an authorized payment and return Razorpay's CURRENT view of it. If it was captured meanwhile
 * (auto-capture, or the webhook and the browser racing), the fresh payment is returned instead of an error.
 */
export async function capturePayment(paymentId, amount) {
  ensure();
  if (mode() === 'mock') { const p = mockPayments.get(paymentId); if (p && p.status === 'authorized') p.status = 'captured'; return fetchPayment(paymentId); }
  try {
    return normalise(await api('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency: 'INR' }));
  } catch (e) {
    if (e.razorpay?.status === 400) return fetchPayment(paymentId); // e.g. "already captured" — see what it is now
    throw e;
  }
}

export async function refundPayment(paymentId, amount, notes = {}) {
  ensure();
  if (mode() === 'mock') return { id: `rfnd_mock${crypto.randomBytes(6).toString('hex')}`, status: 'processed', amount };
  const r = await api('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, speed: 'normal', notes });
  return { id: r.id, status: r.status, amount: r.amount };
}

/** MOCK ONLY: simulate the customer paying in the Razorpay modal. Returns what Checkout's handler would receive. */
export function simulatePayment(razorpayOrderId, amount, outcome = 'success') {
  if (mode() !== 'mock') throw new HttpError(404, 'Not found');
  const id = `pay_mock${crypto.randomBytes(7).toString('hex')}`;
  if (outcome !== 'success') {
    mockPayments.set(id, { orderId: razorpayOrderId, amount, status: 'failed' });
    return { failed: true, razorpay_payment_id: id, description: 'Simulated payment failure' };
  }
  mockPayments.set(id, { orderId: razorpayOrderId, amount, status: 'captured' });
  const signature = crypto.createHmac('sha256', mockSecret).update(`${razorpayOrderId}|${id}`).digest('hex');
  return { razorpay_order_id: razorpayOrderId, razorpay_payment_id: id, razorpay_signature: signature };
}
