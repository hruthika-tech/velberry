/**
 * Shiprocket API client (https://apidocs.shiprocket.in).
 * Every function talks to the real API — nothing here fabricates shipments.
 * When credentials are missing, callers get a clear 503 instead of a fake success.
 *
 * Shiprocket has no sandbox, so calls that book or change a shipment (create order, AWB, pickup, label,
 * cancel) are refused outside production unless SHIPROCKET_ALLOW_BOOKING=true. Read-only calls
 * (login, pickup locations, serviceability, tracking) are always allowed once credentials are set.
 * Credentials and the API token stay on the server; the token lives in the `settings` table, which the
 * public Supabase roles cannot read (see 002_rls.sql).
 */
import { config } from '../config.js';
import { getSetting, setSetting, withLock } from '../db/index.js';
import { HttpError, unavailable } from '../lib/errors.js';

const base = () => config.shiprocket.apiBase;
const TOKEN_KEY = 'shiprocket_token';
const TOKEN_LIFETIME_MS = 9 * 86400e3; // Shiprocket tokens last 10 days (240 h); refresh a day early.

export const isEnabled = () => config.shiprocket.enabled;
export const bookingAllowed = () => config.shiprocket.allowBooking;

function ensure() {
  if (!isEnabled()) throw unavailable('Shiprocket is not configured. Add SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD to .env.');
}
function ensureBooking() {
  ensure();
  if (!bookingAllowed()) {
    throw unavailable('Booking real Shiprocket shipments is switched off on this server (development). Set SHIPROCKET_ALLOW_BOOKING=true only when you really mean to book.');
  }
}

