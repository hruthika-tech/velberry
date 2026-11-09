/**
 * Email verification for customer accounts.
 *
 *  • At sign-up (and on request) a random token is emailed as a link to /verify-email.html?token=…
 *    Only its sha256 is stored, the link works once, and it expires after LINK_HOURS.
 *  • Opening the link marks the account verified and only then links past guest orders placed with that email.
 *    It does not need the customer to be logged in on that device — holding the token proves they can read that inbox.
 *  • New links: at most one a minute and DAILY_LIMIT per account in any rolling 24 hours.
 *  • Verification never blocks logging in or shopping; the site reminds unverified customers instead.
 *  • Sending runs after the response (like order emails) and is recorded in `notifications` (no order attached),
 *    so a failed send is visible in Admin → Emails and in the server log — never silently lost.
 */
import { one, run, tx, detached } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/auth.js';
import { HttpError, bad } from '../lib/errors.js';
import { renderVerifyEmail } from './email-templates.js';
import { sendViaResend, NOT_SENT } from './notifications.js';
import { runInBackground } from '../lib/background.js';

export const LINK_HOURS = 24;
export const RESEND_COOLDOWN_SECONDS = 60;
export const DAILY_LIMIT = 5; // links per account in any rolling 24 hours (the sign-up email counts)
export const INVALID_LINK = 'This confirmation link has expired or was already used — you can ask for a new one from your account';
export const TOO_SOON = 'We just sent you a link — please check your inbox (and spam folder), or try again in a minute';
export const DAILY_LIMIT_REACHED = "We've sent several confirmation links today — please use the newest email from CLAYSLAY, or try again tomorrow";

/**
 * Where to send the customer after confirming: a path on this site only (never "//other.site", "/\other", a full
 * URL, an API route or the verification pages themselves). Anything else → null (the page picks a default).
 */
export function safeNext(next) {
  const n = String(next ?? '');
  if (!n || n.length > 300 || !/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%:+,]*$/.test(n)) return null;
  if (/^\/(api|verify-email|verify-pending)\b/i.test(n)) return null;
  return n;
}

/** Store a new link for this user (only its hash) and return the raw link. Runs inside the caller's transaction, if any. */
async function createLink(userId, next) {
  const token = randomToken(32);
  const { id } = await run(`INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES (?, ?, now() + ?::interval)`,
    sha256(token), userId, `${LINK_HOURS} hours`);
  const after = safeNext(next);
  return { id, link: `${config.appUrl}/verify-email.html?token=${encodeURIComponent(token)}${after ? `&next=${encodeURIComponent(after)}` : ''}` };
}

/** Email the link after the response, outside any transaction (so it is only sent for a link that was committed). */
const sendInBackground = (user, { link, id }) =>
  detached(() => runInBackground(new Promise((r) => setImmediate(r)).then(() => sendVerification(user, link, id))));

/** Create a link for this user and send it in the background. user = { id, email, name } */
export async function issueVerification(user, { next } = {}) {
  sendInBackground(user, await createLink(user.id, next));
}

async function sendVerification(user, link, verificationId) {
  const { subject, html } = renderVerifyEmail({ name: user.name, link, appUrl: config.appUrl, hours: LINK_HOURS });
  const rowId = (await run("INSERT INTO notifications(order_id, type, recipient, subject, status) VALUES (NULL, 'verify_email', ?, ?, 'pending')",
    user.email, subject)).id;

  if (!config.email.resendKey) {
    console.log('[email] not sent (RESEND_API_KEY not set): verify_email');
    // On your own computer there is no inbox to click — print the link so sign-up can be tested end to end.
    if (!config.isProd) console.log(`[email] local verification link: ${link}`);
    await run("UPDATE notifications SET status = 'logged', error = ? WHERE id = ?", NOT_SENT, rowId);
    return;
  }
  try {
    const providerId = await sendViaResend({ to: user.email, subject, html, idempotencyKey: `verify-email-${verificationId}` });
    await run("UPDATE notifications SET status = 'sent', provider_id = ? WHERE id = ?", providerId, rowId);
  } catch (e) {
    console.error('[email] verify_email failed:', e.message); // Resend's reason only — no address, no link
    await run("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?", e.message, rowId);
  }
}

