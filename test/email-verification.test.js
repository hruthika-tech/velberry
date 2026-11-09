/**
 * Email verification: sign-up emails a one-time confirmation link through Resend; opening it confirms the account.
 * Verification never blocks logging in or shopping. Resend is faked inside this process (any request to
 * api.resend.com is answered here) — no email ever leaves the machine.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestEnv, makeClient, startApp } from './helpers/env.js';

const env = await setupTestEnv('verify', { RESEND_API_KEY: 're_test_not_a_real_key', EMAIL_FROM: 'CLAYSLAY <hello@clayslay.in>' });
const { one, all, run, closeDb } = await import('../server/db/index.js');
const { resetRateLimits, sha256 } = await import('../server/lib/auth.js');
const { settleBackground } = await import('../server/lib/background.js');
const { INVALID_LINK } = await import('../server/services/verification.js');

/* ── fake Resend ── */
const sent = [];
let resendReply = () => ({ status: 200, body: { id: `re_${crypto.randomBytes(4).toString('hex')}` } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, opts);
  sent.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
  const { status, body } = resendReply();
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

let app;
before(async () => { app = await startApp(); });
beforeEach(() => { resetRateLimits(); resendReply = () => ({ status: 200, body: { id: `re_${crypto.randomBytes(4).toString('hex')}` } }); });
after(async () => { await settleBackground(); globalThis.fetch = realFetch; await app.close(); await closeDb(); await env.drop(); });

const visitor = () => makeClient(() => app.base, { anonymous: true });
const mailsTo = (email) => sent.filter((m) => m.body.to.includes(email));
const linkToken = (mail) => /verify-email\.html\?token=([A-Za-z0-9_-]+)/.exec(mail.body.html)?.[1];

async function signUp() {
  const c = visitor();
  const email = `new-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const r = await c('POST', '/api/auth/signup', { name: 'Meera Iyer', email, password: 'lovely-charms-1' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await settleBackground(); // the email goes out after the response
  c.email = email;
  c.userId = (await one('SELECT id FROM users WHERE email = ?', email)).id;
  return { c, r };
}
const verifiedAt = async (id) => (await one('SELECT email_verified_at FROM users WHERE id = ?', id)).email_verified_at;

test('sign-up emails a branded confirmation link through Resend, from EMAIL_FROM, recorded as sent', async () => {
  const { c, r } = await signUp();
  assert.equal(r.data.verificationSent, true);
  assert.equal(r.data.user.emailVerified, false);
  const mails = mailsTo(c.email);
  assert.equal(mails.length, 1);
  const [m] = mails;
  assert.equal(m.url, 'https://api.resend.com/emails');
  assert.equal(m.body.from, 'CLAYSLAY <hello@clayslay.in>');
  assert.match(m.body.subject, /confirm your email/i);
  assert.match(m.body.html, /Hi Meera,/);
  assert.match(m.headers['Idempotency-Key'], /^verify-email-\d+$/);
  const token = linkToken(m);
  assert.ok(token && token.length >= 40, 'a long random token');
  // only the hash is stored
  const rows = await all('SELECT token_hash FROM email_verifications WHERE user_id = ?', c.userId);
  assert.deepEqual(rows.map((x) => x.token_hash), [sha256(token)]);
  const n = await one("SELECT * FROM notifications WHERE type = 'verify_email' AND recipient = ?", c.email);
  assert.equal(n.status, 'sent');
  assert.equal(n.order_id, null);
  assert.match(n.provider_id, /^re_/);
  // the site knows the account isn't confirmed yet
  assert.equal((await c('GET', '/api/config')).data.user.emailVerified, false);
  assert.equal((await c('GET', '/api/account')).data.user.emailVerified, false);
});

test('opening the link confirms the account — even on a device that is not logged in — and works only once', async () => {
  const { c } = await signUp();
  const token = linkToken(mailsTo(c.email)[0]);
  const elsewhere = visitor();
  const ok = await elsewhere('POST', '/api/auth/verify-email', { token });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(await verifiedAt(c.userId));
  assert.equal((await c('GET', '/api/config')).data.user.emailVerified, true);
  assert.equal((await c('GET', '/api/account')).data.user.emailVerified, true);
  assert.equal((await one('SELECT count(*)::int AS n FROM email_verifications WHERE user_id = ?', c.userId)).n, 0, 'links are used up');
  const again = await elsewhere('POST', '/api/auth/verify-email', { token });
  assert.equal(again.status, 400);
  assert.equal(again.data.error, INVALID_LINK);
  // login reports it too
  const login = await visitor()('POST', '/api/auth/login', { email: c.email, password: 'lovely-charms-1' });
  assert.equal(login.data.user.emailVerified, true);
});

test('expired, unknown and malformed links are refused and confirm nothing', async () => {
  const { c } = await signUp();
  const token = linkToken(mailsTo(c.email)[0]);
  await run("UPDATE email_verifications SET expires_at = now() - interval '1 minute' WHERE user_id = ?", c.userId);
  const v = visitor();
  for (const t of [token, crypto.randomBytes(32).toString('base64url'), '', 'short', "x' OR 1=1 --", null]) {
    const r = await v('POST', '/api/auth/verify-email', { token: t });
    assert.equal(r.status, 400, String(t));
    assert.equal(r.data.error, INVALID_LINK);
  }
  assert.equal(await verifiedAt(c.userId), null);
});

test('an unconfirmed customer can still log in and shop — confirmation is a reminder, not a wall', async () => {
  const { c } = await signUp();
  const p = await one("SELECT * FROM products WHERE slug = 'cherry-twins'");
  await run('UPDATE products SET stock = GREATEST(stock, 50), sold_out = false WHERE id = ?', p.id);
  const add = await c('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal(add.data.count, 1);
  const login = await visitor()('POST', '/api/auth/login', { email: c.email, password: 'lovely-charms-1' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.emailVerified, false);
});

test('"send a new link": needs login, waits a minute between sends, and stops once confirmed', async () => {
  assert.equal((await visitor()('POST', '/api/auth/verify-email/resend', {})).status, 401);
  const { c } = await signUp();
  const tooSoon = await c('POST', '/api/auth/verify-email/resend', {});
  assert.equal(tooSoon.status, 429);
  assert.equal(mailsTo(c.email).length, 1, 'no second email inside the cooldown');

  await run("UPDATE email_verifications SET created_at = now() - interval '2 minutes' WHERE user_id = ?", c.userId);
  const again = await c('POST', '/api/auth/verify-email/resend', {});
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.sent, true);
  await settleBackground();
  const mails = mailsTo(c.email);
  assert.equal(mails.length, 2);
  assert.notEqual(linkToken(mails[0]), linkToken(mails[1]));
  assert.notEqual(mails[0].headers['Idempotency-Key'], mails[1].headers['Idempotency-Key'], 'Resend must not dedupe a new link');

  assert.equal((await visitor()('POST', '/api/auth/verify-email', { token: linkToken(mails[1]) })).status, 200);
  const after = await c('POST', '/api/auth/verify-email/resend', {});
  assert.equal(after.data.alreadyVerified, true);
  await settleBackground();
  assert.equal(mailsTo(c.email).length, 2, 'nothing sent to a confirmed account');
});

test('if Resend refuses the email, sign-up still works and the reason is recorded for Admin → Emails', async () => {
  resendReply = () => ({ status: 403, body: { name: 'validation_error', message: 'The clayslay.in domain is not verified.' } });
  const { c, r } = await signUp();
  assert.equal(r.data.ok, true);
  const n = await one("SELECT * FROM notifications WHERE type = 'verify_email' AND recipient = ?", c.email);
  assert.equal(n.status, 'failed');
  assert.equal(n.error, 'The clayslay.in domain is not verified.');
  // the admin email list shows it without an order
  const admin = visitor();
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'test-password-123' })).status, 200);
  const list = await admin('GET', '/api/admin/notifications');
  assert.ok(list.data.some((x) => x.type === 'verify_email' && x.recipient === c.email && x.status === 'failed' && x.order_number === null));
});

/* ───────── Fix 1: past guest orders are linked only after the email is confirmed ───────── */

const { DAILY_LIMIT_REACHED, TOO_SOON } = await import('../server/services/verification.js');

/** A legacy guest order (placed before login-first shopping), optionally already owned by an account. */
async function pastOrder(email, userId = null) {
  const number = `VB-TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const { id } = await run(`INSERT INTO orders(order_number, access_token_hash, user_id, customer_name, customer_email, customer_phone,
      ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_pincode, subtotal, shipping_fee, total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, number, sha256(`t-${number}`), userId, 'Earlier Guest', email, '9876543210',
  'Earlier Guest', '9876543210', '1 Old Street', 'Pune', 'Maharashtra', '411001', 50000, 0, 50000);
  return { id, number };
}
const ownerOf = async (orderId) => (await one('SELECT user_id FROM orders WHERE id = ?', orderId)).user_id;
const newEmail = (p = 'g') => `${p}-${crypto.randomBytes(4).toString('hex')}@example.com`;
async function signUpAs(email) {
  const c = visitor();
  const r = await c('POST', '/api/auth/signup', { name: 'Meera Iyer', email, password: 'lovely-charms-1' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await settleBackground();
  c.email = email;
  c.userId = (await one('SELECT id FROM users WHERE email = ?', email)).id;
  return c;
}
const ageLinks = (userId, interval = '2 minutes') =>
  run('UPDATE email_verifications SET created_at = created_at - ?::interval WHERE user_id = ?', interval, userId);
const verifyWith = (token) => visitor()('POST', '/api/auth/verify-email', { token });

test('Fix 1: signing up with an email that has past guest orders does NOT reveal them', async () => {
  const email = newEmail();
  const past = await pastOrder(email.toUpperCase()); // stored in a different case
  const c = await signUpAs(email);
  assert.equal(await ownerOf(past.id), null, 'still a guest order');
  assert.deepEqual((await c('GET', '/api/account')).data.orders, []);
  assert.equal((await c('GET', `/api/account/orders/${past.number}`)).status, 404);
});

test('Fix 1: confirming the email links matching guest orders — never orders that belong to another account', async () => {
  const email = newEmail();
  const guest = await pastOrder(email.toUpperCase());
  const other = await run('INSERT INTO users(email, password_hash, name) VALUES (?,?,?)', newEmail('other'), 'x', 'Someone Else');
  const owned = await pastOrder(email, other.id); // same email, but already someone's
  const unrelated = await pastOrder(newEmail('unrelated'));
  const c = await signUpAs(email);
  assert.equal((await verifyWith(linkToken(mailsTo(email)[0]))).status, 200);
  assert.equal(await ownerOf(guest.id), c.userId, 'guest order linked after confirmation');
  assert.equal(await ownerOf(owned.id), other.id, 'an owned order is never moved');
  assert.equal(await ownerOf(unrelated.id), null);
  const mine = (await c('GET', '/api/account')).data.orders.map((o) => o.order_number);
  assert.deepEqual(mine, [guest.number]);
  assert.equal((await c('GET', `/api/account/orders/${guest.number}`)).status, 200);
  assert.equal((await c('GET', `/api/account/orders/${owned.number}`)).status, 404);
});

test('Fix 1: expired, invalid and already-used links link nothing', async () => {
  const email = newEmail();
  const guest = await pastOrder(email);
  const c = await signUpAs(email);
  const first = linkToken(mailsTo(email)[0]);
  await run("UPDATE email_verifications SET expires_at = now() - interval '1 second' WHERE user_id = ?", c.userId);
  assert.equal((await verifyWith(first)).status, 400, 'expired');
  assert.equal((await verifyWith(crypto.randomBytes(32).toString('base64url'))).status, 400, 'unknown');
  assert.equal((await verifyWith('not a token')).status, 400, 'malformed');
  assert.equal(await ownerOf(guest.id), null);
  assert.equal(await verifiedAt(c.userId), null);

  await ageLinks(c.userId);
  assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).status, 200);
  await settleBackground();
  const second = linkToken(mailsTo(email)[1]);
  assert.equal((await verifyWith(second)).status, 200);
  assert.equal(await ownerOf(guest.id), c.userId);

  const later = await pastOrder(email); // e.g. an old order found later
  assert.equal((await verifyWith(second)).status, 400, 'already used');
  assert.equal(await ownerOf(later.id), null, 'a used link links nothing');
});

test('Fix 1: links opened at the same time — one confirmation, no deadlock, orders linked once to the right account', async () => {
  const email = newEmail();
  const guest = await pastOrder(email);
  const c = await signUpAs(email);
  await ageLinks(c.userId);
  assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).status, 200);
  await settleBackground();
  const [t1, t2] = mailsTo(email).map(linkToken);
  const results = await Promise.all([verifyWith(t1), verifyWith(t2), verifyWith(t1), verifyWith(t2)]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400, 400, 400], JSON.stringify(results.map((r) => r.data)));
  assert.equal(await ownerOf(guest.id), c.userId);
  assert.equal((await one('SELECT count(*)::int AS n FROM email_verifications WHERE user_id = ?', c.userId)).n, 0);
});

/* ───────── Fix 2: at most 5 confirmation emails per account in any rolling 24 hours ───────── */

const linkCount = async (userId) => (await one('SELECT count(*)::int AS n FROM email_verifications WHERE user_id = ?', userId)).n;

test('Fix 2: five links per rolling 24 hours (sign-up counts), the minute cooldown still applies', async () => {
  const email = newEmail('limit');
  const c = await signUpAs(email); // link 1
  for (let i = 2; i <= 5; i++) {
    assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).data.error, TOO_SOON, 'cooldown first');
    await ageLinks(c.userId);
    const r = await c('POST', '/api/auth/verify-email/resend', {});
    assert.equal(r.status, 200, `link ${i}: ${JSON.stringify(r.data)}`);
    resetRateLimits(); // the per-IP limiter is separate; this test is about the per-account limit
  }
  await ageLinks(c.userId);
  const sixth = await c('POST', '/api/auth/verify-email/resend', {});
  assert.equal(sixth.status, 429);
  assert.equal(sixth.data.error, DAILY_LIMIT_REACHED);
  assert.doesNotMatch(sixth.data.error, /@|token|\d/i, 'nothing sensitive in the message');
  await settleBackground();
  assert.equal(mailsTo(email).length, 5);
  assert.equal(await linkCount(c.userId), 5);

  // Rolling window: still blocked just inside 24 hours …
  await run("UPDATE email_verifications SET created_at = now() - interval '23 hours 59 minutes' WHERE user_id = ?", c.userId);
  assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).data.error, DAILY_LIMIT_REACHED);
  // … and one more is allowed once the oldest link is over 24 hours old.
  await run(`UPDATE email_verifications SET created_at = now() - interval '24 hours 1 minute'
    WHERE id = (SELECT min(id) FROM email_verifications WHERE user_id = ?)`, c.userId);
  resetRateLimits();
  assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).status, 200);
  assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).status, 429, 'and the cooldown starts again');
  await settleBackground();
  assert.equal(mailsTo(email).length, 6);
});

test('Fix 2: simultaneous "send a new link" requests cannot slip past the cooldown or the daily limit', async () => {
  const email = newEmail('race');
  const c = await signUpAs(email);
  await ageLinks(c.userId);
  let results = await Promise.all(Array.from({ length: 5 }, () => c('POST', '/api/auth/verify-email/resend', {})));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429, 429, 429, 429], JSON.stringify(results.map((r) => r.data)));
  assert.ok(results.filter((r) => r.status === 429).every((r) => r.data.error === TOO_SOON));
  assert.equal(await linkCount(c.userId), 2);

  // At the edge of the daily limit (4 used), five at once → exactly one more.
  resetRateLimits();
  for (let i = 0; i < 2; i++) {
    await run("INSERT INTO email_verifications(token_hash, user_id, expires_at, created_at) VALUES (?, ?, now() + interval '1 day', now() - interval '1 hour')",
      sha256(crypto.randomUUID()), c.userId);
  }
  await ageLinks(c.userId);
  assert.equal(await linkCount(c.userId), 4);
  results = await Promise.all(Array.from({ length: 5 }, () => c('POST', '/api/auth/verify-email/resend', {})));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429, 429, 429, 429]);
  assert.equal(await linkCount(c.userId), 5);
  await ageLinks(c.userId);
  resetRateLimits();
  assert.equal((await c('POST', '/api/auth/verify-email/resend', {})).data.error, DAILY_LIMIT_REACHED);
  await settleBackground();
  assert.equal(mailsTo(email).length, 3, 'sign-up + one per race; the hand-inserted rows were never emailed');
});
