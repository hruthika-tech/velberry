import { Router } from 'express';
import express from 'express';
import { one, all, run, tx, isUniqueViolation } from '../db/index.js';
import { config } from '../config.js';
import { requireAdmin } from '../lib/auth.js';
import { validate, slugify, rupeesToPaise } from '../lib/validate.js';
import { bad, conflict, notFound } from '../lib/errors.js';
import * as catalog from '../services/catalog.js';
import { orderDetail, transition, STATUS_LABELS } from '../services/orders.js';
import * as fulfillment from '../services/fulfillment.js';
import * as razorpay from '../services/razorpay.js';
import * as shiprocket from '../services/shiprocket.js';
import * as storage from '../services/storage.js';
import { previewEmail } from '../services/notifications.js';

const r = Router();
r.use(requireAdmin); // every route below is admin-only (role checked server-side on every request)

const PAID_STATES = "('paid','partially_refunded','refunded')";
const ACTIVE = "o.status NOT IN ('pending_payment','abandoned')";
const SHOP_TZ = 'Asia/Kolkata';

/** Numeric route id or 404 (never passes junk to Postgres). */
const idParam = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound();
  return n;
};

/* ───────── dashboard ───────── */
r.get('/stats', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
  const [gross, refunded, pending, inTransit, completed, sold, awaiting, bestSellers, lowStock, recentOrders, daily, byStatus] = await Promise.all([
    one(`SELECT COALESCE(SUM(total), 0) AS v, COUNT(*) AS n FROM orders o WHERE payment_status IN ${PAID_STATES}`),
    one("SELECT COALESCE(SUM(amount), 0) AS v FROM refunds WHERE status <> 'failed'"),
    one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','preparing','packed','ready_to_ship')"),
    one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('shipped','out_for_delivery','delivery_failed','rto_initiated')"),
    one("SELECT COUNT(*) AS n FROM orders WHERE status = 'delivered'"),
    one(`SELECT COALESCE(SUM(oi.quantity), 0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.payment_status IN ${PAID_STATES} AND o.status <> 'cancelled'`),
    one("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending_payment'"),
    all(`SELECT oi.product_name AS name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS revenue,
           (SELECT url FROM product_images WHERE product_id = oi.product_id AND kind = 'gallery' ORDER BY sort_order LIMIT 1) AS image
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.payment_status IN ${PAID_STATES} AND o.status <> 'cancelled'
         GROUP BY oi.product_id, oi.product_name ORDER BY qty DESC LIMIT 6`),
    all(`SELECT * FROM (
           SELECT p.id, p.name, p.slug, p.sold_out,
             CASE WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active)
                  THEN (SELECT SUM(stock) FROM product_variants v WHERE v.product_id = p.id AND v.is_active) ELSE p.stock END AS stock
           FROM products p WHERE p.is_active) x
         WHERE stock <= 5 ORDER BY stock ASC LIMIT 8`),
    all(`SELECT order_number, customer_name, total, status, payment_status, created_at FROM orders o WHERE ${ACTIVE} ORDER BY id DESC LIMIT 8`),
    // Days are counted in India time, matching the shop's calendar.
    all(`SELECT to_char(paid_at AT TIME ZONE '${SHOP_TZ}', 'YYYY-MM-DD') AS day, SUM(total) AS revenue, COUNT(*) AS orders FROM orders
         WHERE payment_status IN ${PAID_STATES}
           AND paid_at >= (date_trunc('day', now() AT TIME ZONE '${SHOP_TZ}') - make_interval(days => ?::int)) AT TIME ZONE '${SHOP_TZ}'
         GROUP BY 1 ORDER BY 1`, days - 1),
    all(`SELECT status, COUNT(*) AS n FROM orders o WHERE ${ACTIVE} GROUP BY status`),
  ]);
  res.json({
    revenue: gross.v - refunded.v, grossRevenue: gross.v, refunded: refunded.v, totalOrders: gross.n,
    pendingOrders: pending.n, inTransit: inTransit.n, completedOrders: completed.n, productsSold: sold.n, awaitingPayment: awaiting.n,
    bestSellers, lowStock, recentOrders, daily, timeZone: SHOP_TZ,
    byStatus: byStatus.map((s) => ({ ...s, label: STATUS_LABELS[s.status] || s.status })),
    days,
  });
});