/**
 * Mark the account behind this token verified, and only then give it the past guest orders placed with that email.
 * One transaction: either the link is used up AND the orders are linked, or nothing changes.
 * Single use: every link for that account stops working.
 *
 * Concurrency: the account row is locked FIRST, so every confirmation for one account runs one after another
 * (two links opened at once can't deadlock, and the same link opened twice succeeds exactly once). The token is
 * then re-read under that lock — a link used up by the request that went first is refused.
 */
export async function confirmVerification(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) throw bad(INVALID_LINK);
  const hash = sha256(t);
  const found = await one('SELECT user_id FROM email_verifications WHERE token_hash = ?', hash);
  if (!found) throw bad(INVALID_LINK);
  await tx(async () => {
    const user = await one('SELECT id, email FROM users WHERE id = ? FOR UPDATE', found.user_id);
    const v = await one('SELECT expires_at > now() AS live FROM email_verifications WHERE token_hash = ? AND user_id = ?', hash, found.user_id);
    if (!user || !v?.live) throw bad(INVALID_LINK);
    await run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = ?', user.id);
    // Guest orders only — an order that already belongs to an account (this one or any other) is never moved.
    await run('UPDATE orders SET user_id = ? WHERE user_id IS NULL AND lower(customer_email) = lower(?)', user.id, user.email);
    await run('DELETE FROM email_verifications WHERE user_id = ?', user.id);
  });
}

/**
 * For the "confirm your email" page: is the email confirmed, and has a link ever been issued for this account?
 * Accounts created before email confirmation existed have never been sent one. Read-only — never sends anything.
 */
export async function verificationStatus(userId) {
  const u = await one('SELECT email_verified_at FROM users WHERE id = ?', userId);
  const link = await one('SELECT 1 AS yes FROM email_verifications WHERE user_id = ? LIMIT 1', userId);
  return { emailVerified: Boolean(u?.email_verified_at), linkSent: Boolean(link) };
}

/**
 * "Send me a new link" for the signed-in customer: at most one a minute, and DAILY_LIMIT in any rolling 24 hours.
 * The account row is locked while checking and recording, so simultaneous requests are counted one after another
 * and can't slip past either limit. The email is sent only after the new link is committed.
 */
export async function resendVerification(userId, { next } = {}) {
  const out = await tx(async () => {
    const u = await one('SELECT id, email, name, email_verified_at FROM users WHERE id = ? FOR UPDATE', userId);
    if (u.email_verified_at) return { alreadyVerified: true };
    // retryAfter (seconds) lets the page count down; it reveals nothing beyond this customer's own sending history.
    const c = await one(`SELECT count(*)::int AS n,
        COALESCE(bool_or(created_at > clock_timestamp() - ?::interval), false) AS recent,
        CEIL(EXTRACT(EPOCH FROM (max(created_at) + ?::interval - clock_timestamp())))::int AS cooldown_left,
        CEIL(EXTRACT(EPOCH FROM (min(created_at) + interval '24 hours' - clock_timestamp())))::int AS window_left
      FROM email_verifications WHERE user_id = ? AND created_at > clock_timestamp() - interval '24 hours'`,
    `${RESEND_COOLDOWN_SECONDS} seconds`, `${RESEND_COOLDOWN_SECONDS} seconds`, u.id);
    if (c.recent) throw new HttpError(429, TOO_SOON, { cooldown: true, retryAfter: Math.max(1, c.cooldown_left || RESEND_COOLDOWN_SECONDS) });
    if (c.n >= DAILY_LIMIT) throw new HttpError(429, DAILY_LIMIT_REACHED, { dailyLimit: true, retryAfter: Math.max(60, c.window_left || 86400) });
    return { user: u, created: await createLink(u.id, next) };
  });
  if (out.alreadyVerified) return out;
  sendInBackground(out.user, out.created);
  return { sent: true };
}
