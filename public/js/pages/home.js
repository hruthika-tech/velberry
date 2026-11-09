import { siteConfig } from '../layout.js';
import { api, money, esc, reducedMotion, $, $$ } from '../api.js';

/*
 * The homepage is public. Its charms come from /api/home — a teaser with display fields only — because the full
 * catalogue is for customers with a confirmed email. Confirmed customers' links open the real product pages; everyone
 * else's open each charm's public share page (collections stay behind the login + confirmation gate).
 */
const teaser = api('/home');
const canShop = siteConfig.then(({ user }) => Boolean(user && (user.emailVerified || user.role === 'admin'))).catch(() => false);
const linkFor = (shop) => (p) => (shop ? `/p/${p.slug}` : `/share/product/${p.slug}`);
import { CHARMS, charmSVG } from '../charms.js';
import { productCard, bindQuickAdd, loaderHTML, toastError } from '../ui.js';
import { createModelViewer, FrameSpinner } from '../spin360.js';
import { afterCurtain } from '../curtain.js';

/* ═════════════ floating decorations ═════════════ */
(function floaters() {
  const host = $('.hero-floaters');
  if (!host || reducedMotion()) return;
  const items = ['heart', 'butterfly', 'star', 'strawberry', 'daisy', 'heart', 'cherries', 'bow'];
  host.innerHTML = items.map((n, i) => {
    const left = (i * 13 + 4) % 96;
    const top = 12 + ((i * 29) % 70);
    const size = 18 + ((i * 7) % 16);
    return `<span class="floater" style="left:${left}%;top:${top}%;animation-duration:${9 + (i % 4) * 3}s;animation-delay:${-i * 1.7}s">${charmSVG(n, { size })}</span>`;
  }).join('');
})();

/* ═════════════ gift box hero ═════════════ */
const TREASURES = [
  { charm: 'strawberry', label: 'Strawberries', href: '/collection/strawberry' },
  { charm: 'macaron', label: 'Sweet treats', href: '/collection/sweet-treats' },
  { charm: 'bunny', label: 'Animal friends', href: '/collection/animal-friends' },
  { charm: 'daisy', label: 'Floral charms', href: '/collection/floral' },
  { charm: 'shell', label: 'Ocean', href: '/collection/ocean' },
  { charm: 'bow', label: 'Little bows', href: '/collection/mini-accessories' },
];

function miniKeychain(name) {
  const c = CHARMS[name];
  const sc = 0.92;
  const top = 44 - c.hook * sc;
  return `<svg viewBox="0 0 100 160" aria-hidden="true">
    <circle cx="50" cy="13" r="10.5" fill="none" stroke="#C9A15C" stroke-width="3.2"/>
    <path d="M42 8 A10.5 10.5 0 0 1 56 4" fill="none" stroke="#F4E2B6" stroke-width="1.4" stroke-linecap="round"/>
    <ellipse cx="50" cy="28" rx="3" ry="4.6" fill="none" stroke="#C9A15C" stroke-width="2"/>
    <ellipse cx="50" cy="35.5" rx="1.4" ry="4.6" fill="none" stroke="#C9A15C" stroke-width="2"/>
    <circle cx="50" cy="42" r="3.3" fill="none" stroke="#C9A15C" stroke-width="2"/>
    <g transform="translate(${50 - 50 * sc} ${top}) scale(${sc})">${c.svg}</g></svg>`;
}

function initGiftBox() {
  const stage = $('.gift-stage');
  const treasures = $('.gb-treasures', stage);
  $('.gb-bow', stage).innerHTML = `<svg viewBox="6 24 88 72" preserveAspectRatio="xMidYMax meet" aria-hidden="true">${CHARMS.bow.svg}</svg>`;
  treasures.innerHTML = TREASURES.map((t, i) => `<a class="treasure" href="${t.href}" style="--i:${i}" aria-label="${t.label}">
      <span class="t-float">${miniKeychain(t.charm)}</span><span class="t-label">${t.label}</span></a>`).join('');
  $('.gift-sparkles', stage).innerHTML = Array.from({ length: 12 }, (_, i) =>
    `<i style="left:${(i * 37) % 92 + 3}%;top:${(i * 23) % 52 + 2}%;--d:${(i * 0.37).toFixed(2)}s;--s:${12 + (i % 4) * 6}px">${i % 3 ? '✦' : '✧'}</i>`).join('');

  const layout = () => {
    const W = stage.clientWidth;
    const n = TREASURES.length;
    $$('.treasure', stage).forEach((el, i) => {
      const a = ((-58 + (116 * i) / (n - 1)) * Math.PI) / 180;
      const R = W * 0.33;
      el.style.setProperty('--tx', `${(Math.sin(a) * R * 1.22).toFixed(1)}px`);
      el.style.setProperty('--ty', `${(-(Math.cos(a) * R) - W * 0.09).toFixed(1)}px`);
      el.style.setProperty('--rot', `${(a * 180 / Math.PI * 0.28).toFixed(1)}deg`);
    });
  };
  layout();
  new ResizeObserver(layout).observe(stage);

  const replay = $('.replay-btn', stage);
  let timers = [];
  const play = () => {
    timers.forEach(clearTimeout);
    timers = [];
    stage.className = 'gift-stage';
    if (reducedMotion()) { stage.dataset.state = 'open'; stage.classList.add('is-settled'); replay.hidden = true; return; }
    stage.dataset.state = 'closed';
    void stage.offsetWidth;
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    at(60, () => { stage.dataset.state = 'dropping'; stage.classList.add('is-dropping'); });
    at(900, () => stage.classList.add('is-untying'));
    at(1450, () => { stage.classList.add('is-open'); stage.dataset.state = 'open'; });
    at(1450 + 350 + 110 * TREASURES.length + 900, () => {
      stage.classList.remove('is-dropping', 'is-untying', 'is-open');
      stage.classList.add('is-settled');
      replay.hidden = false;
    });
  };
  replay.addEventListener('click', play);
  afterCurtain(play); // plays as soon as the page is visible (straight away when there is no Today's Special curtain)
}
initGiftBox();

