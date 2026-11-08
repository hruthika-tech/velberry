import '../layout.js';
import { api, money, esc, qs, $, $$ } from '../api.js';
import { charmSVG } from '../charms.js';
import { cart, celebrateAdd, toastError, productCard, bindQuickAdd, stepper, loaderHTML } from '../ui.js';
import { FrameSpinner } from '../spin360.js';

const slug = location.pathname.match(/^\/p\/([\w-]+)/)?.[1] || qs('slug');
const host = $('[data-product]');

async function init() {
  host.innerHTML = loaderHTML('Fetching your charm…');
  let p;
  try {
    p = await api(`/products/${encodeURIComponent(slug)}`);
  } catch (e) {
    host.innerHTML = `<div class="empty-state">${charmSVG('cherries', { size: 96 })}<h1>Oh no, it's not here</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/shop.html">Back to the boutique</a></div>`;
    return;
  }
  document.title = `${p.name} — CLAYSLAY`;
  render(p);
  if (p.related?.length) {
    $('[data-related-wrap]').hidden = false;
    $('[data-related]').innerHTML = p.related.map(productCard).join('');
    bindQuickAdd($('[data-related]'), new Map(p.related.map((r) => [r.id, r])));
  }
}

function render(p) {
  const hasVariants = p.variants.length > 0;
  let variant = hasVariants ? (p.variants.find((v) => v.stock > 0) || null) : null;
  const images = p.images.length ? p.images : [{ url: null, alt: p.name }];
  const has360 = p.angleImages.length >= 8;

  host.innerHTML = `
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>›</span><a href="/shop.html">Boutique</a>
    ${p.category ? `<span>›</span><a href="/collection/${esc(p.category.slug)}">${esc(p.category.name)}</a>` : ''}</nav>
  <div class="pdp">
    <div class="gallery">
      <div class="gallery-main" data-main>
        ${images[0].url ? `<img src="${esc(images[0].url)}" alt="${esc(images[0].alt || p.name)}" width="1000" height="1000" data-main-img>` : charmSVG('heart', { size: 300 })}
      </div>
      <div class="gallery-thumbs" role="group" aria-label="Product photos">
        ${images.length > 1 || has360 ? images.map((im, i) => `<button type="button" data-img="${i}" aria-pressed="${i === 0}" aria-label="Photo ${i + 1}"><img src="${esc(im.url)}" alt="" loading="lazy"></button>`).join('') : ''}
        ${has360 ? '<button type="button" class="spin-thumb" data-spin aria-pressed="false">360°<br>view</button>' : ''}
      </div>
    </div>
    <div class="pdp-info">
      ${p.category ? `<span class="pc-tag" style="position:static;display:inline-block">${esc(p.category.name)}</span>` : ''}
      <h1>${esc(p.name)}</h1>
      <div class="pdp-price"><span class="price" data-price></span>${p.comparePrice && p.comparePrice > p.price ? `<s class="muted">${money(p.comparePrice)}</s>` : ''}<span class="stock" data-stock></span></div>
      <p class="pdp-short">${esc(p.shortDesc)}</p>
      ${hasVariants ? `<div class="opt-label">Style: <span data-variant-name></span></div>
        <div class="swatches" role="group" aria-label="Choose a style">
          ${p.variants.map((v) => `<button type="button" class="swatch" data-variant="${v.id}" ${v.stock <= 0 ? 'disabled' : ''} aria-pressed="false">
            <i style="background:${esc(v.colorHex || '#E6C0C9')}"></i>${esc(v.name)}${v.stock <= 0 ? ' · sold out' : ''}</button>`).join('')}
        </div>` : ''}
      <div class="opt-label">Quantity</div>
      <div class="buy-row"><div data-stepper></div><div class="line-total" data-line aria-live="polite"></div></div>
      <div class="buy-buttons">
        <button class="btn" type="button" data-add><span class="heart">♥</span> Add to Bag</button>
        <button class="btn btn-matcha" type="button" data-buy>Buy Now</button>
      </div>
      <div class="perks"><div><b>✿</b>Handmade<br>to last</div><div><b>♡</b>Gift-ready<br>packaging</div><div><b>✈</b>Tracked<br>delivery</div></div>
      <div class="details-acc">
        <details open><summary>The story</summary><div class="acc-body">${esc(p.description).replace(/\n/g, '<br>')}</div></details>
        <details><summary>Materials</summary><div class="acc-body">${esc(p.materials || 'Polymer clay with a protective glaze')}</div></details>
        <details><summary>Dimensions</summary><div class="acc-body">${esc(p.dimensions || '—')}</div></details>
        <details><summary>Care</summary><div class="acc-body">Keep away from sharp objects and long direct sunlight. Wipe gently with a soft dry cloth. <a href="/care.html">More care tips</a></div></details>
        <details><summary>Delivery</summary><div class="acc-body">Shipped within 2–4 days with tracking. <span data-ship-note></span> <a href="/shipping.html">Shipping &amp; returns</a></div></details>
      </div>
    </div>
  </div>`;

  // gallery
  const main = $('[data-main]', host);
  let spinner = null;
  $$('[data-img]', host).forEach((b) => b.addEventListener('click', () => {
    spinner?.destroy(); spinner = null;
    main.innerHTML = `<img src="${esc(images[b.dataset.img].url)}" alt="${esc(images[b.dataset.img].alt || p.name)}" data-main-img>`;
    $$('.gallery-thumbs button', host).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('[data-spin]', host)?.addEventListener('click', (e) => {
    const s = document.createElement('div');
    s.className = 'spin-host';
    main.innerHTML = '';
    main.append(s);
    spinner = new FrameSpinner(s, p.angleImages.map((i) => i.url), { alt: p.name });
    $$('.gallery-thumbs button', host).forEach((x) => x.setAttribute('aria-pressed', String(x === e.currentTarget)));
  });
  main.addEventListener('click', (e) => {
    const img = e.target.closest('[data-main-img]');
    if (!img) return;
    main.classList.toggle('zoom');
  });
  main.addEventListener('mousemove', (e) => {
    if (!main.classList.contains('zoom')) return;
    const r = main.getBoundingClientRect();
    const img = $('img', main);
    if (img) img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  });

  // purchase state
  const avail = () => (hasVariants ? (variant ? variant.stock : 0) : p.stock);
  const unit = () => (variant ? variant.price : p.price);
  const qty = stepper({ value: 1, min: 1, max: Math.max(1, Math.min(avail(), 20)), label: p.name, onChange: () => update() });
  $('[data-stepper]', host).append(qty.el);

  function update() {
    const stock = avail();
    qty.setMax(Math.max(1, Math.min(stock, 20)));
    $('[data-price]', host).textContent = money(unit());
    const st = $('[data-stock]', host);
    const a = hasVariants && !variant ? { status: 'sold_out', label: 'Choose a style' } : stock <= 0 ? { status: 'sold_out', label: 'Sold out' } : stock <= 3 ? { status: 'low', label: `Only ${stock} left` } : { status: 'in_stock', label: 'In stock' };
    st.className = `stock ${a.status}`;
    st.textContent = a.label;
    const can = stock > 0 && (!hasVariants || variant);
    $('[data-add]', host).disabled = !can;
    $('[data-buy]', host).disabled = !can;
    $('[data-line]', host).innerHTML = can ? `${qty.value} × ${money(unit())} = <b>${money(unit() * qty.value)}</b>` : (hasVariants && !variant ? 'Pick a style to continue' : 'This one is sold out for now');
    if (hasVariants) {
      $('[data-variant-name]', host).textContent = variant?.name || '';
      $$('[data-variant]', host).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.variant) === variant?.id)));
    }
  }
  $$('[data-variant]', host).forEach((b) => b.addEventListener('click', () => {
    variant = p.variants.find((v) => v.id === Number(b.dataset.variant));
    qty.set(Math.min(qty.value, Math.max(1, variant.stock)));
    update();
  }));
  update();

  const add = async (btn, opts) => {
    btn.classList.add('is-loading');
    try {
      await cart.add(p.id, variant?.id, qty.value, opts); // signed out → login first, then back here
      return true;
    } catch (e) { toastError(e); return false; } finally { btn.classList.remove('is-loading'); }
  };
  $('[data-add]', host).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (await add(btn)) celebrateAdd(btn, { image: p.image, name: `${qty.value} × ${p.name}${variant ? ` (${variant.name})` : ''}` });
  });
  $('[data-buy]', host).addEventListener('click', async (e) => {
    if (await add(e.currentTarget, { go: 'checkout' })) location.href = '/checkout.html';
  });

  import('../layout.js').then(({ siteConfig }) => siteConfig.then((c) => {
    if (c.freeShippingAbove) $('[data-ship-note]', host).textContent = `Free delivery on orders above ${money(c.freeShippingAbove)}.`;
  }));
}

init();
