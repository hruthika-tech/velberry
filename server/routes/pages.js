/**
 * Pages that are NOT plain public files.
 *
 *  • Shopping pages (boutique, collections, product pages, bag, checkout) live in server/pages/ — outside public/, so
 *    no CDN or static server can hand them out. They are sent only to a signed-in customer with a CONFIRMED email
 *    (or an admin); everyone else is redirected: signed out → log in, unconfirmed → the "confirm your email" page.
 *    The data behind them is gated the same way in the API (routes/store.js, routes/checkout.js).
 *  • /share/product/:slug — a public, server-rendered page for ONE product, so a link shared on WhatsApp/Instagram
 *    shows a proper preview (Open Graph / Twitter tags need real HTML; crawlers don't run JavaScript). It shows only
 *    the allow-listed display fields from services/public-catalog.js and links nowhere into the gated shop.
 *
 * Canonical/share URLs are built from the trusted APP_URL — never from the request's Host header.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { ROOT, config } from '../config.js';
import { shoppingAccess } from '../lib/auth.js';
import { sharedProduct, SLUG } from '../services/public-catalog.js';

export const PAGES_DIR = path.join(ROOT, 'server', 'pages');
// Literal URLs on purpose: Vercel's file tracer bundles files referenced like this (vercel.json → includeFiles is the
// second safety net), so the serverless function always has them.
const PAGE_FILES = {
  'shop.html': fileURLToPath(new URL('../pages/shop.html', import.meta.url)),
  'product.html': fileURLToPath(new URL('../pages/product.html', import.meta.url)),
  'cart.html': fileURLToPath(new URL('../pages/cart.html', import.meta.url)),
  'checkout.html': fileURLToPath(new URL('../pages/checkout.html', import.meta.url)),
};
const r = Router();

/* ───────── gated shopping pages ───────── */
const gated = (file) => (req, res) => {
  res.set('Cache-Control', 'private, no-store'); // never cached by a CDN or shared between visitors
  const back = encodeURIComponent(req.originalUrl.slice(0, 300));
  const access = shoppingAccess(req.user);
  if (access === 'login') return res.redirect(302, `/account.html?reason=browse&next=${back}`);
  if (access === 'verify') return res.redirect(302, `/verify-pending.html?next=${back}`);
  res.sendFile(PAGE_FILES[file], { cacheControl: false, lastModified: false, etag: false });
};
r.get(['/shop', '/shop.html'], gated('shop.html'));
r.get('/collection/:slug', gated('shop.html'));
r.get('/p/:slug', gated('product.html'));
r.get(['/cart', '/cart.html'], gated('cart.html'));
r.get(['/checkout', '/checkout.html'], gated('checkout.html'));

