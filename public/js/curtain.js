/**
 * Velberry — Today's Special: the floral French curtain introduction.
 *
 * On the homepage (when /js/curtain-boot.js decided this visitor should see it), the closed curtains and the
 * Today's Special board are shown above the page. "Open the Boutique", a tap on the board, the × or Esc draws
 * the curtains and reveals the untouched homepage. The three products come from GET /api/todays-special
 * (chosen in Admin → Today's Special) — nothing here is hard-coded.
 *
 * Exports for the admin studio: boardHTML() for the inline preview, previewCurtain() for the full preview.
 * Exports for the homepage: afterCurtain(fn) — runs fn once the page is revealed (or right away if no curtain).
 */
import { api, money, esc, reducedMotion, $, $$ } from './api.js';
import { CHARMS } from './charms.js';

const SEEN = 'vb-special-seen';
const HINT = 'vb-special-hint';
const PERIOD = { day: 864e5, week: 7 * 864e5 };
const safely = (fn) => { try { return fn(); } catch { return undefined; } };

let resolveReveal;
const revealed = new Promise((r) => { resolveReveal = r; });
/** Run fn when the homepage becomes visible (immediately if there is no curtain). */
export const afterCurtain = (fn) => { revealed.then(fn); };

/* ───────── little illustrations ───────── */
const BOW = `<svg viewBox="6 24 88 72" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${CHARMS.bow.svg}</svg>`;
const SPRIG = `<svg viewBox="0 0 46 46" aria-hidden="true"><path d="M4 40C10 26 20 14 40 6" fill="none" stroke="#BCCA7D" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M14 27c-5-1-8 1-9 4 4 1 7 0 9-4z" fill="#BCCA7D"/><path d="M22 18c0-5-3-7-6-7 0 4 2 6 6 7z" fill="#A9B96A"/>
  <circle cx="8" cy="38" r="5" fill="#C96C80"/><path d="M5.6 37.4c1.4-2 4.2-1.8 4.9.4" stroke="#F6E3E6" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <g fill="#D197A2"><circle cx="31" cy="11" r="2"/><circle cx="34.5" cy="13" r="2"/><circle cx="33.5" cy="16.8" r="2"/><circle cx="29.4" cy="16.6" r="2"/><circle cx="28.4" cy="12.8" r="2"/></g>
  <circle cx="31.6" cy="14" r="1.3" fill="#FBEFD5"/><path d="M40 6c3-1 4 1 3 3" fill="none" stroke="#D197A2" stroke-width="1.2" stroke-linecap="round"/></svg>`;

