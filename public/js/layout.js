/**
 * Shared page chrome: header (nav + bag), footer, decorative chains.
 * Pages opt in via <body data-page="…" data-chain="hero|slim|none" data-dock="on|off">.
 */
import { api, esc } from './api.js';
import { cart, resumePendingAdd, toast, toastError } from './ui.js';
import { mountChain, mountDockChain } from './chain.js';
import { SITE } from './site-info.js';

const BAG_ICON = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M7 11h18l-1.4 15.2a2 2 0 0 1-2 1.8H10.4a2 2 0 0 1-2-1.8Z"/><path d="M11.5 11V9a4.5 4.5 0 0 1 9 0v2"/>
  <path d="M16 22.5c-2.6-1.7-3.6-3-3.6-4.3 0-1.1.9-1.9 1.9-1.9.7 0 1.3.4 1.7 1 .4-.6 1-1 1.7-1 1 0 1.9.8 1.9 1.9 0 1.3-1 2.6-3.6 4.3Z" fill="currentColor" stroke="none" opacity=".8"/></svg>`;
const USER_ICON = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="16" cy="11.5" r="5"/><path d="M6.5 27c1.2-5 5-7.5 9.5-7.5s8.3 2.5 9.5 7.5"/></svg>`;
const MENU_ICON = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 10h18M7 16h18M7 22h12"/></svg>`;

export const siteConfig = api('/config').catch(() => ({ user: null, paymentMode: 'disabled' }));

function header(page) {
  const link = (href, label, key) => `<a href="${href}"${page === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap header-inner">
      <a class="logo" href="/" aria-label="CLAYSLAY home"><span class="logo-word">CLAYSLAY</span><span class="logo-sub">handmade clay charms</span></a>
      <nav class="nav" id="site-nav" aria-label="Main">
        ${link('/shop.html', 'The Boutique', 'shop')}
        ${link('/#menu', 'Our Little Menu', 'menu')}
        ${link('/track.html', 'Track Order', 'track')}
        ${link('/account.html', 'My Account', 'account')}
      </nav>
      <div class="header-actions">
        <a class="icon-btn" href="/account.html" data-account-link aria-label="My account">${USER_ICON}</a>
        <a class="icon-btn" href="/cart.html" data-bag-link aria-label="Shopping bag">${BAG_ICON}<span class="bag-count" data-bag-count>0</span></a>
        <button class="icon-btn menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false" aria-label="Open menu">${MENU_ICON}</button>
      </div>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="site-footer scallop-top">
    <div class="wrap">
      <div class="footer-grid">
        <div>
          <div class="footer-logo">CLAYSLAY</div>
          <p class="footer-note">Tiny clay treasures, shaped by hand and baked with love in our little studio in India.</p>
        </div>
        <div><h4>Shop</h4><ul>
          <li><a href="/shop.html">All charms</a></li><li><a href="/#menu">Our little menu</a></li>
          <li><a href="/collection/strawberry">Strawberry collection</a></li><li><a href="/collection/sweet-treats">Sweet treats</a></li></ul></div>
        <div><h4>Help</h4><ul>
          <li><a href="/track.html">Track my order</a></li><li><a href="/account.html">My account</a></li>
          <li><a href="/shipping.html">Shipping &amp; returns</a></li><li><a href="/care.html">Charm care</a></li></ul></div>
        <div><h4>Say hello</h4><ul>
          <li><a href="/contact.html">Contact us</a></li>
          ${SITE.contactEmail ? `<li><a href="mailto:${esc(SITE.contactEmail)}">${esc(SITE.contactEmail)}</a></li>` : ''}
          ${SITE.instagram ? `<li><a href="${esc(SITE.instagram)}" rel="noopener">Instagram</a></li>` : ''}
          <li><a href="/privacy.html">Privacy policy</a></li><li><a href="/terms.html">Terms &amp; conditions</a></li></ul></div>
      </div>
      <div class="footer-base"><span>© ${new Date().getFullYear()} CLAYSLAY · Made by hand, packed with love</span><span>Secure payments by Razorpay · UPI · Cards · Netbanking</span></div>
    </div>
  </footer>`;
}