/* ───────── public share page ───────── */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
/** Absolute URL for previews; seed artwork is SVG, which chat apps can't show, so use its PNG twin. */
const absImage = (url) => {
  if (!url) return null; // no photo → no image tag (better than a broken preview)
  const u = String(url).replace(/\.svg$/i, '.png');
  return /^https?:\/\//.test(u) ? u : `${config.appUrl}${u.startsWith('/') ? '' : '/'}${u}`;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function head({ title, description, url, image, imageAlt, type = 'website', price, robots }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  ${robots ? `<meta name="robots" content="${robots}">` : ''}
  ${url ? `<link rel="canonical" href="${esc(url)}">` : ''}
  <meta property="og:site_name" content="CLAYSLAY">
  <meta property="og:type" content="${type}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  ${url ? `<meta property="og:url" content="${esc(url)}">` : ''}
  ${image ? `<meta property="og:image" content="${esc(image)}">
  <meta property="og:image:alt" content="${esc(imageAlt)}">` : ''}
  ${price != null ? `<meta property="product:price:amount" content="${(price / 100).toFixed(2)}">
  <meta property="product:price:currency" content="INR">` : ''}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  ${image ? `<meta name="twitter:image" content="${esc(image)}">
  <meta name="twitter:image:alt" content="${esc(imageAlt)}">` : ''}
  <link rel="manifest" href="/site.webmanifest">
  <link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Nunito:wght@400;600;700;800&family=Parisienne&family=Playfair+Display:ital,wght@0,400..700;1,400..600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/velberry.css">
  <link rel="stylesheet" href="/css/pages.css">
</head>`;
}

const SHARE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`;

export function renderSharePage(p) {
  const description = clip(p.shortDesc || p.description || 'A handmade clay charm from CLAYSLAY.', 200);
  const title = `${p.name} — CLAYSLAY`;
  const images = p.images.length ? p.images : [{ url: null, alt: p.name }];
  const onSale = p.comparePrice && p.comparePrice > p.price;
  return `${head({ title, description, url: p.url, image: absImage(p.image), imageAlt: images[0].alt || p.name, type: 'product', price: p.price })}
<body data-page="share" data-chain="slim" data-dock="off">
  <main id="main" class="bg-paper">
    <div class="wrap share-wrap" data-share-product data-product-id="${p.id}" data-slug="${esc(p.slug)}" data-name="${esc(p.name)}"
      data-share-url="${esc(p.url)}" data-share-text="${esc(description)}" data-has-variants="${p.hasVariants}" data-available="${p.available}">
      <p class="share-ribbon"><span aria-hidden="true">💌</span> A friend shared this little treasure with you</p>
      <article class="pdp share-pdp">
        <div class="gallery">
          <div class="gallery-main" data-share-main>
            ${images[0].url ? `<img src="${esc(images[0].url)}" alt="${esc(images[0].alt || p.name)}" width="1000" height="1000">` : ''}
          </div>
          ${images.length > 1 ? `<div class="gallery-thumbs" role="group" aria-label="Product photos">${images.map((im, i) => `<button type="button" data-share-img="${esc(im.url)}" data-share-alt="${esc(im.alt || p.name)}" aria-pressed="${i === 0}" aria-label="Photo ${i + 1}"><img src="${esc(im.url)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
        </div>
        <div class="pdp-info">
          ${p.category ? `<span class="pc-tag" style="position:static;display:inline-block">${esc(p.category)}</span>` : ''}
          <h1>${esc(p.name)}</h1>
          <div class="pdp-price"><span class="price">${p.fromPrice ? 'from ' : ''}${rupees(p.price)}</span>${onSale ? `<s class="muted">${rupees(p.comparePrice)}</s>` : ''}
            <span class="stock ${p.available ? 'in_stock' : 'sold_out'}">${p.available ? 'In stock' : 'Sold out'}</span></div>
          ${p.shortDesc ? `<p class="pdp-short">${esc(p.shortDesc)}</p>` : ''}
          <div class="buy-buttons share-buy">
            <button class="btn" type="button" data-share-add ${p.available ? '' : 'disabled'}><span class="heart">♥</span> ${p.hasVariants ? 'Choose a style' : 'Add to Bag'}</button>
            <button class="share-btn" type="button" data-share aria-label="Share this charm" title="Share this charm">${SHARE_ICON}</button>
          </div>
          <p class="share-note muted">Love it? Create your free CLAYSLAY account and confirm your email to explore the whole boutique.</p>
          ${p.description ? `<div class="details-acc"><details open><summary>The story</summary><div class="acc-body">${esc(p.description).replace(/\n/g, '<br>')}</div></details></div>` : ''}
        </div>
      </article>
    </div>
  </main>
  <script type="module" src="/js/pages/share.js"></script>
</body>
</html>`;
}

export function renderShareUnavailable() {
  return `${head({ title: 'This charm isn’t available — CLAYSLAY', description: 'Handmade clay charms from CLAYSLAY.', image: null, imageAlt: '', robots: 'noindex' })}
<body data-page="share" data-chain="slim" data-dock="off">
  <main id="main" class="bg-paper">
    <div class="wrap share-wrap">
      <div class="empty-state panel stitched share-missing">
        <h1>This little charm has wandered off</h1>
        <p class="muted">It may be sold out for good or tucked away for now. There are plenty more handmade treasures waiting at CLAYSLAY.</p>
        <a class="btn" href="/">Visit CLAYSLAY</a>
      </div>
    </div>
  </main>
  <script type="module" src="/js/pages/share.js"></script>
</body>
</html>`;
}

r.get('/share/product/:slug', async (req, res) => {
  const p = SLUG.test(req.params.slug) ? await sharedProduct(req.params.slug) : null;
  // Same page for every visitor (no personal data) → may be cached briefly; a price/visibility change shows within a minute.
  res.set('Cache-Control', 'public, max-age=0, s-maxage=60');
  res.type('html');
  if (!p) return res.status(404).send(renderShareUnavailable());
  res.send(renderSharePage(p));
});

export default r;
