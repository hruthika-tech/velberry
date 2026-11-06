/**
 * A small in-memory stand-in for the Razorpay REST API (only the calls Velberry makes), so payments can be
 * tested end to end without network access or real money. Behaves like Razorpay where it matters:
 * Basic auth with the key pair, orders echo amount/currency/receipt, payments belong to one order,
 * capture only works on authorized payments, errors use Razorpay's { error: { code, description } } shape.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const rid = (prefix) => `${prefix}${crypto.randomBytes(10).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 14)}`;

export async function startFakeRazorpay({ keyId, keySecret }) {
  const orders = new Map();
  const payments = new Map();
  const calls = [];
  const state = { holdCapture: false }; // true → capture is refused and the payment stays "authorized"

  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const fail = (res, status, description, code = 'BAD_REQUEST_ERROR') => send(res, status, { error: { code, description } });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const path = new URL(req.url, 'http://x').pathname;
    calls.push({ method: req.method, path, body });
    if (req.headers.authorization !== `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`) {
      return fail(res, 401, 'The api key provided is invalid');
    }
    let m;
    if (req.method === 'POST' && path === '/v1/orders') {
      if (!Number.isInteger(body?.amount) || body.amount < 100) return fail(res, 400, 'The amount must be atleast INR 1.00');
      const o = { id: rid('order_'), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: 'created', attempts: 0 };
      orders.set(o.id, o);
      return send(res, 200, o);
    }
    if (req.method === 'GET' && (m = /^\/v1\/payments\/([^/]+)$/.exec(path))) {
      const p = payments.get(decodeURIComponent(m[1]));
      return p ? send(res, 200, p) : fail(res, 400, 'The id provided does not exist');
    }
    if (req.method === 'GET' && (m = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (!orders.has(id)) return fail(res, 400, 'The id provided does not exist');
      const items = [...payments.values()].filter((p) => p.order_id === id);
      return send(res, 200, { entity: 'collection', count: items.length, items });
    }
    if (req.method === 'POST' && (m = /^\/v1\/payments\/([^/]+)\/capture$/.exec(path))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return fail(res, 400, 'The id provided does not exist');
      if (p.status === 'captured') return fail(res, 400, 'This payment has already been captured');
      if (p.status !== 'authorized' || state.holdCapture) return fail(res, 400, 'Capture failed');
      if (body?.amount !== p.amount) return fail(res, 400, 'Capture amount must be equal to the amount authorized');
      p.status = 'captured';
      p.captured = true;
      return send(res, 200, p);
    }
    if (req.method === 'POST' && (m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(path))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p || p.status !== 'captured') return fail(res, 400, 'The payment has not been captured');
      return send(res, 200, { id: rid('rfnd_'), entity: 'refund', amount: body.amount, payment_id: p.id, status: 'processed' });
    }
    fail(res, 404, `fake razorpay: no route ${req.method} ${path}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    orders, payments, calls, state,
    /** The customer pays in the Checkout modal. Returns the payment id. */
    pay(orderId, { status = 'captured', amount, currency = 'INR', method = 'upi', error = null } = {}) {
      const o = orders.get(orderId);
      const p = {
        id: rid('pay_'), entity: 'payment', order_id: orderId, amount: amount ?? o.amount, currency, status, method,
        captured: status === 'captured', email: 'customer@example.com', contact: '+919876543210', vpa: 'customer@okbank',
        card: method === 'card' ? { id: rid('card_'), last4: '1111', network: 'Visa', name: 'Asha Rao' } : null,
        error_code: error ? 'BAD_REQUEST_ERROR' : null, error_description: error, created_at: Math.floor(Date.now() / 1000),
      };
      payments.set(p.id, p);
      if (o) o.attempts++;
      return p.id;
    },
    /** What Razorpay Checkout hands to the success handler. */
    checkoutResponse(orderId, paymentId) {
      return {
        razorpay_order_id: orderId, razorpay_payment_id: paymentId,
        razorpay_signature: crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex'),
      };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