/** Log in and store the token. One login at a time, even with several requests (or servers) racing. */
async function login(staleToken) {
  return withLock('shiprocket-login', async () => {
    // Someone else may have refreshed it while we waited for the lock.
    const current = await readToken();
    if (current && current.token !== staleToken) return current.token;
    let res;
    try {
      res = await fetch(`${base()}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: config.shiprocket.email, password: config.shiprocket.password }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new HttpError(502, `Shiprocket could not be reached (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new HttpError(502, `Shiprocket login failed: ${String(body.message || `HTTP ${res.status}`).slice(0, 200)}`);
    await setSetting(TOKEN_KEY, JSON.stringify({ token: body.token, exp: Date.now() + TOKEN_LIFETIME_MS }));
    return body.token;
  });
}

async function readToken() {
  try {
    const t = JSON.parse(await getSetting(TOKEN_KEY, 'null'));
    return t && typeof t.token === 'string' && t.exp > Date.now() ? t : null;
  } catch { return null; }
}

async function token() {
  return (await readToken())?.token || login(null);
}

async function api(method, path, body, retried = false) {
  ensure();
  const tok = await token();
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new HttpError(502, `Shiprocket could not be reached (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
  }
  // Token expired or revoked early → log in again once and repeat the call.
  if (res.status === 401 && !retried) { await login(tok); return api(method, path, body, true); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Only Shiprocket's message is kept (never the request/response bodies, which carry customer details).
    const msg = data.message || (data.errors && Object.values(data.errors).flat().join('; ')) || `HTTP ${res.status}`;
    const err = new HttpError(502, `Shiprocket: ${String(msg).slice(0, 300)}`);
    err.shiprocket = { status: res.status, message: String(msg) };
    throw err;
  }
  return data;
}

/* ───────── pickup location ───────── */

let pickupCache = null; // { at, list }

/** Pickup addresses registered in Shiprocket → [{ name, pincode, city, state, active }]. */
export async function pickupLocations({ fresh = false } = {}) {
  if (!fresh && pickupCache && Date.now() - pickupCache.at < 10 * 60e3) return pickupCache.list;
  const data = await api('GET', '/settings/company/pickup');
  const list = (data?.data?.shipping_address || []).map((a) => ({
    name: a.pickup_location, pincode: String(a.pin_code || ''), city: a.city || null, state: a.state || null,
    active: a.status === undefined ? true : Number(a.status) === 2 || a.status === true || a.status === 'active',
  }));
  pickupCache = { at: Date.now(), list };
  return list;
}

/**
 * The configured pickup location (SHIPROCKET_PICKUP_LOCATION must match the nickname exactly — Shiprocket
 * rejects bookings otherwise). Its registered PIN is what rates and serviceability are calculated from.
 */
export async function resolvePickup({ fresh = false } = {}) {
  const list = await pickupLocations({ fresh });
  const p = list.find((x) => x.name === config.shiprocket.pickupLocation);
  if (!p) {
    throw new HttpError(503, `Pickup location "${config.shiprocket.pickupLocation}" was not found in Shiprocket`
      + ` (available: ${list.map((x) => `"${x.name}"`).join(', ') || 'none'}). Fix SHIPROCKET_PICKUP_LOCATION.`);
  }
  if (!/^[1-9]\d{5}$/.test(p.pincode)) throw new HttpError(503, `Pickup location "${p.name}" has no valid PIN code in Shiprocket`);
  return p;
}

/* ───────── rates & serviceability ───────── */

const quoteCache = new Map(); // key → { at, value }

/**
 * Courier options for a delivery PIN and a parcel ({ weightGrams, lengthCm, breadthCm, heightCm }).
 * Returns { serviceable, couriers[], recommended, pickupPincode }. Rates are paise.
 */
export async function serviceability({ deliveryPincode, parcel, declaredValue }) {
  const pickup = await resolvePickup();
  const weightKg = Math.max(0.05, parcel.weightGrams / 1000);
  const q = new URLSearchParams({
    pickup_postcode: pickup.pincode, delivery_postcode: deliveryPincode, weight: weightKg.toFixed(3), cod: '0',
    length: String(parcel.lengthCm), breadth: String(parcel.breadthCm), height: String(parcel.heightCm),
    ...(declaredValue ? { declared_value: String(declaredValue) } : {}),
  });
  const key = q.toString();
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.value;

  let data;
  try {
    data = await api('GET', `/courier/serviceability/?${q}`);
  } catch (e) {
    // Shiprocket answers 404 (or 422) for PIN codes no courier serves
    if (e.shiprocket && (e.shiprocket.status === 404 || /not serviceable|no courier/i.test(e.shiprocket.message))) {
      return remember(key, { serviceable: false, couriers: [], recommended: null, pickupPincode: pickup.pincode });
    }
    throw e;
  }
  if (Number(data?.status) === 404) return remember(key, { serviceable: false, couriers: [], recommended: null, pickupPincode: pickup.pincode });
  const couriers = (data?.data?.available_courier_companies || [])
    .filter((c) => !Number(c.blocked))
    .map((c) => ({
      id: String(c.courier_company_id), name: c.courier_name, rate: Math.round(Number(c.rate) * 100),
      etd: c.etd || null, etdDays: Number(c.estimated_delivery_days) || null,
      chargeableKg: Number(c.charge_weight) || null, surface: Boolean(Number(c.is_surface)), rating: Number(c.rating) || null,
    }))
    .filter((c) => c.id && Number.isFinite(c.rate) && c.rate > 0);
  const recId = String(data?.data?.recommended_courier_company_id ?? data?.data?.shiprocket_recommended_courier_id ?? '');
  const recommended = couriers.find((c) => c.id === recId) || couriers.slice().sort((a, b) => a.rate - b.rate)[0] || null;
  return remember(key, { serviceable: couriers.length > 0, couriers, recommended, pickupPincode: pickup.pincode });
}
function remember(key, value) {
  quoteCache.set(key, { at: Date.now(), value });
  if (quoteCache.size > 500) quoteCache.delete(quoteCache.keys().next().value);
  return value;
}

/* ───────── booking ───────── */

/** Create the order in Shiprocket. Returns { providerOrderId, providerShipmentId }. */
export async function createOrder(order, items, parcel) {
  ensureBooking();
  const pickup = await resolvePickup();
  const [first, ...rest] = order.ship_name.trim().split(/\s+/);
  const data = await api('POST', '/orders/create/adhoc', {
    order_id: order.order_number,
    order_date: new Date(order.paid_at || order.created_at).toISOString().slice(0, 16).replace('T', ' '),
    pickup_location: pickup.name,
    billing_customer_name: first,
    billing_last_name: rest.join(' ') || '.',
    billing_address: order.ship_line1,
    billing_address_2: order.ship_line2 || '',
    billing_city: order.ship_city,
    billing_pincode: order.ship_pincode,
    billing_state: order.ship_state,
    billing_country: 'India',
    billing_email: order.customer_email,
    billing_phone: order.ship_phone,
    shipping_is_billing: true,
    order_items: items.map((i) => ({
      name: i.product_name + (i.variant_name ? ` (${i.variant_name})` : ''),
      sku: i.sku || `VB-${i.product_id}-${i.variant_id || 0}`,
      units: i.quantity,
      selling_price: (i.unit_price / 100).toFixed(2),
    })),
    payment_method: 'Prepaid',
    shipping_charges: (order.shipping_fee / 100).toFixed(2),
    sub_total: (order.subtotal / 100).toFixed(2),
    length: parcel.lengthCm, breadth: parcel.breadthCm, height: parcel.heightCm,
    weight: Number(Math.max(0.05, parcel.weightGrams / 1000).toFixed(3)),
  });
  if (!data.order_id || !data.shipment_id) throw new HttpError(502, `Shiprocket did not confirm the order${data.message ? `: ${String(data.message).slice(0, 200)}` : ''}`);
  return { providerOrderId: String(data.order_id), providerShipmentId: String(data.shipment_id) };
}

/**
 * Find an order already created in Shiprocket for this Velberry order number (e.g. our previous attempt
 * timed out after Shiprocket had created it). Returns { providerOrderId, providerShipmentId, awb } or null.
 */
export async function findOrder(orderNumber) {
  ensure();
  const data = await api('GET', `/orders?search=${encodeURIComponent(orderNumber)}`);
  const match = (data?.data || []).find((o) => String(o.channel_order_id) === orderNumber && !/CANCEL/i.test(String(o.status || '')));
  if (!match) return null;
  const sh = match.shipments?.[0] || {};
  const shipmentId = sh.id ?? match.shipment_id;
  if (!match.id || !shipmentId) return null;
  return { providerOrderId: String(match.id), providerShipmentId: String(shipmentId), awb: sh.awb || null };
}

/** Current AWB/courier of a shipment, if Shiprocket already assigned one. */
async function shipmentAwb(shipmentId) {
  const data = await api('GET', `/shipments/${encodeURIComponent(shipmentId)}`);
  const d = data?.data || {};
  const awb = d.awb || d.awb_code;
  return awb ? { awb: String(awb), courierName: d.courier || d.courier_name || null, courierId: d.courier_id ? String(d.courier_id) : null } : null;
}

/** Assign AWB (optionally to a specific courier). Returns { awb, courierName, courierId }. */
export async function assignAwb(shipmentId, courierId) {
  ensureBooking();
  let data;
  try {
    data = await api('POST', '/courier/assign/awb', { shipment_id: Number(shipmentId), ...(courierId ? { courier_id: Number(courierId) } : {}) });
  } catch (e) {
    // Our previous attempt may have succeeded without us hearing back ("AWB is already assigned").
    const existing = await shipmentAwb(shipmentId).catch(() => null);
    if (existing) return existing;
    throw e;
  }
  const r = data?.response?.data;
  if (!Number(data.awb_assign_status) || !r?.awb_code) {
    const existing = await shipmentAwb(shipmentId).catch(() => null);
    if (existing) return existing;
    throw new HttpError(502, `AWB not assigned: ${String(r?.awb_assign_error || data.message || 'unknown reason').slice(0, 200)}`);
  }
  return { awb: String(r.awb_code), courierName: r.courier_name || null, courierId: r.courier_company_id ? String(r.courier_company_id) : null };
}

export async function schedulePickup(shipmentId) {
  ensureBooking();
  let data;
  try {
    data = await api('POST', '/courier/generate/pickup', { shipment_id: [Number(shipmentId)] });
  } catch (e) {
    if (/already in pickup queue|already.*pickup/i.test(e.shiprocket?.message || '')) return { pickupScheduledAt: null, already: true };
    throw e;
  }
  if (!Number(data.pickup_status)) throw new HttpError(502, `Pickup not scheduled: ${String(data.response?.data || data.message || 'unknown').slice(0, 200)}`);
  return { pickupScheduledAt: data.response?.pickup_scheduled_date || null, token: data.response?.pickup_token_number || null };
}

export async function generateLabel(shipmentId) {
  ensureBooking();
  const data = await api('POST', '/courier/generate/label', { shipment_id: [Number(shipmentId)] });
  if (!data.label_url || (data.label_created !== undefined && !Number(data.label_created))) {
    throw new HttpError(502, `Label not generated: ${String(data.response || data.message || 'unknown').slice(0, 200)}`);
  }
  return { labelUrl: data.label_url };
}

/** Cancel a Shiprocket order (before pickup). Cancelling one that is already cancelled counts as done. */
export async function cancelOrder(providerOrderId) {
  ensureBooking();
  try {
    return await api('POST', '/orders/cancel', { ids: [Number(providerOrderId)] });
  } catch (e) {
    if (/already (been )?cancel/i.test(e.shiprocket?.message || '')) return { already: true };
    throw e;
  }
}

/* ───────── tracking ───────── */

export async function track(awb) {
  const data = await api('GET', `/courier/track/awb/${encodeURIComponent(awb)}`);
  const td = data?.tracking_data || {};
  const st = td.shipment_track?.[0] || {};
  return {
    currentStatus: st.current_status || null,
    etd: td.etd || st.edd || null,
    trackUrl: td.track_url || null,
    courierName: st.courier_name || null,
    activities: (td.shipment_track_activities || []).map((a) => ({
      at: a.date, status: a['sr-status-label'] || a.activity, description: a.activity, location: a.location,
    })),
  };
}

/**
 * Shiprocket timestamps come in several shapes ("2026-11-06 14:05:09", "06 11 2026 14:05:09", ISO) and are
 * Indian time when no zone is given. Returns an ISO string, or null if unreadable.
 */
export function parseTime(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) {
    const d = /^(\d{2})[ \-/](\d{2})[ \-/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (d) m = [d[0], d[3], d[2], d[1], d[4], d[5], d[6]];
  }
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (/\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/**
 * Map Shiprocket status text → Velberry order status (null when it doesn't move the order).
 */
export function mapStatus(text) {
  const s = String(text || '').toUpperCase().replace(/_/g, ' ');
  if (!s) return null;
  if (s.includes('RTO') && s.includes('DELIVERED')) return 'rto_delivered';
  if (s.includes('RTO')) return 'rto_initiated';
  if (s.includes('OUT FOR DELIVERY')) return 'out_for_delivery';
  if (s === 'DELIVERED') return 'delivered';
  if (/UNDELIVERED|DELIVERY FAILED|FAILED DELIVERY|NDR/.test(s)) return 'delivery_failed';
  if (/PICKED UP|IN TRANSIT|SHIPPED|REACHED|DESTINATION|OUT FOR PICKUP DONE/.test(s)) return 'shipped';
  if (/PICKUP SCHEDULED|PICKUP GENERATED|OUT FOR PICKUP|AWB ASSIGNED|MANIFEST/.test(s)) return 'ready_to_ship';
  if (/CANCEL/.test(s)) return null; // handled by admin, never auto-cancels a paid order
  return null;
}

/** Statuses that need the shop owner's attention (shown in the order history), but don't move the order. */
export const needsAttention = (text) => /LOST|DAMAGE|DESTROY|DISPOSED|MISROUTED|PICKUP EXCEPTION|SELF FULFILLED/i.test(String(text || ''));