/* ═════════════ featured products ═════════════ */
(async function featured() {
  const host = $('[data-featured]');
  host.innerHTML = loaderHTML('Arranging the display case…');
  try {
    const [{ featured: products }, shop] = await Promise.all([teaser, canShop]);
    host.innerHTML = products.map((p) => productCard(p, { link: linkFor(shop) })).join('');
    bindQuickAdd(host, new Map(products.map((p) => [p.id, p])));
  } catch (e) {
    host.innerHTML = `<p class="notice error">We couldn't load the charms right now. Please refresh in a moment.</p>`;
  }
})();

/* ═════════════ 360 showcase ═════════════ */
(async function showcase() {
  const stage = $('.showcase-stage');
  const host = $('[data-viewer]');
  const buy = $('[data-showcase-buy]');
  let product = null;
  let shop = false;
  try { [{ showcase: product }, shop] = await Promise.all([teaser, canShop]); } catch { /* teaser unavailable */ }

  if (product) {
    buy.innerHTML = `<span class="price">${money(Math.min(product.price, ...product.variants.map((v) => v.price)))}</span>
      <a class="btn" href="${esc(linkFor(shop)(product))}"><span class="heart">♥</span> ${product.variants.length ? 'Choose your berry' : 'Add to Bag'}</a>
      <span class="stock ${product.availability.status}">${esc(product.availability.label)}</span>`;
  } else {
    buy.innerHTML = '<a class="btn" href="/shop.html">Browse the boutique</a>';
  }

  let viewer = null;
  const start = async () => {
    if (product?.angleImages?.length >= 8) {
      viewer = new FrameSpinner(host, product.angleImages.map((i) => i.url), { alt: product.name });
    } else {
      viewer = await createModelViewer(host, { model: 'strawberry' });
      if (!viewer) {
        host.innerHTML = product?.image ? `<img class="stage-fallback" src="${esc(product.image)}" alt="${esc(product.name)}">` : '';
        $('.stage-hint').hidden = true;
        $('.stage-angles').hidden = true;
      }
    }
  };
  // Only load the 3D engine when the section approaches the viewport
  const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); start(); } }, { rootMargin: '300px' });
  io.observe(host);

  host.addEventListener('pointerdown', () => stage.classList.add('touched'), { once: true });
  $('.stage-angles').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !viewer) return;
    $$('.stage-angles button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    viewer.goTo(Number(b.dataset.angle), Number(b.dataset.tilt));
    stage.classList.add('touched');
  });
})();

/* ═════════════ our little menu ═════════════ */
(async function menu() {
  const host = $('[data-menu]');
  try {
    const [{ categories: cats }, shop] = await Promise.all([teaser, canShop]);
    const productLink = linkFor(shop);
    host.innerHTML = cats.map((c) => `<div class="menu-item">
      <div class="menu-icon">${charmSVG(c.icon, { size: 40 })}</div>
      <div>
        <div class="menu-line"><h3><a href="/collection/${esc(c.slug)}">${esc(c.name)}</a></h3><span class="menu-dots"></span>
          <span class="menu-price">${c.fromPrice != null ? `from ${money(c.fromPrice)}` : ''}</span></div>
        <p class="menu-desc">${esc(c.description || '')}</p>
        <div class="menu-previews">
          ${c.previews.map((p) => `<a href="${esc(productLink(p))}" title="${esc(p.name)}"><img src="${esc(p.image || '')}" alt="${esc(p.name)}" loading="lazy" width="46" height="46"></a>`).join('')}
          <a class="menu-cta" href="/collection/${esc(c.slug)}" aria-label="View ${esc(c.name)}" title="View ${esc(c.name)}"><span aria-hidden="true">→</span></a>
        </div>
      </div></div>`).join('');
  } catch (e) { toastError(e); }
})();

/* polaroid art */
$$('.pol-art').forEach((el) => { el.innerHTML = charmSVG(el.dataset.charm, { size: 120 }); });
