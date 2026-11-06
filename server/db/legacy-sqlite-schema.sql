-- LEGACY: the original SQLite schema, kept only as a reference for scripts/migrate-sqlite-to-supabase.js.
-- The live schema is supabase/migrations/*.sql (PostgreSQL).
-- Velberry schema. All money values are integer paise (₹1 = 100).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addresses (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  line1      TEXT NOT NULL,
  line2      TEXT,
  city       TEXT NOT NULL,
  state      TEXT NOT NULL,
  pincode    TEXT NOT NULL CHECK (length(pincode) = 6),
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT NOT NULL DEFAULT 'heart',
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  short_desc    TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  materials     TEXT NOT NULL DEFAULT '',
  dimensions    TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL CHECK (price >= 0),
  compare_price INTEGER CHECK (compare_price IS NULL OR compare_price >= 0),
  stock         INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku           TEXT,
  weight_grams  INTEGER NOT NULL DEFAULT 30,
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_featured   INTEGER NOT NULL DEFAULT 0,
  sold_out      INTEGER NOT NULL DEFAULT 0, -- manual "sold out" switch
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- kind: 'gallery' photos, or 'angle' frames for the 360° spin viewer (ordered by sort_order)
CREATE TABLE IF NOT EXISTS product_images (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  alt        TEXT,
  kind       TEXT NOT NULL DEFAULT 'gallery' CHECK (kind IN ('gallery','angle')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- When a product has variants, inventory lives on the variants.
CREATE TABLE IF NOT EXISTS product_variants (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color_hex  TEXT,
  price      INTEGER CHECK (price IS NULL OR price >= 0), -- NULL = product price
  stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku        TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL, -- reserve | release | restock | adjust
  order_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS carts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  guest_token TEXT UNIQUE,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id         INTEGER PRIMARY KEY,
  cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_unique ON cart_items(cart_id, product_id, IFNULL(variant_id, 0));

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY,
  order_number     TEXT NOT NULL UNIQUE,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key  TEXT UNIQUE,
  access_token_hash TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending_payment',
  payment_status   TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded','partially_refunded','expired')),
  customer_name    TEXT NOT NULL,
  customer_email   TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  ship_name        TEXT NOT NULL,
  ship_phone       TEXT NOT NULL,
  ship_line1       TEXT NOT NULL,
  ship_line2       TEXT,
  ship_city        TEXT NOT NULL,
  ship_state       TEXT NOT NULL,
  ship_pincode     TEXT NOT NULL,
  subtotal         INTEGER NOT NULL,
  shipping_fee     INTEGER NOT NULL,
  total            INTEGER NOT NULL,
  gift_note        TEXT,
  stock_reserved   INTEGER NOT NULL DEFAULT 1,
  razorpay_order_id TEXT UNIQUE,
  expires_at       TEXT,
  paid_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);

-- Historical snapshot: never joins back to live prices.
CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant_id   INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  variant_name TEXT,
  sku          TEXT,
  image_url    TEXT,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  line_total   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  actor       TEXT NOT NULL DEFAULT 'system',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY,
  order_id            INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'razorpay',
  provider_order_id   TEXT,
  provider_payment_id TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL, -- captured | authorized | failed
  method              TEXT,
  amount              INTEGER NOT NULL,
  error_reason        TEXT,
  raw                 TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id                 INTEGER PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id         INTEGER NOT NULL REFERENCES payments(id),
  provider_refund_id TEXT UNIQUE,
  amount             INTEGER NOT NULL CHECK (amount > 0),
  status             TEXT NOT NULL, -- pending | processed | failed
  reason             TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipments (
  id                  INTEGER PRIMARY KEY,
  order_id            INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL, -- shiprocket | manual
  provider_order_id   TEXT,
  provider_shipment_id TEXT,
  awb_code            TEXT,
  courier_name        TEXT,
  courier_id          TEXT,
  status              TEXT NOT NULL DEFAULT 'created',
  pickup_scheduled_at TEXT,
  etd                 TEXT,
  tracking_url        TEXT,
  label_url           TEXT,
  last_synced_at      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracking_events (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  occurred_at TEXT NOT NULL,
  source      TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'email',
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL, -- sent | failed | logged (no provider configured)
  provider_id TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- one email per (order, type) except tracking updates which carry their own suffix
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once ON notifications(order_id, type) WHERE status != 'failed';

CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  event_type  TEXT,
  payload     TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