r.get('/integrations', (_req, res) => {
  res.json({
    payments: { mode: razorpay.mode(), env: razorpay.environment(), provider: config.payments.provider, explicit: config.payments.explicit,
      problem: razorpay.problem(), webhookSecret: Boolean(config.razorpay.webhookSecret), webhookUrl: `${config.appUrl}/api/webhooks/razorpay` },
    shipping: { shiprocket: shiprocket.isEnabled(), pickupLocation: config.shiprocket.pickupLocation, pickupPincode: config.pickupPincode,
      webhookToken: Boolean(config.shiprocket.webhookToken), webhookUrl: `${config.appUrl}/api/webhooks/courier-tracking`, feeMode: config.shipping.feeMode,
      bookingAllowed: shiprocket.bookingAllowed(), parcel: config.parcel },
    email: { provider: config.email.resendKey ? 'resend' : null, from: config.email.from, ownerAlerts: Boolean(config.email.owner) },
    database: { provider: 'postgres', host: (() => { try { return new URL(config.db.url).hostname; } catch { return ''; } })(), ssl: Boolean(config.db.ssl) },
    storage: { provider: storage.isRemote() ? 'supabase' : 'local', buckets: config.supabase.buckets },
  });
});

/* ───────── image validation (by magic bytes, never by the claimed type) ───────── */
const SIGS = [
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', type: 'image/webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  { ext: 'avif', type: 'image/avif', test: (b) => b.subarray(4, 12).toString() === 'ftypavif' },
];
function decodeImage(f, maxBytes = 10 * 1024 * 1024) {
  const m = /^data:[\w/+.-]+;base64,(.+)$/.exec(String(f?.dataUrl || ''));
  if (!m) throw bad('Invalid image data');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > maxBytes) throw bad(`${f.name || 'Image'} is larger than ${Math.round(maxBytes / 1048576)} MB`);
  const sig = SIGS.find((s) => s.test(buf));
  if (!sig) throw bad(`${f.name || 'Image'} is not a JPG, PNG, WebP or AVIF`);
  return { buf, ...sig };
}

/* ───────── direct uploads (browser → Supabase Storage; see storage.createSignedUpload) ───────── */
const UPLOAD_TARGETS = {
  gallery: { table: 'products', bucket: () => config.supabase.buckets.products, maxBytes: 10 * 1024 * 1024 },
  angle: { table: 'products', bucket: () => config.supabase.buckets.angles, maxBytes: 10 * 1024 * 1024 },
  category: { table: 'categories', bucket: () => config.supabase.buckets.categories, maxBytes: 5 * 1024 * 1024 },
};

r.post('/uploads/sign', async (req, res) => {
  const target = UPLOAD_TARGETS[req.body?.target];
  if (!target) throw bad('Unknown upload target');
  const id = idParam(req.body?.id);
  if (!(await one(`SELECT 1 FROM ${target.table} WHERE id = ?`, id))) throw notFound();
  // Without Supabase Storage (local development) the browser sends the image through the server as before.
  if (!storage.isRemote()) return res.json({ direct: false });
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 72) : [];
  if (!files.length) throw bad('No images received');
  const uploads = [];
  for (const f of files) {
    const name = String(f?.name || 'Image').slice(0, 120);
    try {
      uploads.push(await storage.createSignedUpload({ bucket: target.bucket(), folder: id, contentType: String(f?.type || ''), size: Number(f?.size), maxBytes: target.maxBytes }));
    } catch (e) {
      if (e.status === 400) throw bad(`${name} ${e.message}`);
      throw e;
    }
  }
  res.json({ direct: true, uploads });
});

