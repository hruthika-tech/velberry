import { Router } from 'express';
import { one, all, run, tx, isUniqueViolation } from '../db/index.js';
import { config } from '../config.js';
import { validate, addressRules, INDIAN_STATES } from '../lib/validate.js';
import { bad, conflict, unauthorized, notFound } from '../lib/errors.js';
import { hashPassword, verifyPassword, createSession, destroySession, requireUser, requireShopper, shoppingAccess, rateLimit } from '../lib/auth.js';
import * as catalog from '../services/catalog.js';
import * as cart from '../services/cart.js';
import { lookupPincode } from '../services/shipping.js';
import { orderDetail, findOrderForCustomer } from '../services/orders.js';
import * as razorpay from '../services/razorpay.js';
import { issueVerification, confirmVerification, resendVerification, verificationStatus, safeNext } from '../services/verification.js';
import { homeTeaser, shareUrl } from '../services/public-catalog.js';

const r = Router();

/* ───────── site config ───────── */
r.get('/config', (req, res) => {
  res.json({
    // Only the public Key ID is ever sent to the browser — never the key secret or webhook secret.
    paymentMode: razorpay.mode(), paymentEnv: razorpay.environment(), razorpayKeyId: config.razorpay.enabled ? config.razorpay.keyId : null,
    freeShippingAbove: config.shipping.freeAbove, flatShipping: config.shipping.flatRate, states: INDIAN_STATES,
    user: req.user ? { name: req.user.name, email: req.user.email, phone: req.user.phone, role: req.user.role, emailVerified: req.user.email_verified } : null,
  });
});

/* ───────── public homepage teaser (safe display fields only — see services/public-catalog.js) ───────── */
r.get('/home', async (_req, res) => res.json(await homeTeaser()));

/* ───────── catalog: confirmed customers only (listings, search, collections, product pages) ───────── */
r.get('/categories', requireShopper, async (_req, res) => res.json(await catalog.listCategories()));
r.get('/products', requireShopper, async (req, res) => {
  const { category, featured, q, sort } = req.query;
  res.json(await catalog.listProducts({ category, featured: featured === '1', q: q ? String(q).slice(0, 60) : '', sort }));
});
r.get('/products/:slug', requireShopper, async (req, res) => {
  const p = await catalog.getProduct(req.params.slug);
  res.json({ ...p, shareUrl: shareUrl(p.slug), related: await catalog.relatedProducts(p) });
});
r.get('/pincode/:pin', requireShopper, async (req, res) => res.json(await lookupPincode(req.params.pin)));

/* ───────── auth ───────── */
r.post('/auth/signup', rateLimit('signup', { max: 10 }), async (req, res) => {
  const v = validate(req.body, {
    name: { required: true, max: 80 }, email: { required: true, type: 'email', max: 120 },
    password: { required: true, min: 8, max: 200, message: 'Choose a password (8+ characters)' }, phone: { type: 'phone' },
  });
  const email = v.email.toLowerCase();
  let id;
  try {
    // Past guest orders with this email are NOT linked here — typing an email proves nothing. They are linked only
    // once the customer opens the confirmation link sent to that inbox (services/verification.js → confirmVerification).
    id = (await run('INSERT INTO users(email, password_hash, name, phone) VALUES (?,?,?,?)', email, hashPassword(v.password), v.name, v.phone)).id;
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('An account with this email already exists — try logging in');
    throw e;
  }
  await createSession(res, id);
  // No guest bag is merged in: shopping starts after login, and a cookie must never pull a stranger's bag into an account.
  // The confirmation email goes out after the response. If even the link can't be created, the account still works:
  // the customer is reminded on every page and can ask for a new link.
  let verificationSent = true;
  try { await issueVerification({ id, email, name: v.name }, { next: safeNext(req.body?.next) }); } catch (e) {
    verificationSent = false;
    console.error('[signup] could not create the email confirmation link:', e.message);
  }
  res.status(201).json({ ok: true, verificationSent, user: { name: v.name, email, role: 'customer', emailVerified: false } });
});

r.post('/auth/login', rateLimit('login', { max: 12 }), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = await one('SELECT * FROM users WHERE email = ?', email);
  if (!u || !verifyPassword(String(req.body?.password || ''), u.password_hash)) throw unauthorized('That email and password don\'t match');
  await createSession(res, u.id);
  res.json({ ok: true, user: { name: u.name, email: u.email, role: u.role, emailVerified: Boolean(u.email_verified_at) } });
});

/* Email confirmation: the link works without being logged in (holding the emailed token is the proof). */
r.post('/auth/verify-email', rateLimit('verify-email', { max: 30 }), async (req, res) => {
  await confirmVerification(req.body?.token);
  res.json({ ok: true });
});
// Whether a confirmation link was ever sent (pre-verification accounts haven't had one). Read-only, sends nothing.
r.get('/auth/verify-email/status', requireUser, async (req, res) => res.json(await verificationStatus(req.user.id)));
r.post('/auth/verify-email/resend', requireUser, rateLimit('verify-resend', { max: 6 }), async (req, res) => {
  res.json({ ok: true, ...(await resendVerification(req.user.id, { next: safeNext(req.body?.next) })) });
});

r.post('/auth/logout', async (req, res) => { await destroySession(req, res); res.json({ ok: true }); });

