/**
 * Public share page (/share/product/:slug, rendered by the server). Anyone can look at this one charm.
 * "Add to Bag": a confirmed customer adds it right here; anyone else is sent to sign up / log in / confirm their email
 * and comes back to this charm's full product page afterwards (with the charm added, when it has no styles to pick).
 */
import { siteConfig } from '../layout.js';
import { $, $$ } from '../api.js';
import { cart, celebrateAdd, toastError } from '../ui.js';
import { shareCharm } from '../share.js';

const root = $('[data-share-product]');
if (root) {
  const d = root.dataset;
  const id = Number(d.productId);
  const hasVariants = d.hasVariants === 'true';

  // gallery thumbnails
  const main = $('[data-share-main]', root);
  $$('[data-share-img]', root).forEach((b) => b.addEventListener('click', () => {
    const img = document.createElement('img');
    img.src = b.dataset.shareImg;
    img.alt = b.dataset.shareAlt;
    img.width = 1000;
    img.height = 1000;
    main.replaceChildren(img);
    $$('[data-share-img]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));

  $('[data-share]', root).addEventListener('click', () => shareCharm({ title: `${d.name} — CLAYSLAY`, text: d.shareText, url: d.shareUrl }));

  $('[data-share-add]', root).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Where to land once they can shop: the full product page (styles are chosen there), adding it if there's nothing to choose.
    const target = `/p/${encodeURIComponent(d.slug)}${hasVariants ? '' : `?add=${id}::1`}`;
    const { user } = await siteConfig;
    if (!user) { location.href = `/account.html?reason=bag&next=${encodeURIComponent(target)}`; return; }
    if (!user.emailVerified && user.role !== 'admin') { location.href = `/verify-pending.html?next=${encodeURIComponent(target)}`; return; }
    if (hasVariants) { location.href = target; return; }
    btn.classList.add('is-loading');
    try {
      await cart.add(id, null, 1);
      celebrateAdd(btn, { image: $('img', main)?.src, name: d.name });
    } catch (err) { toastError(err); } finally { btn.classList.remove('is-loading'); }
  });
}
