/** Shared UI pieces: cart store, toasts, add-to-bag celebration, product cards, steppers. */
import { api, money, esc, reducedMotion, $ } from './api.js';
import { charmSVG } from './charms.js';

/* ───────── cart store (server is the source of truth; persisted per user / guest cookie) ───────── */
export const cart = {
  data: null,
  async load() { this.data = await api('/cart'); this.emit(); return this.data; },
  async add(productId, variantId, quantity = 1) {
    this.data = await api('/cart/items', { method: 'POST', body: { productId, variantId: variantId || undefined, quantity } });
    this.emit();
    return this.data;
  },
  async setQty(itemId, quantity) { this.data = await api(`/cart/items/${itemId}`, { method: 'PATCH', body: { quantity } }); this.emit(); return this.data; },
  async remove(itemId) { this.data = await api(`/cart/items/${itemId}`, { method: 'DELETE' }); this.emit(); return this.data; },
  emit() { document.dispatchEvent(new CustomEvent('cart:change', { detail: this.data })); },
};

/* ───────── toasts ───────── */
function toastHost() {
  let h = $('.toasts');
  if (!h) { h = document.createElement('div'); h.className = 'toasts'; h.setAttribute('role', 'status'); h.setAttribute('aria-live', 'polite'); document.body.append(h); }
  return h;
}
export function toast({ title, text = '', image, icon = 'heart', link, error = false, ms = 3800 }) {
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.innerHTML = `<div class="t-icon">${image ? `<img src="${esc(image)}" alt="">` : charmSVG(error ? 'cherries' : icon, { size: 34 })}</div>
    <div><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}${link ? `<div><a href="${esc(link.href)}">${esc(link.label)}</a></div>` : ''}</div>`;
  toastHost().append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}
export const toastError = (e) => toast({ title: 'Oh no!', text: e?.message || String(e), error: true, ms: 5200 });

/* ───────── celebration ───────── */
export function burst(x, y, chars = ['♥', '✿', '✦', '♡', '🍓', '✧']) {
  if (reducedMotion()) return;
  const b = document.createElement('div');
  b.className = 'burst';
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
  const colors = ['#C96C80', '#D197A2', '#BCCA7D', '#E6A9B5', '#C9A15C'];
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12 + Math.random() * 0.4;
    const d = 40 + Math.random() * 46;
    const s = document.createElement('i');
    s.textContent = chars[i % chars.length];
    s.style.cssText = `--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d - 18}px;--r:${(Math.random() - 0.5) * 120}deg;color:${colors[i % colors.length]};font-size:${12 + Math.random() * 10}px`;
    b.append(s);
  }
  document.body.append(b);
  setTimeout(() => b.remove(), 1000);
}

/** The "Yay!" moment: a little charm flies from the button into the bag icon. */
export function celebrateAdd(fromEl, { image, name }) {
  const bag = $('[data-bag-link]');
  const r = fromEl.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2);
  if (bag && !reducedMotion()) {
    const b = bag.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'fly-charm';
    f.innerHTML = image ? `<img src="${esc(image)}" alt="">` : charmSVG('strawberry', { size: 54 });
    document.body.append(f);
    const sx = r.left + r.width / 2 - 27;
    const sy = r.top - 10;
    const ex = b.left + b.width / 2 - 27;
    const ey = b.top + b.height / 2 - 27;
    f.animate([
      { transform: `translate(${sx}px, ${sy}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${sx}px, ${sy - 50}px) scale(1.05)`, opacity: 1, offset: 0.25 },
      { transform: `translate(${(sx + ex) / 2}px, ${Math.min(sy, ey) - 90}px) scale(.85) rotate(-20deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${ex}px, ${ey}px) scale(.3) rotate(20deg)`, opacity: 0.4 },
    ], { duration: 950, easing: 'cubic-bezier(.5,0,.3,1)' }).finished.then(() => {
      f.remove();
      bag.classList.remove('bag-bump');
      void bag.offsetWidth;
      bag.classList.add('bag-bump');
    });
  }
  toast({ title: 'Yay! A little treasure has been added!', text: name, image, link: { href: '/cart.html', label: 'View my bag →' } });
}