/* ───────── cart (signed-in customers only; enforced here, not just in the browser) ───────── */
// Every page asks for the bag count, so a visitor gets an empty bag + loginRequired instead of an error.
// Only a confirmed customer's bag is ever read: everyone else gets an empty bag + the reason (no bag rows are touched).
r.get('/cart', async (req, res) => {
  const access = shoppingAccess(req.user);
  if (access !== 'ok') return res.json({ ...(await cart.summarize(null)), loginRequired: access === 'login', verificationRequired: access === 'verify' });
  res.json({ ...(await cart.summarize(await cart.getCart(req, res))), loginRequired: false, verificationRequired: false });
});
r.post('/cart/items', requireShopper, async (req, res) => {
  const v = validate(req.body, { productId: { required: true, type: 'int', min: 1 }, variantId: { type: 'int', min: 1 }, quantity: { type: 'int', min: 1, max: cart.MAX_PER_LINE, default: 1 } });
  const c = await cart.getCart(req, res, { create: true });
  await cart.addItem(c, { productId: v.productId, variantId: v.variantId, quantity: v.quantity ?? 1 });
  res.json(await cart.summarize(c));
});
r.patch('/cart/items/:id', requireShopper, async (req, res) => {
  const c = await cart.getCart(req, res);
  if (!c) throw bad('Your bag is empty');
  const { quantity } = validate(req.body, { quantity: { required: true, type: 'int', min: 0, max: cart.MAX_PER_LINE } });
  await cart.setQuantity(c, Number(req.params.id) || 0, quantity);
  res.json(await cart.summarize(c));
});
r.delete('/cart/items/:id', requireShopper, async (req, res) => {
  const c = await cart.getCart(req, res);
  if (c) await cart.removeItem(c, Number(req.params.id) || 0);
  res.json(await cart.summarize(c));
});

/* ───────── order lookup & tracking ───────── */
r.post('/orders/lookup', rateLimit('lookup', { max: 30 }), async (req, res) => {
  const { orderNumber, token, email } = req.body || {};
  const o = await findOrderForCustomer({ orderNumber, token, email, user: req.user });
  if (!o) throw notFound("We couldn't find an order with those details");
  res.json(await orderDetail(o.id));
});

/* ───────── account (confirmed customers only; every query is scoped to the logged-in user's id) ───────── */
r.use('/account', requireShopper);
r.get('/account', requireUser, async (req, res) => {
  const [addresses, orders] = await Promise.all([
    all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', req.user.id),
    all(`SELECT order_number, status, payment_status, total, created_at,
           (SELECT image_url FROM order_items WHERE order_id = o.id ORDER BY id LIMIT 1) AS image,
           (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS items
         FROM orders o WHERE user_id = ? AND status <> 'abandoned' ORDER BY id DESC`, req.user.id),
  ]);
  const { email_verified: emailVerified, ...user } = req.user;
  res.json({ user: { ...user, emailVerified }, addresses, orders });
});
r.patch('/account', requireUser, async (req, res) => {
  const v = validate(req.body, { name: { required: true, max: 80 }, phone: { type: 'phone' } });
  await run('UPDATE users SET name = ?, phone = ? WHERE id = ?', v.name, v.phone, req.user.id);
  if (req.body.newPassword) {
    const u = await one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(req.body.currentPassword || ''), u.password_hash)) throw bad('Current password is incorrect', { currentPassword: 'Incorrect' });
    if (String(req.body.newPassword).length < 8) throw bad('New password must be 8+ characters', { newPassword: '8+ characters' });
    await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(req.body.newPassword)), req.user.id);
  }
  res.json({ ok: true });
});
r.get('/account/orders/:number', requireUser, async (req, res) => {
  const o = await one('SELECT id FROM orders WHERE order_number = ? AND user_id = ?', req.params.number, req.user.id);
  if (!o) throw notFound('Order not found');
  res.json(await orderDetail(o.id));
});
r.post('/account/addresses', requireUser, async (req, res) => {
  const v = validate(req.body, { ...addressRules, label: { max: 30 }, isDefault: { type: 'bool' } });
  const id = await tx(async () => {
    await one('SELECT id FROM users WHERE id = ? FOR UPDATE', req.user.id); // serialise default-address changes
    const first = !(await one('SELECT 1 FROM addresses WHERE user_id = ?', req.user.id));
    if (v.isDefault || first) await run('UPDATE addresses SET is_default = false WHERE user_id = ?', req.user.id);
    return (await run('INSERT INTO addresses(user_id, label, name, phone, line1, line2, city, state, pincode, is_default) VALUES (?,?,?,?,?,?,?,?,?,?)',
      req.user.id, v.label, v.name, v.phone, v.line1, v.line2, v.city, v.state, v.pincode, v.isDefault || first)).id;
  });
  res.status(201).json(await one('SELECT * FROM addresses WHERE id = ?', id));
});
r.put('/account/addresses/:id', requireUser, async (req, res) => {
  const v = validate(req.body, { ...addressRules, label: { max: 30 }, isDefault: { type: 'bool' } });
  const a = await one('SELECT * FROM addresses WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!a) throw notFound('Address not found');
  await tx(async () => {
    if (v.isDefault) await run('UPDATE addresses SET is_default = false WHERE user_id = ?', req.user.id);
    await run('UPDATE addresses SET label=?, name=?, phone=?, line1=?, line2=?, city=?, state=?, pincode=?, is_default=? WHERE id = ? AND user_id = ?',
      v.label, v.name, v.phone, v.line1, v.line2, v.city, v.state, v.pincode, v.isDefault || a.is_default, a.id, req.user.id);
  });
  res.json(await one('SELECT * FROM addresses WHERE id = ?', a.id));
});
r.delete('/account/addresses/:id', requireUser, async (req, res) => {
  await run('DELETE FROM addresses WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  res.json({ ok: true });
});

export default r;