/**
 * Turn upload tickets into verified images: each object must exist, be within the size limit and really be the
 * declared image type (magic bytes). If any fails, every object of the batch is deleted and nothing is attached.
 */
async function claimUploads(list, { bucket, folder, maxBytes }) {
  const tickets = list.map((u) => ({ ...storage.readUploadTicket(u?.ticket, { bucket, folder }), alt: String(u?.alt || '').slice(0, 140) }));
  const dropAll = () => Promise.all(tickets.map((t) => storage.removeObject(t.bucket, t.objectPath).catch(() => {})));
  try {
    const out = [];
    for (const t of tickets) {
      const url = storage.publicUrl(t.bucket, t.objectPath);
      if (await one('SELECT 1 FROM product_images WHERE url = ? UNION ALL SELECT 1 FROM categories WHERE image_url = ?', url, url)) {
        throw conflict('That image has already been added');
      }
      const buf = await storage.getObject(t.bucket, t.objectPath);
      if (!buf) throw bad('An image did not finish uploading — please try again');
      if (buf.length > maxBytes) throw bad(`An image is larger than ${Math.round(maxBytes / 1048576)} MB`);
      const sig = SIGS.find((s) => s.test(buf));
      if (!sig || sig.type !== t.contentType) throw bad('An uploaded file is not the JPG, PNG, WebP or AVIF image it claimed to be');
      out.push({ url, alt: t.alt });
    }
    return out;
  } catch (e) {
    if (e.status !== 409) await dropAll(); // a duplicate claim must not delete the image already in use
    throw e;
  }
}

/* ───────── categories ───────── */
const categoryRules = { name: { required: true, max: 60 }, slug: { max: 60 }, description: { max: 300 }, icon: { max: 30 }, sortOrder: { type: 'int', default: 0 } };
r.get('/categories', async (_req, res) => res.json(await catalog.listCategories()));
r.post('/categories', async (req, res) => {
  const v = validate(req.body, categoryRules);
  const slug = slugify(v.slug || v.name);
  try {
    const { id } = await run('INSERT INTO categories(slug, name, description, icon, sort_order) VALUES (?,?,?,?,?)', slug, v.name, v.description, v.icon || 'heart', v.sortOrder);
    res.status(201).json({ id });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A category with that slug exists');
    throw e;
  }
});
r.put('/categories/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const v = validate(req.body, categoryRules);
  const slug = slugify(v.slug || v.name);
  try {
    await run('UPDATE categories SET slug=?, name=?, description=?, icon=?, sort_order=? WHERE id = ?', slug, v.name, v.description, v.icon || 'heart', v.sortOrder, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Another category uses that slug');
    throw e;
  }
  res.json({ ok: true });
});
r.delete('/categories/:id', async (req, res) => {
  const c = await one('DELETE FROM categories WHERE id = ? RETURNING image_url', idParam(req.params.id));
  if (c?.image_url) await storage.removeImage(c.image_url).catch(() => {});
  res.json({ ok: true });
});
r.post('/categories/:id/image', async (req, res) => {
  const id = idParam(req.params.id);
  const c = await one('SELECT * FROM categories WHERE id = ?', id);
  if (!c) throw notFound();
  let url;
  if (req.body?.ticket) {
    [{ url }] = await claimUploads([req.body], { bucket: config.supabase.buckets.categories, folder: id, maxBytes: UPLOAD_TARGETS.category.maxBytes });
  } else {
    const img = decodeImage(req.body, 5 * 1024 * 1024);
    url = await storage.putImage({ bucket: config.supabase.buckets.categories, folder: id, buffer: img.buf, ext: img.ext, contentType: img.type });
  }
  await run('UPDATE categories SET image_url = ? WHERE id = ?', url, id);
  if (c.image_url) await storage.removeImage(c.image_url).catch(() => {});
  res.status(201).json({ imageUrl: url });
});
r.delete('/categories/:id/image', async (req, res) => {
  const c = await one('SELECT * FROM categories WHERE id = ?', idParam(req.params.id));
  if (!c) throw notFound();
  await run('UPDATE categories SET image_url = NULL WHERE id = ?', c.id);
  if (c.image_url) await storage.removeImage(c.image_url).catch(() => {});
  res.json({ ok: true });
});