/** Gentle reminder under the header until the customer confirms their email (hidden for this visit on ×). */
const HIDE_KEY = 'clayslay-verify-hidden';
export async function resendVerifyLink(btn) {
  btn.disabled = true;
  try {
    const r = await api('/auth/verify-email/resend', { method: 'POST', body: {} });
    if (r.alreadyVerified) { location.reload(); return; }
    toast({ title: 'Link sent!', text: 'Check your inbox (and the spam folder) for an email from CLAYSLAY.', icon: 'heart' });
  } catch (e) { toastError(e); } finally { btn.disabled = false; }
}
function showVerifyReminder(user) {
  try { if (sessionStorage.getItem(HIDE_KEY)) return; } catch { /* storage blocked: just show it */ }
  const bar = document.createElement('div');
  bar.className = 'verify-reminder';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<div class="wrap verify-reminder-inner">
    <p><b>Please confirm your email.</b> We sent a link to <span class="verify-email-addr">${esc(user.email)}</span> — check your inbox or spam folder.</p>
    <button type="button" class="link-btn" data-verify-resend>Send a new link</button>
    <button type="button" class="verify-close" data-verify-hide aria-label="Hide this reminder">×</button></div>`;
  document.querySelector('.site-header').after(bar);
  bar.querySelector('[data-verify-resend]').addEventListener('click', (e) => resendVerifyLink(e.currentTarget));
  bar.querySelector('[data-verify-hide]').addEventListener('click', () => {
    bar.remove();
    try { sessionStorage.setItem(HIDE_KEY, '1'); } catch { /* fine */ }
  });
}

export function initLayout() {
  const body = document.body;
  const page = body.dataset.page;
  body.insertAdjacentHTML('afterbegin', header(page));
  if (body.dataset.footer !== 'off') body.insertAdjacentHTML('beforeend', footer());

  // decorative top chain under the header
  const chainMode = body.dataset.chain || 'slim';
  if (chainMode !== 'none') {
    const holder = document.createElement('div');
    holder.className = `top-chain ${chainMode === 'slim' ? 'slim' : ''}`;
    const main = document.getElementById('main');
    main?.parentNode.insertBefore(holder, main);
    const small = matchMedia('(max-width: 640px)').matches;
    mountChain(holder, chainMode === 'hero'
      ? { charms: ['strawberry', 'pearl', 'butterfly', 'bow', 'key', 'daisy', 'pearl', 'heart', 'cherries', 'star', 'macaron', 'pearl'], swagWidth: small ? 360 : 560, sag: small ? 18 : 30, top: 8, charmSize: small ? 32 : 44, dropLinks: 2, spacing: small ? 64 : 104 }
      : { charms: ['strawberry', 'pearl', 'bow', 'daisy', 'pearl', 'heart', 'star', 'pearl', 'butterfly'], swagWidth: small ? 300 : 460, sag: small ? 8 : 12, top: 6, charmSize: small ? 22 : 28, dropLinks: 1, spacing: small ? 58 : 86 });
    holder.style.marginBottom = chainMode === 'hero' ? (small ? '-92px' : '-120px') : (small ? '-54px' : '-70px');
  }
  if (body.dataset.dock === 'on') mountDockChain();

  // mobile nav
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); } });

  // bag count
  const badge = document.querySelector('[data-bag-count]');
  document.addEventListener('cart:change', (e) => {
    const n = e.detail?.count || 0;
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('has-items', n > 0);
    document.querySelector('[data-bag-link]').setAttribute('aria-label', `Shopping bag, ${n} item${n === 1 ? '' : 's'}`);
  });
  const bagLoaded = cart.load().catch(() => {});

  siteConfig.then(async (c) => {
    if (!c.user) return;
    document.querySelector('[data-account-link]').setAttribute('aria-label', `My account (${c.user.name})`);
    if (!c.user.emailVerified && c.user.role !== 'admin' && page !== 'verify-email') showVerifyReminder(c.user);
    await bagLoaded;
    resumePendingAdd(); // back from logging in: add the charm they picked before signing in
  });
}

initLayout();
