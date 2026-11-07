/**
 * Seeds the starter catalogue (only when the products table is empty — safe to re-run).
 *   npm run seed            → seed if empty
 *   npm run seed -- --force → wipe the catalogue (orders keep their snapshots) and reseed
 * With Supabase Storage configured, the starter artwork is uploaded to the product-images bucket.
 */
import fs from 'node:fs';
import path from 'node:path';
import { one, run, tx, migrate, closeDb } from './index.js';
import { config, ROOT } from '../config.js';
import { ensureAdmin } from './bootstrap.js';
import { CATEGORIES, PRODUCTS } from './seed-data.js';
import * as storage from '../services/storage.js';
import { guardScript } from '../lib/script-guard.js';

const SEED_DIR = path.join(ROOT, 'public', 'uploads', 'seed');

/** Put a bundled seed image where the site will serve it from; returns its URL. */
export async function storeSeedImage(file) {
  if (!storage.isRemote()) return `/uploads/seed/${file}`;
  const ext = path.extname(file).slice(1).toLowerCase();
  const url = await storage.putImage({
    bucket: config.supabase.buckets.products, folder: 'seed', name: file,
    buffer: fs.readFileSync(path.join(SEED_DIR, file)), ext, contentType: ext === 'svg' ? 'image/svg+xml' : `image/${ext}`,
  });
  // PNG twin for email clients (they can't display SVG) — kept next to the SVG with the same name.
  const png = file.replace(/\.svg$/i, '.png');
  if (png !== file && fs.existsSync(path.join(SEED_DIR, png))) {
    await storage.putImage({ bucket: config.supabase.buckets.products, folder: 'seed', name: png, buffer: fs.readFileSync(path.join(SEED_DIR, png)), ext: 'png', contentType: 'image/png' });
  }
  return url;
}

export async function seedCatalog({ force = false } = {}) {
  if ((await one('SELECT 1 FROM products LIMIT 1')) && !force) return false;
  // Upload artwork first (outside the transaction — network calls shouldn't hold DB locks).
  const imageUrls = new Map();
  for (const p of PRODUCTS) {
    for (const n of [1, 2]) {
      const file = `${p.slug}-${n}.svg`;
      if (fs.existsSync(path.join(SEED_DIR, file))) imageUrls.set(file, await storeSeedImage(file));
    }
  }
  await tx(async () => {
    if (force) { await run('DELETE FROM cart_items'); await run('DELETE FROM products'); await run('DELETE FROM categories'); }
    const catId = {};
    for (const [i, c] of CATEGORIES.entries()) {
      catId[c.slug] = (await run('INSERT INTO categories(slug, name, description, icon, sort_order) VALUES (?,?,?,?,?)', c.slug, c.name, c.description, c.icon, i)).id;
    }
    for (const p of PRODUCTS) {
      const { id: pid } = await run(`INSERT INTO products(slug, name, category_id, short_desc, description, materials, dimensions, price, compare_price, stock, sku, weight_grams, is_featured)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.slug, p.name, catId[p.category], p.short, p.desc, 'Polymer clay, UV-resin glaze, gold-tone alloy keyring & chain', p.dims,
      p.price * 100, p.compare ? p.compare * 100 : null, p.stock, `VB-${p.slug.slice(0, 12).toUpperCase()}`, 28, Boolean(p.featured));
      for (const [i, n] of [1, 2].entries()) {
        const url = imageUrls.get(`${p.slug}-${n}.svg`);
        if (url) {
          await run("INSERT INTO product_images(product_id, url, alt, kind, sort_order) VALUES (?,?,?,'gallery',?)",
            pid, url, n === 1 ? `${p.name} keychain` : `${p.name} close-up`, i);
        }
      }
      for (const [i, v] of (p.variants || []).entries()) {
        await run('INSERT INTO product_variants(product_id, name, color_hex, price, stock, sku, sort_order) VALUES (?,?,?,?,?,?,?)',
          pid, v.name, v.hex, v.price ? v.price * 100 : null, v.stock, `VB-${p.slug.slice(0, 8).toUpperCase()}-${i + 1}`, i);
      }
    }
  });
  return true;
}

if (process.argv[1]?.endsWith('seed.js')) {
  // Refuses Production unless run as `npm run seed -- --production` (see server/lib/script-guard.js).
  guardScript('seed');
  await migrate({ log: console.log });
  await ensureAdmin();
  const did = await seedCatalog({ force: process.argv.includes('--force') });
  console.log(did ? `✿ Seeded ${CATEGORIES.length} categories and ${PRODUCTS.length} products` : 'Catalogue already has products — nothing to do (use --force to reseed).');
  await closeDb();
}
