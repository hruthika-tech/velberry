import { siteConfig, resendVerifyLink } from '../layout.js';
import { api, esc, qs, $ } from '../api.js';
import { charmSVG } from '../charms.js';
import { loaderHTML } from '../ui.js';

const card = $('[data-verify]');
const token = qs('token');
// Keep the one-time token out of the address bar, history and bookmarks once we've read it.
if (token) history.replaceState(null, '', '/verify-email.html');

const done = (title, text) => `<div class="empty-state">${charmSVG('heart', { size: 80 })}<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
  <div class="verify-actions"><a class="btn" href="/shop.html">Explore the Collection</a><a class="btn btn-ghost" href="/account.html">My account</a></div></div>`;

function problem(message, user) {
  const action = user
    ? '<button class="btn" type="button" data-resend>Send me a new link</button>'
    : '<a class="btn" href="/account.html?next=%2Fverify-email.html">Log in to get a new link</a>';
  card.innerHTML = `<div class="empty-state">${charmSVG('bow', { size: 80 })}<h2>Hmm, that didn't work</h2>
    <p class="muted">${esc(message)}</p><div class="verify-actions">${action}</div></div>`;
  card.querySelector('[data-resend]')?.addEventListener('click', (e) => resendVerifyLink(e.currentTarget));
}

async function init() {
  card.innerHTML = loaderHTML('Checking your link…');
  const { user } = await siteConfig;
  if (!token) {
    if (user?.emailVerified) { card.innerHTML = done('Your email is confirmed', 'Thank you — you’re all set.'); return; }
    if (user) {
      card.innerHTML = `<div class="empty-state">${charmSVG('teacup', { size: 80 })}<h2>Check your inbox</h2>
        <p class="muted">We sent a confirmation link to <b>${esc(user.email)}</b>. It can take a minute or two — have a peek in the spam folder too.</p>
        <div class="verify-actions"><button class="btn" type="button" data-resend>Send a new link</button></div></div>`;
      card.querySelector('[data-resend]').addEventListener('click', (e) => resendVerifyLink(e.currentTarget));
      return;
    }
    problem('This page needs the link from your confirmation email.', null);
    return;
  }
  try {
    await api('/auth/verify-email', { method: 'POST', body: { token } });
    card.innerHTML = done('Your email is confirmed ✿', 'Thank you! We’ll use it to keep you posted about your orders.');
  } catch (e) {
    if (user?.emailVerified) { card.innerHTML = done('Your email is already confirmed', 'Nothing more to do — happy shopping!'); return; }
    problem(e.message, user);
  }
}

init();
