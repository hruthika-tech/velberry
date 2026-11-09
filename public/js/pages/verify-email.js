import { siteConfig, resendVerifyLink } from '../layout.js';
import { api, esc, qs, $ } from '../api.js';
import { charmSVG } from '../charms.js';
import { loaderHTML } from '../ui.js';

const card = $('[data-verify]');
const token = qs('token');
// Where to go once confirmed: a path on this site only (same rule as the server), else the boutique.
const next = (() => {
  const n = qs('next') || '';
  return n.length <= 300 && /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%:+,]*$/.test(n) && !/^\/(api|verify-email|verify-pending)\b/i.test(n) ? n : '/shop.html';
})();
// Keep the one-time token out of the address bar, history and bookmarks once we've read it.
if (token) history.replaceState(null, '', '/verify-email.html');

const done = (title, text) => `<div class="empty-state">${charmSVG('heart', { size: 80 })}<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
  <div class="verify-actions"><a class="btn" href="${esc(next)}" data-continue>Enter the boutique</a><a class="btn btn-ghost" href="/account.html">My account</a></div></div>`;
/** Confirmed → carry on to where they were heading, after a moment to enjoy the good news. */
const carryOn = () => setTimeout(() => location.assign(next), 2500);

function problem(message, user) {
  const action = user
    ? '<button class="btn" type="button" data-resend>Send me a new link</button>'
    : '<a class="btn" href="/account.html?next=%2Fverify-pending.html">Log in to get a new link</a>';
  card.innerHTML = `<div class="empty-state">${charmSVG('bow', { size: 80 })}<h2>Hmm, that didn't work</h2>
    <p class="muted">${esc(message)}</p><div class="verify-actions">${action}</div></div>`;
  card.querySelector('[data-resend]')?.addEventListener('click', (e) => resendVerifyLink(e.currentTarget));
}

async function init() {
  card.innerHTML = loaderHTML('Checking your link…');
  const { user } = await siteConfig;
  if (!token) {
    if (user?.emailVerified) { card.innerHTML = done('Your email is confirmed', 'Thank you — you’re all set.'); return; }
    if (user) { location.replace('/verify-pending.html'); return; } // waiting for the email → the dedicated page
    problem('This page needs the link from your confirmation email.', null);
    return;
  }
  try {
    await api('/auth/verify-email', { method: 'POST', body: { token } });
    card.innerHTML = done('Your email is confirmed ✿', 'Yay! The CLAYSLAY boutique is all yours — taking you there now…');
    carryOn();
  } catch (e) {
    if (user?.emailVerified) { card.innerHTML = done('Your email is already confirmed', 'Nothing more to do — happy shopping!'); return; }
    problem(e.message, user);
  }
}

init();