function itemHTML(p, i) {
  const soldOut = p.availability?.status === 'sold_out';
  return `<li class="vbc-item">
    <span class="vbc-num" aria-hidden="true">${i + 1}</span>
    <div class="vbc-frame">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.imageAlt || p.name)}" width="600" height="600" decoding="async">` : ''}
      ${soldOut ? '<span class="vbc-soldout">sold out</span>' : ''}</div>
    <h3 class="vbc-name">${esc(p.name)}</h3>
    <span class="vbc-price">${p.fromPrice ? 'from ' : ''}${money(p.price)}${p.comparePrice > p.price ? `<s>${money(p.comparePrice)}</s>` : ''}</span>
    <p class="vbc-desc">${esc(p.shortDesc || '')}</p>
    <a class="btn btn-ghost btn-sm vbc-view" href="/p/${esc(p.slug)}" data-vbc-view>View Treasure</a>
  </li>`;
}

/** The Today's Special board (also used as the live preview in the admin studio). */
export function boardHTML(products, { titleId = 'vbc-title' } = {}) {
  const n = products.length;
  const twinkles = [[6, 30, 13, 0], [93, 22, 11, 0.8], [4, 74, 10, 1.5], [95, 70, 14, 0.4], [50, 96, 10, 1.1]]
    .map(([x, y, s, d]) => `<i class="vbc-twinkle" aria-hidden="true" style="left:${x}%;top:${y}%;--s:${s}px;--d:${d}s">✦</i>`).join('');
  const hearts = [[16, 13], [84, 13], [9, 50], [91, 48]].map(([x, y]) => `<i class="vbc-heart" aria-hidden="true" style="left:${x}%;top:${y}%">♥</i>`).join('');
  return `<div class="vbc-hang"><div class="vbc-board" data-vbc-board>
      <span class="vbc-gingham" aria-hidden="true"></span><span class="vbc-bow">${BOW}</span>
      <span class="vbc-corner tl">${SPRIG}</span><span class="vbc-corner tr">${SPRIG}</span><span class="vbc-corner bl">${SPRIG}</span><span class="vbc-corner br">${SPRIG}</span>
      ${twinkles}${hearts}
      <span class="vbc-maison">Maison Velberry</span>
      <h2 class="vbc-title" id="${titleId}">TODAY'S SPECIAL</h2>
      <div class="vbc-divider" aria-hidden="true"><span>♥✦♥</span></div>
      <p class="vbc-sub">${n === 3 ? 'Three little treasures, specially chosen for you.' : 'Little treasures, specially chosen for you.'}</p>
      <ol class="vbc-items" style="--n:${Math.max(n, 1)}">${products.map(itemHTML).join('')}</ol>
      <div class="vbc-cta"><button class="btn" type="button" data-vbc-open><span class="heart">♥</span> Open the Boutique</button>
        <span class="vbc-hint">or tap the board</span></div>
    </div></div>`;
}

function overlayHTML(products) {
  const small = matchMedia('(max-width: 640px)').matches;
  const bows = Array.from({ length: small ? 3 : 6 }, () => BOW).join('');
  const panel = (side) => `<div class="vbc-panel ${side}" aria-hidden="true"><div class="vbc-fabric"></div><div class="vbc-hem"></div><span class="vbc-tie">${BOW}</span></div>`;
  return `<div class="vbc-stage-light" aria-hidden="true"></div>${panel('l')}${panel('r')}
    <div class="vbc-top" aria-hidden="true"><div class="vbc-valance"><div class="vbc-valance-bows">${bows}</div></div><div class="vbc-rod"></div></div>
    <button class="vbc-close" type="button" data-vbc-open aria-label="Skip and open the boutique">×</button>
    ${boardHTML(products)}`;
}

/* ───────── seen / not seen (no personal data — just a marker and an expiry time) ───────── */
function markSeen(showAgain) {
  safely(() => sessionStorage.setItem(SEEN, '1'));
  if (PERIOD[showAgain]) safely(() => localStorage.setItem(SEEN, JSON.stringify({ until: Date.now() + PERIOD[showAgain] })));
  else safely(() => localStorage.removeItem(SEEN));
}

/* ───────── page lock while the curtains are closed (no layout change: just ignore scroll input) ───────── */
function lockPage(overlay) {
  const others = [...document.body.children].filter((el) => el !== overlay && !el.inert);
  others.forEach((el) => { el.inert = true; });
  const board = $('.vbc-board', overlay);
  const canScrollBoard = (t) => board.contains(t) && board.scrollHeight > board.clientHeight + 1;
  const stop = (e) => { if (!canScrollBoard(e.target)) e.preventDefault(); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); overlay.dispatchEvent(new CustomEvent('vbc:open')); return; }
    if (e.key === 'Tab') { // keep focus inside the curtain while it is closed
      const f = $$('a[href], button:not([disabled])', overlay).filter((el) => el.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]?.focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0]?.focus(); }
      return;
    }
    if ([' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && !e.target.closest?.('a, button') && !canScrollBoard(e.target)) e.preventDefault();
  };
  overlay.addEventListener('wheel', stop, { passive: false });
  overlay.addEventListener('touchmove', stop, { passive: false });
  document.addEventListener('keydown', keys, true);
  return () => {
    others.forEach((el) => { el.inert = false; });
    overlay.removeEventListener('wheel', stop);
    overlay.removeEventListener('touchmove', stop);
    document.removeEventListener('keydown', keys, true);
  };
}

function sparkles(overlay) {
  const marks = ['✦', '✧', '✦', '♥', '✧'];
  overlay.insertAdjacentHTML('beforeend', Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
    const r = 120 + Math.random() * 220;
    return `<i class="vbc-spark" aria-hidden="true" style="--x:${(Math.cos(a) * r).toFixed(0)}px;--y:${(Math.sin(a) * r * 0.75 - 60).toFixed(0)}px;--d:${(0.15 + Math.random() * 0.5).toFixed(2)}s;--t:${(1.4 + Math.random() * 0.9).toFixed(2)}s;--s:${12 + (i % 4) * 4}px;${marks[i % 5] === '♥' ? 'color:var(--kobi);' : ''}">${marks[i % 5]}</i>`;
  }).join(''));
}

/**
 * Show the curtain with these products. Resolves when it has fully opened.
 * preview: used by the admin studio — nothing is remembered and the homepage isn't involved.
 */
function showCurtain(products, { showAgain = 'session', preview = false } = {}) {
  return new Promise((done) => {
    const overlay = document.createElement('div');
    overlay.className = 'vbc';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'vbc-title');
    overlay.innerHTML = overlayHTML(products);
    document.body.append(overlay);
    const release = lockPage(overlay);
    requestAnimationFrame(() => document.documentElement.classList.remove('vbc-pending')); // the real curtains now cover the page
    $('.vbc-cta [data-vbc-open]', overlay).focus({ preventScroll: true });

    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      if (!preview) markSeen(showAgain);
      const still = reducedMotion();
      overlay.classList.add('is-opening');
      if (!still) sparkles(overlay);
      release();
      // let the page come alive as the curtains part (the gift box starts its own little show here)
      setTimeout(() => { if (!preview) resolveReveal(); }, still ? 0 : 650);
      setTimeout(() => overlay.classList.add('is-done'), still ? 380 : 2050);
      setTimeout(() => {
        overlay.remove();
        if (!preview) (document.getElementById('main') || document.body).focus?.({ preventScroll: true });
        done();
      }, still ? 760 : 3000);
    };
    overlay.addEventListener('vbc:open', open);
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-vbc-open]')) { open(); return; }
      if (e.target.closest('[data-vbc-view]')) { if (!preview) markSeen(showAgain); else e.preventDefault(); return; } // follows the link
      if (e.target.closest('[data-vbc-board]')) open();
    });
    // Coming back with the browser's back button after "View Treasure": the page may be restored as it was.
    if (!preview) {
      addEventListener('pageshow', (e) => {
        if (e.persisted && !opened) { opened = true; markSeen(showAgain); release(); overlay.remove(); resolveReveal(); done(); }
      });
    }
  });
}

/** Admin studio: play the full curtain with an unsaved selection (nothing is stored). */
export const previewCurtain = (products) => showCurtain(products, { preview: true });

/* ───────── homepage ───────── */
async function init() {
  const html = document.documentElement;
  if (!html.classList.contains('vbc-pending')) {
    resolveReveal();
    // The visitor skipped it because the last check found no special: refresh that hint for their next visit.
    if (safely(() => localStorage.getItem(HINT)) === 'off' && !safely(() => sessionStorage.getItem(SEEN))) {
      api('/todays-special').then((d) => safely(() => localStorage.setItem(HINT, d.active ? 'on' : 'off'))).catch(() => {});
    }
    return;
  }
  let data = null;
  try {
    data = await Promise.race([api('/todays-special'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
  } catch { /* network trouble: never keep a visitor out of the shop */ }
  safely(() => localStorage.setItem(HINT, data?.active ? 'on' : 'off'));
  if (!data?.active || !data.products?.length) {
    html.classList.add('vbc-out');
    setTimeout(() => html.classList.remove('vbc-pending', 'vbc-out'), reducedMotion() ? 0 : 420);
    resolveReveal();
    return;
  }
  showCurtain(data.products, { showAgain: data.showAgain });
}

if (document.body?.dataset.page === 'home') init();
else resolveReveal();
