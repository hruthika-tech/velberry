import { config } from '../config.js';
import { bad, unavailable } from '../lib/errors.js';
import * as shiprocket from './shiprocket.js';

/** Fast estimate shown in the bag before a PIN code is known. */
export function estimateShipping(subtotal) {
  const free = config.shipping.freeAbove > 0 && subtotal >= config.shipping.freeAbove;
  return { fee: free ? 0 : config.shipping.flatRate, freeAbove: config.shipping.freeAbove };
}

/**
 * The parcel for a set of lines ({ weightGrams|weight_grams, quantity }): the items' actual weight plus packing,
 * in the configured box. Couriers bill the higher of actual and volumetric weight (L×B×H / 5000 kg), so both
 * are reported; Shiprocket receives the actual weight and the dimensions and applies the same rule itself.
 */
export function parcelFor(lines) {
  const { lengthCm, breadthCm, heightCm, packagingGrams } = config.parcel;
  const itemsGrams = lines.reduce((g, l) => g + (Number(l.weightGrams ?? l.weight_grams) || 30) * l.quantity, 0);
  const weightGrams = Math.round(itemsGrams + packagingGrams);
  const volumetricGrams = Math.round((lengthCm * breadthCm * heightCm) / 5000 * 1000);
  return { weightGrams, lengthCm, breadthCm, heightCm, volumetricGrams, chargeableGrams: Math.max(weightGrams, volumetricGrams) };
}

/**
 * Authoritative quote for checkout: validates the PIN code and (when Shiprocket is configured)
 * confirms a courier can actually deliver there.
 */
export async function quoteForCheckout({ subtotal, pincode, lines }) {
  if (!/^[1-9]\d{5}$/.test(String(pincode || ''))) throw bad('Enter a valid 6-digit PIN code', { pincode: 'Enter a valid 6-digit PIN code' });
  const base = estimateShipping(subtotal);
  if (!shiprocket.isEnabled()) {
    return { ...base, serviceable: true, courier: null, etd: null, source: 'flat' };
  }
  const parcel = parcelFor(lines);
  let s;
  try {
    s = await shiprocket.serviceability({ deliveryPincode: pincode, parcel, declaredValue: Math.round(subtotal / 100) });
  } catch (e) {
    // Shiprocket unreachable/misconfigured. With a flat fee the price doesn't depend on Shiprocket, so the sale
    // can go ahead (the courier is confirmed when the order is booked); with courier pricing we can't quote.
    console.warn('[shipping] serviceability check failed:', e.message);
    if (config.shipping.feeMode === 'courier' && base.fee > 0) throw unavailable("We can't fetch delivery rates right now — please try again in a few minutes.");
    return { ...base, serviceable: true, courier: null, etd: null, source: 'flat-unverified' };
  }
  if (!s.serviceable) {
    throw bad("Our couriers can't reach this PIN code yet 🥺 Please try another address.", { pincode: 'Not serviceable' });
  }
  let fee = base.fee;
  if (config.shipping.feeMode === 'courier' && fee > 0) fee = Math.ceil(s.recommended.rate / 100) * 100;
  return {
    fee, freeAbove: base.freeAbove, serviceable: true, source: 'shiprocket',
    courier: s.recommended?.name || null, etd: s.recommended?.etd || null, etdDays: s.recommended?.etdDays || null,
  };
}

/** City/state lookup from India Post's public API (best-effort; never blocks checkout). */
export async function lookupPincode(pin) {
  if (!/^[1-9]\d{5}$/.test(pin)) throw bad('Invalid PIN code');
  try {
    const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const po = j?.[0]?.PostOffice?.[0];
    if (j?.[0]?.Status !== 'Success' || !po) return { pincode: pin, found: false };
    return { pincode: pin, found: true, city: po.District, state: po.State };
  } catch {
    return { pincode: pin, found: false };
  }
}
