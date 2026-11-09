/**
 * "One little step before the magic begins!" — where a signed-in customer waits until their email is confirmed.
 * The shop itself is locked on the server; this page only explains, resends the link (60-second cooldown, 5 a day —
 * the server decides and says how long to wait) and notices when the email has been confirmed (e.g. on a phone).
 */
import { siteConfig } from '../layout.js';
import { api, esc, qs, $ } from '../api.js';
import { charmSVG } from '../charms.js';
import { loaderHTML } from '../ui.js';

const card = $('[data-pending]');
// Same-site paths only (the server applies the same rule to the emailed link).
const next = (() => {
  const n = qs('next') || '';
  return n.length <= 300 && /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%:+,]*$/.test(n) && !/^\/(api|verify-email|verify-pending)\b/i.test(n) ? n : null;
})();
const destination = next || '/shop.html';

const ENVELOPE = `<svg class="pending-envelope" viewBox="0 0 160 120" width="160" height="120" aria-hidden="true">
  <rect x="14" y="26" width="132" height="84" rx="12" fill="#FFF8EE" stroke="#C96C80" stroke-width="3"/>
  <path d="M16 32 80 76l64-44" fill="none" stroke="#C96C80" stroke-width="3" stroke-linejoin="round"/>
  <path d="M16 106 62 66M144 106 98 66" fill="none" stroke="#D197A2" stroke-width="2.5" stroke-dasharray="4 5"/>
  <path d="M80 70c-9-6-13-11-13-15.5a6.5 6.5 0 0 1 13-1 6.5 6.5 0 0 1 13 1C93 59 89 64 80 70Z" fill="#C96C80"/>
  <g class="pending-sparkles" fill="#BCCA7D"><circle cx="20" cy="14" r="3.5"/><circle cx="146" cy="12" r="2.5"/><circle cx="152" cy="40" r="3"/></g>
</svg>`;

/** "meera.iyer@gmail.com" → "m•••r@gmail.com": enough to recognise, not enough to read over a shoulder. */
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return 'your email address';
  return `${user[0]}${user.length > 2 ? `•••${user.at(-1)}` : '•••'}@${domain}`;
}

const wait = (s) => (s >= 3600 ? `about ${Math.ceil(s / 3600)} hour${Math.ceil(s / 3600) === 1 ? '' : 's'}` : s >= 60 ? `about ${Math.ceil(s / 60)} minutes` : `${s} seconds`);

function showVerified() {
  card.innerHTML = `<div class="pending-body">${charmSVG('strawberry', { size: 96 })}
    <h1>You’re all set! 🍓</h1>
    <p class="muted">Your email is confirmed and the whole CLAYSLAY boutique is open to you.</p>
    <div class="verify-actions"><a class="btn" href="${esc(destination)}">Enter the boutique</a></div></div>`;
  setTimeout(() => location.assign(destination), 2000);
}

