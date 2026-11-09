/**
 * The ONLY product data shown to people who haven't confirmed an email (or aren't signed in):
 *  • homeTeaser()      — the homepage's featured charms, 360° showcase charm and "Our Little Menu"
 *  • sharedProduct()   — one product, for a public share link (/share/product/:slug)
 *
 * Everything here is reduced to an allow-list of display fields: name, photos, short description, price, category
 * name, and whether it can be bought. Never stock counts, SKUs, weights, supplier/admin fields or anything about
 * customers. The full catalogue API (routes/store.js) stays behind the verified-customer gate.
 */
import { config } from '../config.js';
import { listProducts, getProduct, listCategories } from './catalog.js';

/** "In stock" / "Sold out" only — the "Only 3 left" label would reveal stock levels. */
const publicAvailability = (a) => (a.status === 'sold_out' ? { status: 'sold_out', label: 'Sold out' } : { status: 'in_stock', label: 'In stock' });

/** A product card's display fields (the shape public/js/ui.js → productCard expects). */
export function publicCard(p) {
  return {
    id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc, price: p.price, comparePrice: p.comparePrice,
    image: p.image, images: p.images.slice(0, 2).map((i) => ({ url: i.url, alt: i.alt })),
    category: p.category ? { name: p.category.name } : null,
    availability: publicAvailability(p.availability),
    variants: p.variants.map((v) => ({ price: v.price })), // only to show "from ₹…" and "Choose a style"
  };
}

export const SHOWCASE_SLUG = 'strawberry-shortcake-charm';

export async function homeTeaser() {
  let featured = await listProducts({ featured: true, limit: 8 });
  if (featured.length < 4) featured = await listProducts({ limit: 8 });
  let showcase = null;
  try {
    const p = await getProduct(SHOWCASE_SLUG);
    showcase = { ...publicCard(p), angleImages: p.angleImages.map((i) => ({ url: i.url })) };
  } catch { /* removed by the admin — the homepage shows its 3D model instead */ }
  const categories = (await listCategories()).filter((c) => c.productCount > 0).map((c) => ({
    slug: c.slug, name: c.name, description: c.description, icon: c.icon, fromPrice: c.fromPrice,
    previews: c.previews.map((p) => ({ slug: p.slug, name: p.name, image: p.image })),
  }));
  return { featured: featured.map(publicCard), showcase, categories };
}

export const shareUrl = (slug) => `${config.appUrl}/share/product/${encodeURIComponent(slug)}`;
export const SLUG = /^[A-Za-z0-9_-]{1,160}$/;

/** One live product for its public share page, or null (unknown, archived or unpublished — nothing is revealed). */
export async function sharedProduct(slug) {
  if (!SLUG.test(String(slug || ''))) return null;
  let p;
  try { p = await getProduct(slug); } catch { return null; } // only active products; 404 otherwise
  const prices = [p.price, ...p.variants.map((v) => v.price)];
  return {
    id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc || '', description: p.description || '',
    price: Math.min(...prices), fromPrice: new Set(prices).size > 1, comparePrice: p.comparePrice,
    images: p.images.slice(0, 4).map((i) => ({ url: i.url, alt: i.alt || p.name })),
    image: p.image || null,
    category: p.category?.name || null,
    available: p.availability.status !== 'sold_out',
    hasVariants: p.variants.length > 0,
    url: shareUrl(p.slug),
  };
}
