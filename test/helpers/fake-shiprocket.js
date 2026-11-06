/**
 * An in-memory stand-in for the Shiprocket API (only the calls Velberry makes), so shipping can be tested end
 * to end without booking anything real. Mirrors Shiprocket where it matters: email/password login issuing a
 * bearer token, 401 for unknown/expired tokens, pickup locations by nickname, rates from the chargeable weight
 * (higher of actual and L×B×H/5000), 404 for unserviceable PINs, one AWB per shipment, "Already in Pickup Queue",
 * order search by channel order id, cancellation only before pickup.
 *
 * Failure switches (state.*): loseNext = { path } → do the work but drop the connection (a lost response);
 * failLabelOnce, failLoginOnce.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export async function startFakeShiprocket({ email, password, pickups = [{ pickup_location: 'Velberry Studio', pin_code: '500001', city: 'Hyderabad', state: 'Telangana', status: 2 }] }) {
  const tokens = new Set();
  const orders = new Map();    // srOrderId → order
  const shipments = new Map(); // shipmentId → { id, orderId, awb, courierId, courierName, pickup, label, cancelled, pickedUp }
  const tracks = new Map();    // awb → tracking_data
  const calls = [];
  const state = { loseNext: null, failLabelOnce: false, failLoginOnce: false, unserviceable: new Set(['799999']), unserviceable200: new Set(['788888']) };
  let seq = 1000;

  const COURIERS = [
    { courier_company_id: 10, courier_name: 'Delhivery Surface', base: 40, perHalfKg: 30, etd: 'Nov 12, 2026', days: '5', is_surface: 1, blocked: 0 },
    { courier_company_id: 20, courier_name: 'Bluedart Air', base: 70, perHalfKg: 45, etd: 'Nov 9, 2026', days: '2', is_surface: 0, blocked: 0 },
    { courier_company_id: 30, courier_name: 'Blocked Express', base: 10, perHalfKg: 5, etd: 'Nov 8, 2026', days: '1', is_surface: 0, blocked: 1 },
  ];

  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/v1\/external/, '');
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization || null });
    const lose = state.loseNext && state.loseNext.path === path ? (state.loseNext = null, true) : false;
    const reply = (status, b) => (lose ? res.destroy() : send(res, status, b));

    if (req.method === 'POST' && path === '/auth/login') {
      if (state.failLoginOnce) { state.failLoginOnce = false; return send(res, 503, { message: 'Service unavailable' }); }
      if (body?.email !== email || body?.password !== password) return send(res, 400, { message: 'Invalid email and password combination' });
      const t = `tok_${crypto.randomBytes(12).toString('hex')}`;
      tokens.add(t);
      return send(res, 200, { token: t, email, id: 1 });
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!auth || !tokens.has(auth)) return send(res, 401, { message: 'Token has expired', status_code: 401 });

    let m;
    if (req.method === 'GET' && path === '/settings/company/pickup') {
      return send(res, 200, { data: { shipping_address: pickups } });
    }
    if (req.method === 'GET' && path === '/courier/serviceability/') {
      const q = Object.fromEntries(url.searchParams);
      if (!pickups.some((p) => p.pin_code === q.pickup_postcode)) return send(res, 422, { message: 'Pickup postcode is not valid' });
      if (state.unserviceable.has(q.delivery_postcode)) return send(res, 404, { message: 'Delivery postcode not serviceable', status: 404 });
      if (state.unserviceable200.has(q.delivery_postcode)) return send(res, 200, { status: 404, message: 'No courier is available' });
      const actual = Number(q.weight);
      const volumetric = (Number(q.length || 0.5) * Number(q.breadth || 0.5) * Number(q.height || 0.5)) / 5000;
      const charge = Math.max(actual, volumetric);
      const slabs = Math.ceil(charge / 0.5);
      return send(res, 200, {
        status: 200,
        data: {
          recommended_courier_company_id: 10,
          available_courier_companies: COURIERS.map((c) => ({
            courier_company_id: c.courier_company_id, courier_name: c.courier_name, rate: c.base + c.perHalfKg * slabs, etd: c.etd,
            estimated_delivery_days: c.days, is_surface: c.is_surface, blocked: c.blocked, charge_weight: slabs * 0.5, rating: 4.2,
          })),
        },
      });
    }
    if (req.method === 'POST' && path === '/orders/create/adhoc') {
      if (!pickups.some((p) => p.pickup_location === body?.pickup_location)) return send(res, 422, { message: 'Wrong Pickup location entered.' });
      for (const k of ['order_id', 'billing_customer_name', 'billing_address', 'billing_pincode', 'billing_phone', 'length', 'breadth', 'height', 'weight']) {
        if (body?.[k] === undefined || body[k] === '') return send(res, 422, { message: `The ${k} field is required.` });
      }
      const o = { id: ++seq, channel_order_id: body.order_id, status: 'NEW', payload: body };
      const sh = { id: ++seq, orderId: o.id, awb: null, courierId: null, courierName: null, pickup: false, label: null, cancelled: false, pickedUp: false };
      o.shipmentId = sh.id;
      orders.set(o.id, o);
      shipments.set(sh.id, sh);
      return reply(200, { order_id: o.id, shipment_id: sh.id, status: 'NEW', status_code: 1 });
    }
    if (req.method === 'GET' && path === '/orders') {
      const s = url.searchParams.get('search') || '';
      const data = [...orders.values()].filter((o) => o.channel_order_id.includes(s)).map((o) => ({
        id: o.id, channel_order_id: o.channel_order_id, status: o.status, shipments: [{ id: o.shipmentId, awb: shipments.get(o.shipmentId).awb }],
      }));
      return send(res, 200, { data });
    }
    if (req.method === 'POST' && path === '/courier/assign/awb') {
      const sh = shipments.get(Number(body?.shipment_id));
      if (!sh) return send(res, 400, { message: 'Invalid shipment id' });
      if (sh.awb) return send(res, 400, { message: 'AWB is already assigned' });
      const c = COURIERS.find((x) => x.courier_company_id === Number(body.courier_id || 10));
      if (!c || c.blocked) return send(res, 200, { awb_assign_status: 0, response: { data: { awb_assign_error: 'Selected courier is not serviceable' } } });
      sh.awb = `AWB${++seq}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      sh.courierId = c.courier_company_id;
      sh.courierName = c.courier_name;
      return reply(200, { awb_assign_status: 1, response: { data: { awb_code: sh.awb, courier_company_id: c.courier_company_id, courier_name: c.courier_name, shipment_id: sh.id } } });
    }
    if (req.method === 'GET' && (m = /^\/shipments\/(\d+)$/.exec(path))) {
      const sh = shipments.get(Number(m[1]));
      if (!sh) return send(res, 404, { message: 'Not found' });
      return send(res, 200, { data: { id: sh.id, awb: sh.awb || '', courier: sh.courierName, courier_id: sh.courierId } });
    }
    if (req.method === 'POST' && path === '/courier/generate/pickup') {
      const sh = shipments.get(Number(body?.shipment_id?.[0]));
      if (!sh?.awb) return send(res, 400, { message: 'AWB not assigned' });
      if (sh.pickup) return send(res, 400, { message: 'Already in Pickup Queue.' });
      sh.pickup = true;
      return reply(200, { pickup_status: 1, response: { pickup_scheduled_date: '2026-11-07 11:00:00', pickup_token_number: `PT${seq}`, status: 3 } });
    }
    if (req.method === 'POST' && path === '/courier/generate/label') {
      const sh = shipments.get(Number(body?.shipment_id?.[0]));
      if (!sh?.awb) return send(res, 400, { message: 'AWB not assigned' });
      if (state.failLabelOnce) { state.failLabelOnce = false; return send(res, 200, { label_created: 0, response: 'Label generation failed, try again' }); }
      sh.label = `https://kr-shipmultichannel.s3.amazonaws.com/labels/${sh.id}.pdf`;
      return send(res, 200, { label_created: 1, label_url: sh.label, not_created: [] });
    }
    if (req.method === 'POST' && path === '/orders/cancel') {
      for (const id of body?.ids || []) {
        const o = orders.get(Number(id));
        if (!o) return send(res, 400, { message: 'Invalid order id' });
        const sh = shipments.get(o.shipmentId);
        if (o.status === 'CANCELED') return send(res, 400, { message: 'Order has already been cancelled' });
        if (sh.pickedUp) return send(res, 400, { message: 'Order cannot be cancelled after pickup' });
        o.status = 'CANCELED';
        sh.cancelled = true;
      }
      return send(res, 200, { message: 'Order cancelled successfully' });
    }
    if (req.method === 'GET' && (m = /^\/courier\/track\/awb\/(.+)$/.exec(path))) {
      const t = tracks.get(decodeURIComponent(m[1]));
      return send(res, 200, { tracking_data: t || { track_status: 0, shipment_track: [], shipment_track_activities: [] } });
    }
    send(res, 404, { message: `fake shiprocket: no route ${req.method} ${path}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}/v1/external`,
    orders, shipments, tracks, calls, state, tokens,
    /** Simulate Shiprocket expiring every token early. */
    expireTokens: () => tokens.clear(),
    bookingCalls: () => calls.filter((c) => c.method === 'POST' && c.path !== '/auth/login'),
    close: () => new Promise((r) => server.close(r)),
  };
}
