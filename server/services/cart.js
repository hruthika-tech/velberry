import { one, all, run, tx } from '../db/index.js';
import { randomToken, setCookie } from '../lib/auth.js';
import { bad, conflict } from '../lib/errors.js';
import { resolveLine } from './catalog.js';
import { estimateShipping } from './shipping.js';

const GUEST_COOKIE = 'vb_cart';
const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/; // randomToken(24) → 32 base64url chars
export const MAX_PER_LINE = 20;

/** Find (optionally create) the cart for this request: user cart when logged in, else guest cookie cart. */
export async function getCart(req, res, { create = false } = {}) {
  if (req.user) {
    let cart = await one('SELECT * FROM carts WHERE user_id = ?', req.user.id);
    if (!cart && create) {
      // ON CONFLICT: two simultaneous first "add to bag" clicks still produce exactly one cart
      cart = await one(`INSERT INTO carts(user_id) VALUES (?)
                        ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING *`, req.user.id);
    }
    return cart || null;
  }
  // A guest gets their bag token on their first request (every page loads GET /api/cart), before any cart row exists.
  // Parallel first "add to bag" clicks then all carry the same token and land in ONE cart (ON CONFLICT below).
  let token = req.cookies.vb_cart;
  if (!GUEST_TOKEN_RE.test(token || '')) {
    token = randomToken(24);
    req.cookies.vb_cart = token;
    setCookie(res, GUEST_COOKIE, token, { maxAgeDays: 60 });
  }
  let cart = await one('SELECT * FROM carts WHERE guest_token = ? AND user_id IS NULL', token);
  if (!cart && create) {
    cart = await one(`INSERT INTO carts(guest_token) VALUES (?)
                      ON CONFLICT (guest_token) DO UPDATE SET updated_at = now() RETURNING *`, token);
  }
  return cart || null;
}

/** On login/signup: fold the guest cart into the user's cart (quantities are added, capped by stock). */
export async function mergeGuestCart(req, res, userId) {
  const token = req.cookies.vb_cart;
  if (!token) return;
  const guest = await one('SELECT * FROM carts WHERE guest_token = ? AND user_id IS NULL', token);
  if (!guest) return;
  await tx(async () => {
    const cart = await one(`INSERT INTO carts(user_id) VALUES (?)
                            ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING *`, userId);
    await one('SELECT id FROM carts WHERE id = ? FOR UPDATE', cart.id);
    for (const it of await all('SELECT * FROM cart_items WHERE cart_id = ?', guest.id)) {
      try {
        await upsertLine(cart.id, it.product_id, it.variant_id, it.quantity, { add: true, clamp: true });
      } catch { /* item no longer available — skip it */ }
    }
    await run('DELETE FROM carts WHERE id = ?', guest.id);
  });
  res.append('Set-Cookie', `${GUEST_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
}

async function upsertLine(cartId, productId, variantId, qty, { add = false, clamp = false } = {}) {
  const line = await resolveLine(productId, variantId);
  const existing = await one('SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ? AND COALESCE(variant_id, 0) = ?',
    cartId, line.productId, line.variantId ?? 0);
  let next = add ? (existing?.quantity || 0) + qty : qty;
  const cap = Math.min(line.stock, MAX_PER_LINE);
  if (next > cap) {
    if (!clamp) {
      throw conflict(line.stock <= 0 ? `${line.name} is sold out` : `Only ${line.stock} of ${line.name} available`, { available: line.stock });
    }
    next = cap;
  }
  if (next <= 0) {
    if (existing) await run('DELETE FROM cart_items WHERE id = ?', existing.id);
    return;
  }
  if (existing) await run('UPDATE cart_items SET quantity = ? WHERE id = ?', next, existing.id);
  else await run('INSERT INTO cart_items(cart_id, product_id, variant_id, quantity) VALUES (?,?,?,?)', cartId, line.productId, line.variantId, next);
  await run('UPDATE carts SET updated_at = now() WHERE id = ?', cartId);
}

/** Changes to one bag are serialised by locking the cart row, so parallel clicks can't double-count. */
const withCartLock = (cartId, fn) => tx(async () => {
  await one('SELECT id FROM carts WHERE id = ? FOR UPDATE', cartId);
  return fn();
});

export async function addItem(cart, { productId, variantId, quantity }) {
  if (!Number.isInteger(quantity) || quantity < 1) throw bad('Quantity must be at least 1');
  await withCartLock(cart.id, () => upsertLine(cart.id, productId, variantId || null, quantity, { add: true }));
}

export async function setQuantity(cart, itemId, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) throw bad('Invalid quantity');
  await withCartLock(cart.id, async () => {
    const it = await one('SELECT * FROM cart_items WHERE id = ? AND cart_id = ?', itemId, cart.id);
    if (!it) throw bad('That item is not in your bag');
    await upsertLine(cart.id, it.product_id, it.variant_id, quantity);
  });
}

export async function removeItem(cart, itemId) {
  await run('DELETE FROM cart_items WHERE id = ? AND cart_id = ?', itemId, cart.id);
}

export const clearCart = (cartId) => run('DELETE FROM cart_items WHERE cart_id = ?', cartId);

/**
 * Price the cart from live DB data. Lines whose stock has dropped are flagged (never silently oversold).
 */
export async function summarize(cart) {
  const rows = cart ? await all('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY id', cart.id) : [];
  const items = [];
  for (const r of rows) {
    let line;
    try { line = await resolveLine(r.product_id, r.variant_id); } catch { await run('DELETE FROM cart_items WHERE id = ?', r.id); continue; }
    items.push({
      id: r.id, productId: line.productId, variantId: line.variantId, slug: line.slug, name: line.name,
      variantName: line.variantName, image: line.image, unitPrice: line.unitPrice, quantity: r.quantity,
      lineTotal: line.unitPrice * r.quantity, stock: line.stock, maxQuantity: Math.min(line.stock, MAX_PER_LINE),
      problem: line.stock <= 0 ? 'Sold out' : r.quantity > line.stock ? `Only ${line.stock} available` : null,
      weightGrams: line.weightGrams,
    });
  }
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const count = items.reduce((s, i) => s + i.quantity, 0);
  const estimate = estimateShipping(subtotal);
  return { items, count, subtotal, shippingEstimate: estimate.fee, freeShippingAbove: estimate.freeAbove, total: subtotal + (count ? estimate.fee : 0) };
}
