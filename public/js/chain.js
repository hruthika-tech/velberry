/**
 * Decorative charm chain — gold links + pearls drawn along swags, with dangling charms that swing.
 * Purely decorative: aria-hidden, pointer-events: none, redrawn on resize.
 */
import { CHARMS } from './charms.js';
import { reducedMotion } from './api.js';

const GOLD = '#C9A15C';
const GOLD_HI = '#F1DDAE';

/**
 * @param {HTMLElement} el container (its size defines the drawing)
 * @param {{charms: string[], swagWidth?: number, sag?: number, top?: number, charmSize?: number, dropLinks?: number, spacing?: number}} opts
 */
export function mountChain(el, opts) {
  el.classList.add('charm-chain');
  el.setAttribute('aria-hidden', 'true');
  const draw = () => { el.innerHTML = render(el.clientWidth, el.clientHeight, opts); };
  draw();
  let t;
  const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(draw, 120); });
  ro.observe(el);
  return { redraw: draw, el };
}

function render(W, H, { charms, swagWidth = 620, sag = 22, top = 6, charmSize = 40, dropLinks = 2, spacing = 150 }) {
  if (!W || !H) return '';
  const swags = Math.max(1, Math.round(W / swagWidth));
  const sw = W / swags;
  const yAt = (x) => {
    const local = (x % sw) / sw;
    return top + sag * 4 * local * (1 - local);
  };
  const slope = (x) => {
    const local = (x % sw) / sw;
    return (sag * 4 * (1 - 2 * local)) / sw;
  };

  let links = '';
  const step = 9;
  let i = 0;
  for (let x = 4; x < W - 2; x += step, i++) {
    const y = yAt(x);
    const ang = (Math.atan(slope(x)) * 180) / Math.PI;
    if (i % 7 === 3) {
      links += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.6" fill="#FFFBF4" stroke="#E2CDB8" stroke-width="1"/><circle cx="${(x - 1.4).toFixed(1)}" cy="${(y - 1.5).toFixed(1)}" r="1.4" fill="#fff"/>`;
    } else {
      const flat = i % 2 === 0;
      links += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="5.4" ry="${flat ? 3 : 1.4}" transform="rotate(${ang.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="none" stroke="${GOLD}" stroke-width="1.9"/>`;
      if (flat) links += `<ellipse cx="${(x - 1).toFixed(1)}" cy="${(y - 1).toFixed(1)}" rx="2.2" ry=".8" transform="rotate(${ang.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${GOLD_HI}" opacity=".8"/>`;
    }
  }

  // little bows at swag joins
  let joins = '';
  for (let s = 0; s <= swags; s++) {
    const x = Math.min(W - 10, Math.max(10, s * sw));
    joins += `<g transform="translate(${x - 13} ${top - 12}) scale(.26)">${CHARMS.bow.svg}</g>`;
  }

  // dangling charms, evenly spaced, avoiding the joins
  const count = Math.max(2, Math.floor(W / spacing));
  const gap = W / count;
  let dangles = '';
  const linkGap = 8;
  for (let k = 0; k < count; k++) {
    const x = gap * (k + 0.5);
    const local = (x % sw) / sw;
    if (local < 0.07 || local > 0.93) continue;
    const y = yAt(x);
    const name = charms[k % charms.length];
    const c = CHARMS[name] || CHARMS.heart;
    const size = charmSize * (name === 'pearl' ? 0.7 : 1) * (0.9 + ((k * 37) % 20) / 100);
    const sc = size / 100;
    const drop = dropLinks + (k % 3 === 1 ? 1 : 0);
    let stem = '';
    for (let d = 0; d < drop; d++) {
      const yy = y + 5 + d * linkGap;
      stem += d % 2
        ? `<ellipse cx="${x}" cy="${yy}" rx="1.3" ry="4.4" fill="none" stroke="${GOLD}" stroke-width="1.8"/>`
        : `<ellipse cx="${x}" cy="${yy}" rx="2.9" ry="4.4" fill="none" stroke="${GOLD}" stroke-width="1.8"/>`;
    }
    const ringY = y + 5 + drop * linkGap;
    const top0 = ringY + 3 - c.hook * sc;
    const dur = (3 + ((k * 13) % 17) / 10).toFixed(2);
    const delay = (-((k * 7) % 30) / 10).toFixed(2);
    const amp = (4 + ((k * 11) % 5)).toFixed(1);
    dangles += `<g class="dangle" style="transform-origin:${x.toFixed(1)}px ${y.toFixed(1)}px;--dur:${dur}s;--delay:${delay}s;--amp:${amp}deg">
      <g class="dangle-inner" style="transform-origin:${x.toFixed(1)}px ${y.toFixed(1)}px">
        ${stem}
        <circle cx="${x}" cy="${ringY}" r="3.6" fill="none" stroke="${GOLD}" stroke-width="1.8"/>
        <g transform="translate(${(x - 50 * sc).toFixed(1)} ${top0.toFixed(1)}) scale(${sc.toFixed(3)})">${c.svg}</g>
      </g></g>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" focusable="false">
    <g>${links}</g>${dangles}<g>${joins}</g></svg>`;
}

/**
 * Bottom "signature" chain: slides in after the hero, swings with scroll velocity, never blocks clicks.
 * Reserves page space via --chain-bottom-h so nothing important is ever hidden beneath it.
 */
export function mountDockChain() {
  // On phones, keep the dock to the homepage so it never sits over product controls while scrolling.
  if (matchMedia('(max-width: 640px)').matches && document.body.dataset.page !== 'home') return;
  const dock = document.createElement('div');
  dock.className = 'chain-dock';
  dock.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  dock.append(inner);
  document.body.append(dock);
  const small = matchMedia('(max-width: 640px)').matches;
  mountChain(inner, {
    charms: ['strawberry', 'pearl', 'bow', 'daisy', 'heart', 'pearl', 'butterfly', 'key', 'star', 'cherries', 'pearl', 'macaron'],
    swagWidth: 520, sag: 10, top: 12, charmSize: small ? 26 : 32, dropLinks: 1, spacing: small ? 70 : 92,
  });

  const show = () => {
    const on = scrollY > innerHeight * 0.55;
    dock.classList.toggle('is-visible', on);
    document.documentElement.style.setProperty('--chain-bottom-h', on ? `${dock.offsetHeight}px` : '0px');
  };
  show();

  if (reducedMotion()) { addEventListener('scroll', show, { passive: true }); return; }

  let lastY = scrollY;
  let tilt = 0;
  let raf = 0;
  const tick = () => {
    const v = scrollY - lastY;
    lastY = scrollY;
    tilt += (Math.max(-18, Math.min(18, -v * 0.6)) - tilt) * 0.12;
    const els = inner.querySelectorAll('.dangle-inner');
    els.forEach((g, idx) => { g.style.transform = `rotate(${(tilt * (0.6 + (idx % 3) * 0.25)).toFixed(2)}deg)`; });
    if (Math.abs(tilt) > 0.05 || Math.abs(v) > 0) raf = requestAnimationFrame(tick);
    else { raf = 0; els.forEach((g) => { g.style.transform = ''; }); }
  };
  addEventListener('scroll', () => { show(); if (!raf) raf = requestAnimationFrame(tick); }, { passive: true });
}
