import crypto from 'node:crypto';
import { one, run } from '../db/index.js';
import { config } from '../config.js';
import { unauthorized, forbidden } from './errors.js';

const SESSION_COOKIE = 'vb_session';
const SESSION_DAYS = 30;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

export function setCookie(res, name, value, { maxAgeDays = 30, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${Math.round(maxAgeDays * 86400)}`];
  if (httpOnly) parts.push('HttpOnly');
  if (config.isProd) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export const clearCookie = (res, name) => res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax`);

export async function createSession(res, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  await run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  setCookie(res, SESSION_COOKIE, token, { maxAgeDays: SESSION_DAYS });
}

export async function destroySession(req, res) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  clearCookie(res, SESSION_COOKIE);
}

/** Parses cookies and attaches req.user when the session is valid. */
export async function sessionMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    const row = await one(
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.email_verified_at IS NOT NULL AS email_verified FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > now()`, sha256(token));
    if (row) req.user = row;
  }
  next();
}

export const requireUser = (req, _res, next) => (req.user ? next() : next(unauthorized()));

/** Shopping (bag, checkout, payment) needs a signed-in customer — checked here on the server, never in the browser. */
export const LOGIN_TO_SHOP = 'A little login first! Create your account or sign in to add your favourite charms to your bag.';
export const requireShopper = (req, _res, next) => {
  if (req.user) return next();
  const e = unauthorized(LOGIN_TO_SHOP);
  e.details = { loginRequired: true };
  next(e);
};
export const requireAdmin = (req, _res, next) =>
  !req.user ? next(unauthorized()) : req.user.role !== 'admin' ? next(forbidden('Admins only')) : next();

/**
 * CSRF: cross-site HTML forms can only send GET/POST with form encodings, and PUT/PATCH/DELETE from another
 * origin need a CORS preflight we never grant. So every POST must be JSON. (Webhooks are signature-verified.)
 */
export function csrfGuard(req, _res, next) {
  if (req.method !== 'POST' || req.path.startsWith('/webhooks/')) return next();
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('application/json')) return next();
  next(forbidden('Bad request'));
}

/** Small in-memory rate limiter (per IP + key). */
const buckets = new Map();
/**
 * Forget all counters. Limits themselves are unchanged — this only gives each automated test a fresh window,
 * because every test request comes from the same IP (127.0.0.1). Nothing in the app calls it.
 */
export const resetRateLimits = () => buckets.clear();
export function rateLimit(key, { max = 10, windowMs = 15 * 60e3 } = {}) {
  return (req, _res, next) => {
    const id = `${key}:${req.ip}`;
    const now = Date.now();
    const b = buckets.get(id) || { n: 0, reset: now + windowMs };
    if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
    b.n++;
    buckets.set(id, b);
    if (b.n > max) {
      const e = new Error('Too many attempts — please wait a little and try again');
      e.status = 429;
      return next(e);
    }
    next();
  };
}