/* ───────── products ───────── */
r.get('/products', async (req, res) => res.json(await catalog.listProducts({ admin: true, q: req.query.q, category: req.query.category, limit: 1000 })));
r.get('/products/:id', async (req, res) => res.json(await catalog.getProduct(idParam(req.params.id), { admin: true })));

function productInput(body) {
  const v = validate(body, {
    name: { required: true, max: 100 }, slug: { max: 100 }, categoryId: { type: 'int' }, shortDesc: { max: 200 }, description: { max: 4000 },
    materials: { max: 300 }, dimensions: { max: 120 }, sku: { max: 60 }, stock: { type: 'int', min: 0, max: 100000, default: 0 },
    weightGrams: { type: 'int', min: 1, max: 5000, default: 30 }, isActive: { type: 'bool' }, isFeatured: { type: 'bool' }, soldOut: { type: 'bool' },
  });
  v.price = rupeesToPaise(body.price);
  v.comparePrice = body.comparePrice === '' || body.comparePrice == null ? null : rupeesToPaise(body.comparePrice);
  v.slug = slugify(v.slug || v.name);
  return v;
}

async function saveVariants(productId, variants) {
  if (!Array.isArray(variants)) return;
  const keep = [];
  for (const [i, raw] of variants.entries()) {
    const v = validate(raw, { id: { type: 'int' }, name: { required: true, max: 60 }, colorHex: { max: 9, pattern: /^#[0-9a-f]{3,8}$/i, message: 'Use a hex colour like #C96C80' },
      stock: { type: 'int', min: 0, max: 100000, default: 0 }, sku: { max: 60 }, isActive: { type: 'bool' } });
    const price = raw.price === '' || raw.price == null ? null : rupeesToPaise(raw.price);
    const active = raw.isActive === undefined ? true : v.isActive;
    if (v.id && (await one('SELECT 1 FROM product_variants WHERE id = ? AND product_id = ?', v.id, productId))) {
      await run('UPDATE product_variants SET name=?, color_hex=?, price=?, stock=?, sku=?, is_active=?, sort_order=? WHERE id = ?',
        v.name, v.colorHex, price, v.stock, v.sku, active, i, v.id);
      keep.push(v.id);
    } else {
      keep.push((await run('INSERT INTO product_variants(product_id, name, color_hex, price, stock, sku, is_active, sort_order) VALUES (?,?,?,?,?,?,?,?)',
        productId, v.name, v.colorHex, price, v.stock, v.sku, active, i)).id);
    }
  }
  // Variants that were removed: delete if never ordered, otherwise deactivate to keep order history intact.
  for (const old of await all('SELECT id FROM product_variants WHERE product_id = ?', productId)) {
    if (keep.includes(old.id)) continue;
    if (await one('SELECT 1 FROM order_items WHERE variant_id = ?', old.id)) await run('UPDATE product_variants SET is_active = false WHERE id = ?', old.id);
    else await run('DELETE FROM product_variants WHERE id = ?', old.id);
  }
}

const slugTaken = (e) => isUniqueViolation(e) && /slug/.test(e.constraint || e.detail || '');

r.post('/products', async (req, res) => {
  const v = productInput(req.body);
  let id;
  try {
    id = await tx(async () => {
      const { id: pid } = await run(`INSERT INTO products(slug, name, category_id, short_desc, description, materials, dimensions, price, compare_price, stock, sku, weight_grams, is_active, is_featured, sold_out)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, v.slug, v.name, v.categoryId, v.shortDesc || '', v.description || '', v.materials || '', v.dimensions || '',
      v.price, v.comparePrice, v.stock, v.sku, v.weightGrams, req.body.isActive === undefined ? true : v.isActive, v.isFeatured, v.soldOut);
      await saveVariants(pid, req.body.variants);
      return pid;
    });
  } catch (e) {
    if (slugTaken(e)) throw conflict('Another product already uses that URL name (slug)');
    throw e;
  }
  res.status(201).json(await catalog.getProduct(id, { admin: true }));
});

r.put('/products/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const v = productInput(req.body);
  try {
    await tx(async () => {
      const u = await run(`UPDATE products SET slug=?, name=?, category_id=?, short_desc=?, description=?, materials=?, dimensions=?, price=?, compare_price=?, stock=?, sku=?,
           weight_grams=?, is_active=?, is_featured=?, sold_out=?, updated_at = now() WHERE id = ?`,
      v.slug, v.name, v.categoryId, v.shortDesc || '', v.description || '', v.materials || '', v.dimensions || '', v.price, v.comparePrice, v.stock, v.sku,
      v.weightGrams, v.isActive, v.isFeatured, v.soldOut, id);
      if (!u.changes) throw notFound();
      await saveVariants(id, req.body.variants);
    });
  } catch (e) {
    if (slugTaken(e)) throw conflict('Another product already uses that URL name (slug)');
    throw e;
  }
  res.json(await catalog.getProduct(id, { admin: true }));
});

r.patch('/products/:id/stock', async (req, res) => {
  const id = idParam(req.params.id);
  const { stock, soldOut } = req.body || {};
  await tx(async () => {
    if (stock != null) {
      const n = Number(stock);
      if (!Number.isInteger(n) || n < 0) throw bad('Stock must be 0 or more');
      const p = await one('SELECT stock FROM products WHERE id = ? FOR UPDATE', id);
      if (!p) throw notFound();
      await run('UPDATE products SET stock = ?, updated_at = now() WHERE id = ?', n, id);
      await run("INSERT INTO inventory_movements(product_id, delta, reason) VALUES (?,?,'adjust')", id, n - p.stock);
    }
    if (soldOut != null) await run('UPDATE products SET sold_out = ? WHERE id = ?', Boolean(soldOut), id);
  });
  res.json(await catalog.getProduct(id, { admin: true }));
});

r.delete('/products/:id', async (req, res) => {
  const id = idParam(req.params.id);
  // Products with order history are archived (hidden) rather than deleted, preserving past orders.
  if (await one('SELECT 1 FROM order_items WHERE product_id = ?', id)) {
    await run('UPDATE products SET is_active = false WHERE id = ?', id);
    return res.json({ ok: true, archived: true });
  }
  const imgs = await all('SELECT url FROM product_images WHERE product_id = ?', id);
  await run('DELETE FROM products WHERE id = ?', id);
  for (const img of imgs) await storage.removeImage(img.url).catch(() => {});
  res.json({ ok: true, deleted: true });
});

/* ───────── product images → Supabase Storage (product-images / product-360 buckets) ───────── */
r.post('/products/:id/images', express.json({ limit: '60mb' }), async (req, res) => {
  const pid = idParam(req.params.id);
  if (!(await one('SELECT 1 FROM products WHERE id = ?', pid))) throw notFound();
  const kind = req.body?.kind === 'angle' ? 'angle' : 'gallery';
  const bucket = kind === 'angle' ? config.supabase.buckets.angles : config.supabase.buckets.products;
  const direct = Array.isArray(req.body?.uploads) ? req.body.uploads.slice(0, 72) : [];
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 72) : [];
  if (!direct.length && !files.length) throw bad('No images received');
  let uploaded = [];
  if (direct.length) {
    // Already in Supabase Storage (uploaded by the browser) — verify them, then attach.
    uploaded = await claimUploads(direct, { bucket, folder: pid, maxBytes: UPLOAD_TARGETS[kind].maxBytes });
  }
  const decoded = files.map((f) => ({ ...decodeImage(f), alt: String(f.alt || '').slice(0, 140) })); // validate all before uploading any
  try {
    for (const d of decoded) {
      uploaded.push({ url: await storage.putImage({ bucket, folder: pid, buffer: d.buf, ext: d.ext, contentType: d.type }), alt: d.alt });
    }
    await tx(async () => {
      let { m: sort } = await one('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_images WHERE product_id = ? AND kind = ?', pid, kind);
      for (const u of uploaded) {
        await run('INSERT INTO product_images(product_id, url, alt, kind, sort_order) VALUES (?,?,?,?,?)', pid, u.url, u.alt, kind, ++sort);
      }
    });
  } catch (e) {
    for (const u of uploaded) await storage.removeImage(u.url).catch(() => {}); // don't leave orphaned files behind
    throw e;
  }
  res.status(201).json(await catalog.getProduct(pid, { admin: true }));
});

r.put('/products/:id/images/order', async (req, res) => {
  const pid = idParam(req.params.id);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isSafeInteger) : [];
  await tx(async () => {
    for (const [i, id] of ids.entries()) await run('UPDATE product_images SET sort_order = ? WHERE id = ? AND product_id = ?', i, id, pid);
  });
  res.json(await catalog.getProduct(pid, { admin: true }));
});

r.delete('/products/:id/images/:imageId', async (req, res) => {
  const pid = idParam(req.params.id);
  const img = await one('DELETE FROM product_images WHERE id = ? AND product_id = ? RETURNING url', idParam(req.params.imageId), pid);
  if (!img) throw notFound();
  // Keep the file if an order snapshot still shows it.
  if (!(await one('SELECT 1 FROM order_items WHERE image_url = ?', img.url))) await storage.removeImage(img.url).catch(() => {});
  res.json(await catalog.getProduct(pid, { admin: true }));
});

/* ───────── orders ───────── */
r.get('/orders', async (req, res) => {
  const { q, status, payment, shipping, from, to, page = 1 } = req.query;
  const where = [];
  const p = [];
  if (req.query.includeAbandoned !== '1') where.push("o.status <> 'abandoned'");
  if (q) {
    where.push('(o.order_number ILIKE ? OR o.customer_name ILIKE ? OR o.customer_email ILIKE ? OR o.customer_phone ILIKE ? OR s.awb_code ILIKE ?)');
    p.push(...Array(5).fill(`%${String(q).slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  }
  if (status) { where.push('o.status = ?'); p.push(String(status)); }
  if (payment) { where.push('o.payment_status = ?'); p.push(String(payment)); }
  if (shipping === 'none') where.push('s.id IS NULL');
  else if (shipping) { where.push('s.status ILIKE ?'); p.push(`%${String(shipping).slice(0, 40)}%`); }
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (isDate(from)) { where.push(`(o.created_at AT TIME ZONE '${SHOP_TZ}')::date >= ?::date`); p.push(from); }
  if (isDate(to)) { where.push(`(o.created_at AT TIME ZONE '${SHOP_TZ}')::date <= ?::date`); p.push(to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = 50;
  const pageNo = Math.max(1, Number(page) || 1);
  const [rows, total] = await Promise.all([
    all(`SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.total, o.status, o.payment_status, o.created_at,
           s.courier_name, s.awb_code, s.status AS shipment_status,
           (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS items
         FROM orders o LEFT JOIN shipments s ON s.order_id = o.id ${w} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...p, limit, (pageNo - 1) * limit),
    one(`SELECT COUNT(*) AS n FROM orders o LEFT JOIN shipments s ON s.order_id = o.id ${w}`, ...p),
  ]);
  res.json({ rows: rows.map((x) => ({ ...x, statusLabel: STATUS_LABELS[x.status] })), total: total.n, page: pageNo, pages: Math.ceil(total.n / limit) });
});

const orderByNumber = async (n) => {
  const o = await one('SELECT id FROM orders WHERE order_number = ?', String(n));
  if (!o) throw notFound('Order not found');
  return o.id;
};

r.get('/orders/:number', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  const detail = await orderDetail(id, { admin: true });
  detail.notifications = await all('SELECT type, recipient, subject, status, error, created_at FROM notifications WHERE order_id = ? ORDER BY id', id);
  res.json(detail);
});

r.post('/orders/:number/status', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  const to = String(req.body?.status || '');
  if (to === 'cancelled') throw bad('Use the Cancel order action (it handles shipment cancellation and refunds)');
  await transition(id, to, { note: String(req.body?.note || '').slice(0, 300) || null, actor: `admin:${req.user.email}` });
  res.json(await orderDetail(id, { admin: true }));
});

r.get('/orders/:number/couriers', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  res.json(await fulfillment.couriersForOrder(id)); // rates for the order's real parcel (weight + box size)
});

r.post('/orders/:number/label', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  await fulfillment.regenerateLabel(id);
  res.json(await orderDetail(id, { admin: true }));
});

/** Check the Shiprocket connection and pickup location — read-only, never books anything. */
r.post('/shipping/check', async (_req, res) => {
  if (!shiprocket.isEnabled()) return res.json({ ok: false, problem: 'Shiprocket is not configured (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD)' });
  try {
    const list = await shiprocket.pickupLocations({ fresh: true });
    const pickup = list.find((p) => p.name === config.shiprocket.pickupLocation) || null;
    const pinMismatch = Boolean(pickup && config.pickupPincode && config.pickupPincode !== pickup.pincode);
    res.json({
      ok: Boolean(pickup), login: true, pickupLocation: config.shiprocket.pickupLocation, pickup,
      available: list.map((p) => p.name),
      problem: pickup ? null : `Pickup location "${config.shiprocket.pickupLocation}" not found in Shiprocket`,
      warning: pinMismatch ? `PICKUP_PINCODE (${config.pickupPincode}) differs from the PIN registered in Shiprocket (${pickup.pincode}); Shiprocket's is used` : null,
      bookingAllowed: shiprocket.bookingAllowed(),
    });
  } catch (e) {
    res.json({ ok: false, login: !/login failed/i.test(e.message), problem: e.message });
  }
});

r.post('/orders/:number/ship', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  await fulfillment.createShiprocketShipment(id, { courierId: req.body?.courierId || undefined });
  res.json(await orderDetail(id, { admin: true }));
});

r.post('/orders/:number/manual-shipment', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  const v = validate(req.body, { courierName: { required: true, max: 60 }, awb: { required: true, max: 60 }, trackingUrl: { max: 300, pattern: /^https?:\/\//, message: 'Must start with http(s)://' } });
  await fulfillment.recordManualShipment(id, v);
  res.json(await orderDetail(id, { admin: true }));
});

r.post('/orders/:number/sync-tracking', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  await fulfillment.syncTracking(id);
  res.json(await orderDetail(id, { admin: true }));
});

r.post('/orders/:number/cancel', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  await fulfillment.cancelOrder(id, { reason: String(req.body?.reason || '').slice(0, 300), refund: req.body?.refund !== false });
  res.json(await orderDetail(id, { admin: true }));
});

r.post('/orders/:number/refund', async (req, res) => {
  const id = await orderByNumber(req.params.number);
  const amount = req.body?.amount ? rupeesToPaise(req.body.amount) : undefined;
  await fulfillment.refundOrder(id, { amount, reason: String(req.body?.reason || '').slice(0, 300) });
  res.json(await orderDetail(id, { admin: true }));
});

r.get('/notifications', async (_req, res) => {
  res.json(await all('SELECT n.*, o.order_number FROM notifications n LEFT JOIN orders o ON o.id = n.order_id ORDER BY n.id DESC LIMIT 200'));
});

/** The email as HTML (re-rendered from the order now — see notifications.previewEmail). Opens in a new tab. */
r.get('/notifications/:id/preview', async (req, res) => {
  const p = await previewEmail(idParam(req.params.id));
  if (!p) throw notFound();
  // Email HTML has no scripts; forbid them outright and keep it out of caches.
  res.set({ 'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com", 'Cache-Control': 'no-store' });
  res.type('html').send(p.html);
});

export default r;