function showSignedOut() {
  const back = `/verify-pending.html${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  card.innerHTML = `<div class="pending-body">${ENVELOPE}
    <h1>Waiting for your confirmation?</h1>
    <p class="muted">Log in to see whether your email is confirmed or to get a fresh confirmation link.</p>
    <div class="verify-actions"><a class="btn" href="/account.html?next=${encodeURIComponent(back)}">Log in</a>
      <a class="btn btn-ghost" href="/">Back to the homepage</a></div>
    <p class="pending-help"><span aria-hidden="true">💌</span> Having trouble verifying your email? <a href="/contact.html">Contact us</a></p></div>`;
}

/** What we tell them about the link: sent already, or (accounts from before email confirmation) not yet. */
const sentMessage = (user) => `We sent a confirmation link to <b class="pending-email">${esc(maskEmail(user.email))}</b>. Tap the button in that email —
  it works on any device and expires after 24 hours.`;
const NOT_SENT_MESSAGE = 'Your account needs email confirmation. Tap below and we’ll send your link.';
const TIPS = `<li>Can’t find it? Peek in your spam or promotions folder.</li><li>It can take a minute or two to arrive.</li>`;

function showPending(user, linkSent) {
  card.innerHTML = `<div class="pending-body">${ENVELOPE}
    <span class="eyebrow">Almost there</span>
    <h1>One little step before the magic begins! 🍓</h1>
    <p class="pending-lead">Please confirm your email address to unlock the CLAYSLAY shopping experience.</p>
    <p class="muted" data-link-message>${linkSent ? sentMessage(user) : esc(NOT_SENT_MESSAGE)}</p>
    <ul class="pending-tips" data-tips ${linkSent ? '' : 'hidden'}>${TIPS}</ul>
    <div class="verify-actions">
      <button class="btn" type="button" data-resend>${linkSent ? 'Resend confirmation email' : 'Send my confirmation link'}</button>
      <button class="btn btn-ghost" type="button" data-check>I’ve confirmed — let me in</button>
    </div>
    <p class="pending-status" data-status role="status"></p>
    <p class="pending-switch muted">Not ${esc(user.name.split(' ')[0])}, or used the wrong email? <button type="button" class="link-btn" data-logout>Log out and use a different account</button></p>
    <p class="pending-help"><span aria-hidden="true">💌</span> Having trouble verifying your email? <a href="/contact.html">Contact us</a></p>
  </div>`;
  const btn = $('[data-resend]', card);
  const status = $('[data-status]', card);
  const say = (text, kind = '') => { status.textContent = text; status.className = `pending-status ${kind}`; };
  let timer = null;
  const countdown = (seconds, label) => {
    clearInterval(timer);
    let left = Math.max(1, Math.round(seconds));
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = 'Resend confirmation email'; return; }
      btn.textContent = `${label} (${left}s)`;
      left -= 1;
    };
    tick();
    timer = setInterval(tick, 1000);
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    say('Sending a fresh link…');
    try {
      const r = await api('/auth/verify-email/resend', { method: 'POST', body: next ? { next } : {} });
      if (r.alreadyVerified) { showVerified(); return; }
      say('A fresh link is on its way! 💌 Use the newest email — it can take a minute or two to arrive.', 'ok');
      $('[data-link-message]', card).innerHTML = sentMessage(user); // a link exists now
      $('[data-tips]', card).hidden = false;
      countdown(60, 'Sent');
    } catch (e) {
      if (e.status === 429 && e.details?.cooldown) {
        say(e.message, 'wait');
        countdown(e.details.retryAfter || 60, 'Resend');
      } else if (e.status === 429 && e.details?.dailyLimit) {
        say(`${e.message} (You can ask again in ${wait(e.details.retryAfter || 86400)}.)`, 'wait');
        btn.textContent = 'Daily limit reached';
      } else {
        say(e.message, 'error');
        btn.disabled = false;
      }
    }
  });
  $('[data-check]', card).addEventListener('click', async (e) => {
    e.currentTarget.classList.add('is-loading');
    if (!(await recheck())) {
      e.currentTarget.classList.remove('is-loading');
      say('Not confirmed yet — please tap the button in the email we sent you.', 'wait');
    }
  });
  $('[data-logout]', card).addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    location.href = '/account.html';
  });
}

/** Ask the server (not the page) whether the email is confirmed now — e.g. after tapping the link on a phone. */
async function recheck() {
  try {
    const { user } = await api('/config');
    if (user && (user.emailVerified || user.role === 'admin')) { showVerified(); return true; }
  } catch { /* offline for a moment — try again later */ }
  return false;
}

async function init() {
  card.innerHTML = loaderHTML('Checking your account…');
  const { user } = await siteConfig;
  if (!user) return showSignedOut();
  if (user.emailVerified || user.role === 'admin') return showVerified();
  // Ask (read-only) whether a link was ever sent — never send one just because the page was opened or refreshed.
  let status = { linkSent: false };
  try { status = await api('/auth/verify-email/status'); } catch { /* unknown → neutral "tap below" message; the button works either way */ }
  if (status.emailVerified) return showVerified();
  showPending(user, status.linkSent);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });
}

init();