/* ───────── product card ───────── */
export function productCard(p) {
  const soldOut = p.availability.status === 'sold_out';
  const needsChoice = p.variants?.length > 0;
  const second = p.images?.[1]?.url;
  const onSale = p.comparePrice && p.comparePrice > p.price;
  return `<article class="product-card" data-product-id="${p.id}">
    <div class="pc-media">
      ${p.category ? `<span class="pc-tag">${esc(p.category.name.replace(/ Collection$/, ''))}</span>` : ''}
      ${soldOut ? '<span class="pc-badge soldout">sold<br>out</span>' : onSale ? '<span class="pc-badge">sweet<br>deal</span>' : ''}
      ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.images[0]?.alt || p.name)}" loading="lazy" width="600" height="600">` : charmSVG('heart', { size: 200 })}
      ${second ? `<img class="alt" src="${esc(second)}" alt="" loading="lazy" width="600" height="600">` : ''}
    </div>
    <div class="pc-body">
      <h3 class="pc-title"><a href="/p/${esc(p.slug)}">${esc(p.name)}</a></h3>
      <p class="pc-desc">${esc(p.shortDesc)}</p>
      <div class="pc-meta">
        <span class="price">${needsChoice && p.variants.some((v) => v.price !== p.price) ? 'from ' : ''}${money(Math.min(p.price, ...(p.variants || []).map((v) => v.price)))}${onSale ? `<s>${money(p.comparePrice)}</s>` : ''}</span>
        <span class="stock ${p.availability.status}">${esc(p.availability.label)}</span>
      </div>
      <div class="pc-actions">
        ${soldOut
          ? `<a class="btn btn-ghost btn-sm" href="/p/${esc(p.slug)}">View details</a>`
          : needsChoice
            ? `<a class="btn btn-sm" href="/p/${esc(p.slug)}">Choose a style</a>`
            : `<button class="btn btn-sm" type="button" data-add="${p.id}"><span class="heart">♥</span> Add to Bag</button>
               <a class="btn btn-ghost btn-sm" href="/p/${esc(p.slug)}" aria-label="View details of ${esc(p.name)}">Details</a>`}
      </div>
    </div>
  </article>`;
}

/** Delegated click handler for quick "Add to Bag" buttons inside a container. */
export function bindQuickAdd(root, productsById) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const p = productsById.get(Number(btn.dataset.add));
    btn.classList.add('is-loading');
    try {
      await cart.add(p.id, null, 1);
      celebrateAdd(btn, { image: p.image, name: p.name });
    } catch (err) { toastError(err); } finally { btn.classList.remove('is-loading'); }
  });
}

/* ───────── quantity stepper ───────── */
export function stepper({ value = 1, min = 1, max = 20, size = '', label = 'Quantity', onChange }) {
  const el = document.createElement('div');
  el.className = `stepper ${size}`;
  el.innerHTML = `<button type="button" data-d="-1" aria-label="Decrease ${esc(label)}">−</button><output aria-live="polite" aria-label="${esc(label)}"></output><button type="button" data-d="1" aria-label="Increase ${esc(label)}">+</button>`;
  const out = el.querySelector('output');
  const [dec, inc] = el.querySelectorAll('button');
  const set = (v, fire = true) => {
    value = Math.max(min, Math.min(max, v));
    out.textContent = value;
    dec.disabled = value <= min;
    inc.disabled = value >= max;
    if (fire) onChange?.(value);
  };
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) set(value + Number(b.dataset.d)); });
  set(value, false);
  return { el, get value() { return value; }, setMax(m) { max = Math.max(min, m); set(value, false); }, set: (v) => set(v, false) };
}

export const loaderHTML = (text = 'Whisking things up…') => `<div class="loader">${charmSVG('strawberry', { size: 46, cls: 'loader-berry' })}<span>${esc(text)}</span></div>`;
