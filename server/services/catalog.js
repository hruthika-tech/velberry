import { one, all } from '../db/index.js';
import { notFound, bad } from '../lib/errors.js';

const LOW_STOCK = 3;

export function availability(stock, soldOut) {
  if (soldOut || stock <= 0) return { status: 'sold_out', label: 'Sold out' };
  if (stock <= LOW_STOCK) return { status: 'low', label: `Only ${stock} left` };
  return { status: 'in_stock', label: 'In stock' };
}

async function imagesFor(ids) {
  const m = new Map();
  if (!ids.length) return m;
  for (const r of await all('SELECT * FROM product_images WHERE product_id = ANY(?) ORDER BY sort_order, id', ids)) {
    if (!m.has(r.product_id)) m.set(r.product_id, { gallery: [], angles: [] });
    m.get(r.product_id)[r.kind === 'angle' ? 'angles' : 'gallery'].push({ id: r.id, url: r.url, alt: r.alt || '' });
  }
  return m;
}

async function variantsFor(ids, includeInactive = false) {
  const m = new Map();
  if (!ids.length) return m;
  const rows = await all(
    `SELECT * FROM product_variants WHERE product_id = ANY(?) ${includeInactive ? '' : 'AND is_active'} ORDER BY sort_order, id`, ids);
  for (const r of rows) {
    if (!m.has(r.product_id)) m.set(r.product_id, []);
    m.get(r.product_id).push(r);
  }
  return m;
}

export async function serialize(rows, { admin = false } = {}) {
  const ids = rows.map((r) => r.id);
  const [imgs, vars] = await Promise.all([imagesFor(ids), variantsFor(ids, admin)]);
  return rows.map((p) => {
    const variants = (vars.get(p.id) || []).map((v) => ({
      id: v.id, name: v.name, colorHex: v.color_hex, price: v.price ?? p.price, stock: v.stock, sku: v.sku,
      isActive: v.is_active, availability: availability(v.stock, p.sold_out),
    }));
    const stock = variants.length ? variants.filter((v) => v.isActive).reduce((s, v) => s + v.stock, 0) : p.stock;
    const im = imgs.get(p.id) || { gallery: [], angles: [] };
    return {
      id: p.id, slug: p.slug, name: p.name, price: p.price, comparePrice: p.compare_price,
      shortDesc: p.short_desc, description: p.description, materials: p.materials, dimensions: p.dimensions,
      category: p.category_id ? { id: p.category_id, slug: p.category_slug, name: p.category_name, icon: p.category_icon } : null,
      images: im.gallery, angleImages: im.angles, image: im.gallery[0]?.url || null,
      variants, stock, availability: availability(stock, p.sold_out),
      isFeatured: p.is_featured,
      ...(admin ? { sku: p.sku, weightGrams: p.weight_grams, isActive: p.is_active, soldOut: p.sold_out, ownStock: p.stock } : {}),
    };
  });
}

const BASE = `SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon
              FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

export async function listProducts({ category, featured, q, sort, limit = 200, admin = false } = {}) {
  const where = [];
  const params = [];
  if (!admin) where.push('p.is_active');
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (featured) where.push('p.is_featured');
  if (q) {
    where.push('(p.name ILIKE ? OR p.short_desc ILIKE ? OR c.name ILIKE ?)');
    const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  const order = { price_asc: 'p.price ASC', price_desc: 'p.price DESC', new: 'p.created_at DESC' }[sort] || 'p.is_featured DESC, c.sort_order NULLS LAST, p.id';
  const rows = await all(`${BASE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`, ...params, limit);
  return serialize(rows, { admin });
}

export async function getProduct(slugOrId, { admin = false } = {}) {
  const byId = /^\d+$/.test(String(slugOrId));
  const row = await one(`${BASE} WHERE ${byId ? 'p.id = ?::bigint' : 'p.slug = ?'} ${admin ? '' : 'AND p.is_active'}`, String(slugOrId));
  if (!row) throw notFound('That little treasure could not be found');
  return (await serialize([row], { admin }))[0];
}

export async function relatedProducts(product, limit = 4) {
  const rows = await all(
    `${BASE} WHERE p.is_active AND p.id <> ? ORDER BY (p.category_id IS NOT DISTINCT FROM ?::bigint) DESC, p.is_featured DESC, random() LIMIT ?`,
    product.id, product.category?.id ?? null, limit);
  return serialize(rows);
}

export async function listCategories() {
  const [cats, counts, previews] = await Promise.all([
    all('SELECT * FROM categories ORDER BY sort_order, id'),
    all('SELECT category_id, COUNT(*) AS n, MIN(price) AS min_price FROM products WHERE is_active GROUP BY category_id'),
    all(`SELECT * FROM (
           SELECT p.id, p.slug, p.name, p.category_id,
                  (SELECT url FROM product_images i WHERE i.product_id = p.id AND i.kind = 'gallery' ORDER BY sort_order, id LIMIT 1) AS image,
                  row_number() OVER (PARTITION BY p.category_id ORDER BY p.is_featured DESC, p.id) AS rn
           FROM products p WHERE p.is_active) x WHERE rn <= 3`),
  ]);
  const byCat = new Map(counts.map((r) => [r.category_id, r]));
  return cats.map((c) => ({
    id: c.id, slug: c.slug, name: c.name, description: c.description, icon: c.icon, imageUrl: c.image_url, sortOrder: c.sort_order,
    productCount: byCat.get(c.id)?.n || 0, fromPrice: byCat.get(c.id)?.min_price ?? null,
    previews: previews.filter((p) => p.category_id === c.id).map((p) => ({ slug: p.slug, name: p.name, image: p.image })),
  }));
}

/**
 * Resolve a purchasable line (product + optional variant) with the live price and stock.
 * Throws if the variant is required/invalid.
 */
export async function resolveLine(productId, variantId) {
  const p = await one('SELECT * FROM products WHERE id = ? AND is_active', productId);
  if (!p) throw bad('One of the items is no longer available');
  const variants = await all('SELECT * FROM product_variants WHERE product_id = ? AND is_active', productId);
  let v = null;
  if (variants.length) {
    v = variants.find((x) => x.id === Number(variantId));
    if (!v) throw bad(`Please choose a style for ${p.name}`);
  } else if (variantId) {
    throw bad(`${p.name} has no style options`);
  }
  const stock = p.sold_out ? 0 : v ? v.stock : p.stock;
  const image = (await one("SELECT url FROM product_images WHERE product_id = ? AND kind = 'gallery' ORDER BY sort_order, id LIMIT 1", p.id))?.url || null;
  return {
    productId: p.id, variantId: v?.id ?? null, slug: p.slug, name: p.name, variantName: v?.name ?? null,
    sku: v?.sku || p.sku || null, unitPrice: v?.price ?? p.price, stock, image, weightGrams: p.weight_grams,
  };
}
