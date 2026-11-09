/**
 * "Today's Special" — the floral curtain introduction on the homepage.
 *
 *   GET  /api/todays-special          public: the published board (only live products, in the chosen order)
 *   GET  /api/admin/todays-special    admin:  settings + the three slots, with any problems flagged
 *   PUT  /api/admin/todays-special    admin:  save { isActive, showAgain, productIds: [id|null ×3] }
 *
 * Products are referenced by id from the existing catalogue — nothing is copied or re-uploaded.
 */
import { Router } from 'express';
import { one, all, run } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { bad, conflict } from '../lib/errors.js';
import { serialize } from '../services/catalog.js';

const SLOTS = ['product_1', 'product_2', 'product_3'];
const SHOW_AGAIN = ['session', 'day', 'week'];

const loadRow = async () => (await one('SELECT * FROM todays_special WHERE id = 1'))
  || { is_active: false, product_1: null, product_2: null, product_3: null, show_again: 'session', updated_at: null };

/** Serialized products by id (same shape the rest of the shop uses). */
async function productsById(ids, { liveOnly, admin = false }) {
  if (!ids.length) return new Map();
  const rows = await all(
    `SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ANY(?) ${liveOnly ? 'AND p.is_active' : ''}`, ids);
  return new Map((await serialize(rows, { admin })).map((p) => [p.id, p]));
}

/** What the board shows for one product — the original photo URL, untouched. */
const boardCard = (p, { admin = false } = {}) => {
  const prices = [p.price, ...p.variants.map((v) => v.price)];
  return {
    id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
    price: Math.min(...prices), fromPrice: new Set(prices).size > 1, comparePrice: p.comparePrice,
    image: p.image, imageAlt: p.images[0]?.alt || p.name, category: p.category?.name || null,
    // The public homepage board says only "In stock" / "Sold out" — never "Only N left" (stock levels stay private).
    availability: admin ? p.availability
      : p.availability.status === 'sold_out' ? { status: 'sold_out', label: 'Sold out' } : { status: 'in_stock', label: 'In stock' },
  };
};

/* ───────── public ───────── */
const pub = Router();
pub.get('/todays-special', async (_req, res) => {
  const row = await loadRow();
  if (!row.is_active) return res.json({ active: false });
  const ids = SLOTS.map((s) => row[s]).filter(Boolean);
  const byId = await productsById(ids, { liveOnly: true });
  const products = ids.map((id) => byId.get(id)).filter(Boolean).map(boardCard); // archived / deleted products are skipped
  res.json({ active: products.length > 0, showAgain: row.show_again, version: row.updated_at, products });
});

/* ───────── admin ───────── */
export const specialAdmin = Router();
specialAdmin.use(requireAdmin); // role checked server-side on every request

async function adminView() {
  const row = await loadRow();
  const ids = SLOTS.map((s) => row[s]).filter(Boolean);
  const byId = await productsById(ids, { liveOnly: false, admin: true });
  return {
    isActive: row.is_active, showAgain: row.show_again, updatedAt: row.updated_at,
    slots: SLOTS.map((s, i) => {
      const id = row[s];
      const p = id ? byId.get(id) : null;
      // FK is ON DELETE SET NULL, so a deleted product shows up as an empty slot.
      const problem = !id ? 'empty' : !p ? 'deleted' : !p.isActive ? 'hidden' : p.availability.status === 'sold_out' ? 'sold_out' : null;
      return { position: i + 1, productId: id, product: p ? { ...boardCard(p, { admin: true }), isActive: p.isActive } : null, problem };
    }),
  };
}

specialAdmin.get('/', async (_req, res) => res.json(await adminView()));

specialAdmin.put('/', async (req, res) => {
  const b = req.body || {};
  const isActive = b.isActive === true;
  const showAgain = SHOW_AGAIN.includes(b.showAgain) ? b.showAgain : null;
  if (!showAgain) throw bad('Choose how often visitors see the curtains', { showAgain: 'Choose an option' });
  if (!Array.isArray(b.productIds) || b.productIds.length !== 3) throw bad('Today\'s Special has exactly three places');

  const ids = b.productIds.map((v) => (v === null || v === '' ? null : Number(v)));
  const errors = {};
  ids.forEach((id, i) => { if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) errors[`slot${i + 1}`] = 'Invalid product'; });
  const chosen = ids.filter((id) => id !== null);
  if (new Set(chosen).size !== chosen.length) throw bad('Each treasure can only be chosen once');

  const found = new Map((await all('SELECT id, name, is_active FROM products WHERE id = ANY(?)', chosen)).map((p) => [p.id, p]));
  ids.forEach((id, i) => {
    if (id === null) { if (isActive) errors[`slot${i + 1}`] = 'Choose a treasure for this place'; return; }
    const p = found.get(id);
    if (!p) errors[`slot${i + 1}`] = 'This product no longer exists — please choose another';
    else if (isActive && !p.is_active) errors[`slot${i + 1}`] = `${p.name} is hidden from the shop — choose a live product`;
  });
  if (Object.keys(errors).length) {
    throw bad(isActive ? 'To publish, choose three live treasures' : 'Please check the highlighted places', errors);
  }

  // Optimistic check: don't silently overwrite a change saved from another tab since this one was loaded.
  const current = await loadRow();
  if (b.updatedAt && current.updated_at && b.updatedAt !== current.updated_at) {
    throw conflict('Today\'s Special was changed somewhere else since you opened it — reload to see the latest');
  }

  await run(`INSERT INTO todays_special (id, is_active, product_1, product_2, product_3, show_again, updated_at, updated_by)
             VALUES (1, ?, ?, ?, ?, ?, now(), ?)
             ON CONFLICT (id) DO UPDATE SET is_active = excluded.is_active, product_1 = excluded.product_1,
               product_2 = excluded.product_2, product_3 = excluded.product_3, show_again = excluded.show_again,
               updated_at = now(), updated_by = excluded.updated_by`,
  isActive, ids[0], ids[1], ids[2], showAgain, req.user.id);
  res.json(await adminView());
});

export default pub;
