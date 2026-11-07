# CLAYSLAY 🍓 — handmade clay keychain boutique

A complete e-commerce site for CLAYSLAY (www.clayslay.in, formerly “Velberry”): storefront, bag, checkout with Razorpay, Shiprocket shipping and tracking, customer accounts, branded emails, and an admin studio.

**Stack:** Node.js ≥ 22.13 + Express 5, **Supabase PostgreSQL** (via `pg`), **Supabase Storage** for product photos, and a vanilla ES-module frontend with no build step. The homepage 3D charm uses three.js.

> Internal names (the `velberry` package, `velberry.css`, `data/velberry.db`, the `vb_session` cookie, `VB-` order numbers, `VELBERRY_*` settings) are kept from the original brand on purpose: renaming them would log customers out, break links or change existing records.
>
> The shop originally ran on SQLite (`data/velberry.db`). That file is kept untouched; section 2 explains how to copy it into Supabase.

---

## 1. Run it locally

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm start                 # or: npm run dev  (auto-restarts on changes)
```

Open http://localhost:3000.

- **Database:** set `DATABASE_URL` to your Supabase project (section 2), or, for offline development, to a local Postgres:
  ```bash
  docker run -d --name velberry-pg -e POSTGRES_PASSWORD=localdev -p 54329:5432 postgres:17-alpine
  # DATABASE_URL=postgres://postgres:localdev@127.0.0.1:54329/postgres
  ```
  The tables are created on first start (or with `npm run db:migrate`).
- **Starter catalogue:** 18 charms in 8 categories, seeded automatically **only if the products table is empty**.
- **Images:** without Supabase Storage configured (development only), uploads are saved to `public/uploads/products/`.
- **Admin:** http://localhost:3000/admin/. Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | End-to-end tests, each file on its own throwaway Postgres database (needs the Docker Postgres above, or `TEST_DATABASE_URL`). Covers cart, stock reservation and races, idempotency, signature checks, webhooks, refunds, admin, and the SQLite migration |
| `npm run db:migrate` | Create/update the database tables (`supabase/migrations/*.sql`) without starting the shop |
| `npm run setup-storage` | Create/check the Supabase Storage buckets |
| `npm run migrate:sqlite -- --dry-run` | Preview copying `data/velberry.db` into PostgreSQL (writes nothing) |
| `npm run migrate:sqlite` | Copy `data/velberry.db` into PostgreSQL + images into Storage |
| `npm run seed -- --force` | Wipe and reseed the starter catalogue (orders are kept) |

> **Production guard.** `db:migrate`, `setup-storage`, `seed`, `create-admin`, `migrate:sqlite` and `npm start` find out which Supabase project they're pointed at. If it's the one named in `PRODUCTION_SUPABASE_REF`, they stop and change nothing unless you add `-- --production` (for example `npm run db:migrate -- --production`). If `PRODUCTION_SUPABASE_REF` isn't set, they refuse every Supabase project rather than guess. A local Docker database needs no flag. Permission only ever comes from the command-line flag, never from `.env`.
>
> Two extra rules:
> - **`npm start`** on Production without the flag runs no migrations or seeding. If migrations are pending, it refuses to start.
> - **`create-admin`** never changes an existing *customer* account unless you add `--promote-existing`, and it no longer creates tables: run `db:migrate` first.
>
> **`migrate:sqlite`** into a Production database that already holds data also needs `--force-into-nonempty`, because re-importing could bring back records deleted since.
| `npm run create-admin -- you@example.com "a strong password" "Your Name"` | Create or promote an admin |
| `node scripts/generate-art.js` | Regenerate the placeholder product artwork |

### Test mode (before you have Razorpay keys)

While `RAZORPAY_KEY_ID` is empty and `ALLOW_MOCK_PAYMENTS=true`, checkout uses a clearly labelled local payment simulator, so you can walk the whole journey, envelope included.

- The simulator signs payments with a server-only secret and goes through the **same** verification code as real payments.
- It **cannot** run when `NODE_ENV=production`.

---

## 2. Supabase: database and image storage

The server talks to Supabase directly with a server-side connection. The browser **never** talks to Supabase, so customers can't see anything the server doesn't hand them. Logins keep using the shop's own accounts (scrypt passwords + sessions), not Supabase Auth, so existing customer passwords keep working.

### 2.1 Create the project

1. Sign in at https://supabase.com → **New project**.
2. Pick a name (e.g. `velberry`), a **strong database password** (save it in your password manager), and the region closest to your customers, e.g. **South Asia (Mumbai)**.
3. Wait until the project shows as healthy.

### 2.2 Fill in `.env`

| Variable | Where to find it |
|---|---|
| `DATABASE_URL` | Top bar **Connect** → **Session pooler** → copy the URI, replace `[YOUR-PASSWORD]`. Use the **Session pooler (port 5432)** or **Direct connection**, *not* the Transaction pooler (6543): the server uses session-level locks. Special characters in the password must be URL-encoded (`@` → `%40`, `#` → `%23`). |
| `DATABASE_SSL` | Leave `require` (encrypted). For certificate verification as well: download the CA from **Project Settings → Database → SSL Configuration**, set `DATABASE_SSL=verify` and `DATABASE_CA_CERT=/path/to/prod-ca-2021.crt`. |
| `SUPABASE_URL` | **Project Settings → Data API** → Project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Project Settings → API Keys** → **Secret key** (`sb_secret_…`, or the legacy `service_role` key). **Server only, never share it.** |
| `SUPABASE_ANON_KEY` | *Optional.* Same page → **Publishable key** (`sb_publishable_…` / legacy `anon`). Only used by `setup-storage` to prove the public key cannot upload. |

### 2.3 Create the tables

```bash
npm run db:migrate
```

This applies `supabase/migrations/001_schema.sql` (all tables, constraints such as "stock can never go below 0") and `002_rls.sql`. The latter enables **Row Level Security on every table**: the public key can read only live catalogue items, and users, orders, payments, addresses, sessions etc. have no public access at all. Applied migrations are recorded in `schema_migrations`, so re-running is safe. The server also runs this automatically on start.

### 2.4 Create the image buckets

```bash
npm run setup-storage
```

Creates (or corrects) three buckets: `product-images`, `product-360`, `category-images`. They are **public-read**, so the shop can show photos by URL, but have size limits and image-only file types. Uploading, replacing, deleting and listing files need the server's secret key. The script also:

- warns about any Storage policy that would let the public key write to or list these buckets;
- warns if some *other* bucket in the project is public;
- if `SUPABASE_ANON_KEY` is set, actually tries an anonymous upload and checks that it is refused.

Only catalogue artwork goes into Storage. Customer details, orders and invoices stay in the database, and shipping labels stay with Shiprocket.

### 2.5 Copy the existing SQLite data (one time)

> **Do this before the first `npm start` against Supabase.** On an empty database the server seeds the starter catalogue and an admin; the migration would then (correctly) refuse to overwrite those records.

```bash
npm run migrate:sqlite -- --dry-run     # preview: full run inside a transaction, then rolled back
npm run migrate:sqlite                  # the real thing
```

What it does:

- **Reads safely.** It reads a temporary *copy* of `data/velberry.db` (or `SQLITE_FILE` / `--sqlite <file>`). The original is never opened, and its sha256 fingerprint is checked before and after.
- **Copies every table with the same ids**, so orders still point at the same customers, products, styles, images, payments and history. It also fixes up types: 0/1 → true/false; SQLite `2026-11-04 16:06:23` (UTC) → proper timestamps; JSON text → `jsonb`; emails lowercased.
- **Is all-or-nothing.** Everything runs in **one transaction**, so either every row is copied or none is. ID counters are moved past the copied ids, so new orders don't collide.
- **Never overwrites anything.**
  - A row that already exists with identical content is skipped, so re-running is safe.
  - A row that exists with *different* content is reported as a conflict, and the whole run is rolled back.
  - In Storage, an existing object is never replaced: its bytes are compared and the URL is switched only if they match.
- **Moves images.** Local `/uploads/...` images are uploaded to Storage: starter art to `product-images/seed/…`, your photos to `product-images/migrated/…`, and 360° frames to `product-360/…`. Database image URLs (product photos and order snapshots) are switched **only for files that uploaded successfully**. Missing files keep their old URL and are listed as warnings. `--skip-images` leaves all URLs as they are; a later run without it uploads them then.
- **Reports in detail.** It prints per-table counts (in SQLite / added / already present / conflicts / errors), each image's result, and every warning and error. No passwords or keys are printed.

Exit code: `0` = success (or dry run OK), `1` = nothing was changed (see the listed problems).

### 2.6 Check that the migration worked

1. **Run `npm run migrate:sqlite` again.** It should say `0 rows added, N already present` with no conflicts. That proves every SQLite row is in PostgreSQL with identical content.
2. **Start the server.** `npm start` should print `database: Postgres @ …supabase.com` and `images: Supabase Storage`. Then open http://localhost:3000/healthz, which should show `{"ok":true,"db":"up","storage":"supabase"}`.
3. **Check the admin.** Log in at `/admin/` with your **existing** admin password. The dashboard revenue and order count should match the old shop, and **Orders** should list the same order numbers.
4. **Check the shop.** Product photos should load from `…supabase.co/storage/…` (right-click → open image). A customer can log in with their old password and see their order history, and order tracking works with the old order numbers.
5. **Check Supabase.** In **Table Editor**, the row counts should match the migration report. In **Storage**, the three buckets should contain the images.

Keep `data/velberry.db` as a backup until you're happy.

---

## 3. Integrations: what you need to configure

Every secret lives in `.env` on the server and never reaches the browser. The admin's **Setup & integrations** page shows live status for each one.

### Razorpay (payments) — required to take real money

1. **Choose the provider explicitly** in `.env`:
   ```
   PAYMENT_PROVIDER=razorpay   # or "mock" for the local simulator (never allowed in production)
   RAZORPAY_MODE=test          # "live" only after test payments, webhooks and reconciliation are proven
   ```
   If Razorpay is selected but anything is missing or mismatched, payments are **disabled** with the reason shown at startup and in **Admin → Setup**. It never falls back to the simulator, and in production the server refuses to start.
2. **API keys.** In the Razorpay Dashboard, switch to the matching **Test/Live** mode, go to **Account & Settings → API Keys**, generate keys, and set:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxx     # must start with rzp_test_ in test mode, rzp_live_ in live mode
   RAZORPAY_KEY_SECRET=xxx          # server-only
   ```
3. **Webhook.** Go to **Account & Settings → Webhooks → Add new webhook** (in the same mode):
   - **URL:** `https://YOUR-DOMAIN/api/webhooks/razorpay`. It must be public HTTPS: Razorpay cannot reach `localhost`. For local testing, use a tunnel (for example `cloudflared tunnel --url http://localhost:3000`) and use its URL.
   - **Events:** `payment.captured`, `payment.failed`, `order.paid` (optionally `payment.authorized`, `refund.processed`, `refund.failed`).
   - **Secret:** any long random string; put the same value in `RAZORPAY_WEBHOOK_SECRET` (required in live mode).
4. **Payment methods.** UPI, cards, netbanking, and wallets are switched on in your Razorpay dashboard, and Checkout shows whatever is enabled there.

How payments are kept safe:

- **Orders are priced on the server** from the database (integer paise, INR). Stock is reserved atomically, so two people can't buy the last piece. Client-supplied totals are ignored.
- **Duplicate orders are prevented.** Every checkout carries an idempotency key, and Razorpay order creation is locked per order, so double-clicks and retries return the same internal order and the same Razorpay order.
- **A payment counts as paid only after all checks pass:**
  - the Checkout signature (HMAC-SHA256) verifies against the Razorpay order ID **stored in our database**;
  - the payment fetched from Razorpay's API belongs to that order, is in INR, and is for the exact amount;
  - its status is **captured**. An authorized payment is captured first and re-checked; until then it is "pending", never paid.
  - The browser's "success" alone never marks an order paid.
- **Webhooks are a second confirmation path.**
  - They are signature-checked on the raw body and processed once per event ID, so they are safe to receive more than once and in any order.
  - A payment's stored status only moves forward, so a late or stale event can't downgrade a captured payment.
  - Only a redacted copy of each event is stored (no contact, card, bank or UPI details).
- **Abandoned checkouts are reconciled.** Unpaid checkouts expire after 30 minutes. Before releasing stock, the server asks Razorpay whether a payment went through:
  - captured payments are honoured;
  - authorized ones keep the order reserved;
  - if Razorpay can't be reached, nothing is released.
- **Late and paid-after-cancel payments.** A payment after expiry re-reserves the stock and is flagged in the order history. A payment for an order that's already cancelled is recorded and flagged for refund (Admin → order → "Issue refund via Razorpay"); the order is never revived.

### Shiprocket (shipping) — optional, but needed for automatic courier booking

1. **API user.** In Shiprocket, go to **Settings → API → Configure → Create an API User**, then set:
   ```
   SHIPROCKET_EMAIL=api-user@yourdomain.com
   SHIPROCKET_PASSWORD=xxx
   ```
2. **Pickup address.** Under **Settings → Pickup Addresses**, copy the *exact* nickname (case-sensitive) into `SHIPROCKET_PICKUP_LOCATION`. Its PIN code is read from Shiprocket and used for rates (`PICKUP_PINCODE` is only a fallback). **Admin → Setup → Check Shiprocket connection** confirms the login and the pickup location without booking anything.
3. **Tracking webhook.** Under **Settings → API → Webhooks**:
   - **URL:** `https://YOUR-DOMAIN/api/webhooks/courier-tracking` (Shiprocket rejects URLs containing the word "shiprocket")
   - **Token:** pick a value, put it in `SHIPROCKET_WEBHOOK_TOKEN`, and set it as the `x-api-key` header.
4. **Delivery fee.** `SHIPPING_FEE_MODE=flat` always charges `SHIPPING_FLAT_RATE`. `courier` charges Shiprocket's quoted rate. Either way, orders above `FREE_SHIPPING_ABOVE` ship free.
5. **Parcel.** Rates and bookings use your standard box (`SHIP_BOX_LENGTH_CM`, `SHIP_BOX_BREADTH_CM`, `SHIP_BOX_HEIGHT_CM`, default 12 × 10 × 6 cm) plus packing (`SHIP_PACKAGING_GRAMS`, default 50 g) plus each product's weight. Couriers bill the higher of actual and volumetric weight (L × B × H / 5000 kg); the courier list in the admin shows both.
6. **Booking switch.** Shiprocket has no test mode, so booking is **off outside production** unless `SHIPROCKET_ALLOW_BOOKING=true`. Rates, serviceability and tracking still work. In production it is on unless set to `false`.

With Shiprocket connected:

- **Checkout:** confirms the PIN code is serviceable before payment.
- **Booking:** one admin click creates the Shiprocket order, assigns the AWB and courier, schedules pickup, and fetches the label.
- **Tracking:** updates arrive by webhook and are also polled hourly. The order timeline moves automatically: shipped → out for delivery → delivered, plus failed-delivery and RTO handling.
- **Honest status:** a shipment is only recorded once Shiprocket confirms it.
- **Safe to retry:** one shipment per order; each confirmed step (Shiprocket order, AWB, pickup, label) is saved immediately. If a response from Shiprocket is lost, the retry finds what Shiprocket already did instead of booking twice. Only paid orders can be booked.
- **Tracking:** webhook + hourly poll. Every scan is kept once; a late or out-of-order update never moves an order backwards. Lost/damaged parcels are flagged in the order history. RTO ends in "Returned to us" with the stock put back; cancel + refund from there.
- **Cancellation:** before pickup, cancelling the order also cancels it at Shiprocket (safe to retry). After pickup it is refused.

Without Shiprocket, a flat rate is used. You can still use **Record manual shipment** on an order to enter a courier and AWB you booked yourself (for example, India Post).

### Resend (email) — optional, needed to actually send emails

1. Create an account at https://resend.com, verify your domain, and create an API key.
2. Set:
   ```
   RESEND_API_KEY=re_xxx
   EMAIL_FROM=CLAYSLAY <hello@yourdomain.com>
   SHOP_OWNER_EMAIL=you@yourdomain.com
   ```

**Emails sent:**
- Order and payment confirmation (plus a new-order alert to you)
- Order being prepared
- Shipped
- Tracking milestones
- Out for delivery
- Delivered
- Failed delivery and return-to-origin
- Cancelled, and refund initiated / processed

Each email goes out at most once per order. Until Resend is configured, nothing is sent: each email is listed in **Admin → Emails** as “logged”, with a **Preview** link that shows it as the customer would see it. Nothing is written to disk.

---

## 4. Your products and photos

The starter products use generated illustrations. To replace them:

1. **Admin → Products → (product) → Photos:** drag in your photographs (JPG, PNG, WebP, or AVIF, up to 10 MB each). The first photo is the cover; reorder with ‹ ›.
2. **360° view:** under **360° spin frames**, upload 12–36 photos taken on a turntable (same framing, every 10–30°). They're ordered by file name. With 8 or more frames, the product page gets a real drag-to-rotate 360° viewer.
   - Until then, the homepage "Take a Little Closer Look!" uses a real-time 3D model of the strawberry charm, not a rotated flat image.
3. **Styles (variations):** add colours or styles with their own stock, price, and SKU. When a product has styles, inventory is tracked per style.
4. **Today's Special (homepage curtain):** in **Admin → Today's Special**, choose three products, reorder or replace them, preview the board, and switch it on.
   - Visitors then first see closed floral curtains with a "Today's Special" board. "Open the Boutique" (or a tap on the board, ×, or Esc) draws the curtains and reveals the homepage.
   - It's shown again on each new visit, or at most once a day or week (your choice). Only a "seen" marker is stored in the visitor's browser.
   - If a chosen product is hidden or deleted, it drops off the public board and the admin page asks you to replace it.
5. **Past orders are safe:**
   - Changing a price never changes past orders, because each order stores a snapshot of names, prices, and images.
   - Deleting a product that has been ordered hides it instead.

---

## 5. Going live (deployment checklist)

- `NODE_ENV=production`
- `APP_URL=https://your-domain`, served over **HTTPS** (cookies are `Secure` in production).
- `SESSION_SECRET`: 32+ random characters.
- A strong `ADMIN_PASSWORD` (12+ characters). When creating the first admin in production, the server refuses the default or a short password. If you created the admin during local testing, change its password with `npm run create-admin`.
- Live Razorpay keys and the webhook set up as above.
- **Supabase** set up as in section 2: `DATABASE_URL` (Session pooler), `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. In production the server refuses to start without Supabase Storage, so photos never land on a disk that a redeploy would wipe.
- **Backups:** the database and photos live in Supabase. Check which backups your Supabase plan includes (**Database → Backups**), and keep your own copy with `pg_dump "$DATABASE_URL" > velberry-backup.sql`. Nothing the shop needs is kept on the server's disk.
- Keep secrets (`SUPABASE_SERVICE_ROLE_KEY`, database password, Razorpay/Shiprocket keys) in the host's environment settings, never in the repository.
- Run behind a reverse proxy or the platform's HTTPS. `trust proxy` is already enabled.

### 5.1 Deploying on Vercel

The repository is ready for Vercel (`vercel.json`, `api/index.js`, `scripts/vercel-build.js`):

- **Static pages** (`public/`) are served by Vercel's CDN with the same security headers as the Node server. **`/api/*` and `/healthz`** go to one serverless function running the same Express app.
- **Database migrations are never run automatically on Vercel.** Apply them yourself with `npm run db:migrate` (pointing `.env` at the database) **before** deploying code that needs them. Until then the API answers 503 (“being updated”) instead of running half-migrated.
- **Photos** go straight from the admin's browser to Supabase Storage with one-time signed URLs, because Vercel caps requests at 4.5 MB. The server checks the type and size first, then verifies the uploaded bytes before attaching the photo. Files that fail are deleted.
- **Emails** run after the response, and Vercel keeps the function alive for them (`waitUntil`).
- **Connections:** one shared pool per instance, `DB_POOL_MAX` 2 (3 for local development). On Vercel, idle connections close after 5 s (`DB_IDLE_TIMEOUT_MS`), and Vercel's `attachDatabasePool` keeps a finished instance awake just long enough to close them, so a suspended instance doesn't keep holding Supabase pooler slots. A locked operation (booking, refund, cancel) uses a single connection however deeply it nests.
- **Scheduled jobs** are `/api/cron/expire-checkouts`, `/api/cron/tracking-sync` and `/api/cron/all`. They require `Authorization: Bearer $CRON_SECRET`.
  - **Hobby plan:** Vercel Cron runs at most once a day. `vercel.json` schedules `/api/cron/all` at 03:00 IST, give or take an hour.
  - **Releasing stock without a 5-minute timer:** a new checkout or quote also releases expired checkouts, at most once per 5 minutes across all instances. Stock held by an abandoned checkout is freed before the next customer needs it.
  - **More frequent runs, for free:** `.github/workflows/scheduled-jobs.yml` calls the endpoints every 10 minutes (checkouts) and hourly (tracking) once you add the `VELBERRY_URL` and `CRON_SECRET` repository secrets. GitHub runs these best-effort, often a few minutes late.
  - **Pro plan:** you can instead change the Vercel schedule to `*/5 * * * *`.
  - **Tracking:** the Shiprocket webhook stays the main source of updates.
- **Preview safety (enforced at startup).** A Preview deployment refuses to start if:
  - `PAYMENT_PROVIDER` isn't `mock`;
  - any `RAZORPAY_*` variable is set;
  - `SHIPROCKET_ALLOW_BOOKING` is anything but `false`;
  - `RESEND_API_KEY` is set;
  - `FORBIDDEN_SUPABASE_REF` (the Production project's ref, Preview scope only) is missing or matches its database.

  Every deployment also refuses a `DATABASE_URL` and `SUPABASE_URL` from different Supabase projects.
- **Preview deployments** may use the payment simulator (`PAYMENT_PROVIDER=mock`), and Shiprocket booking is off there unless `SHIPROCKET_ALLOW_BOOKING=true`. The **production** deployment refuses the simulator. Vercel Cron only calls the production deployment.
- **`APP_URL`** defaults to the deployment's own https address. Set it to your real domain for Production.

---

## 6. Project map

```
server/
  index.js              Express app, security headers, routes, background jobs
  config.js             reads .env
  db/                   index.js (Postgres pool, transactions, locks, migrator), seed data, bootstrap (first admin),
                        legacy-sqlite-schema.sql (old schema, reference only)
  lib/                  auth (scrypt passwords, sessions, CSRF, rate limit), validation, errors
  services/
    catalog.js          products, categories, stock/availability
    cart.js             server-side bag for guests (cookie) & accounts (merged at login)
    orders.js           order state machine, stock reservation, idempotent payment marking, expiry
    razorpay.js         Razorpay API + signature checks (+ local test simulator)
    shiprocket.js       Shiprocket API client & status mapping
    shipping.js         PIN validation, serviceability, delivery fee
    fulfillment.js      shipments, tracking sync, refunds, cancellations
    notifications.js    email sending (Resend) with per-order de-duplication
    email-templates.js  branded HTML emails
    storage.js          Supabase Storage (images) with a local-disk fallback for development
  routes/               store (catalog/auth/cart/account/lookup), checkout, webhooks, admin
supabase/migrations/    001_schema.sql (all tables), 002_rls.sql (Row Level Security)
scripts/
  db-migrate.js         npm run db:migrate
  setup-storage.js      npm run setup-storage
  migrate-sqlite-to-supabase.js   npm run migrate:sqlite (one-time SQLite → Supabase copy)
  create-admin.js, generate-art.js
public/
  index.html …          storefront pages (home, shop, product, cart, checkout, order-success, track, account)
  css/                  velberry.css (design system), pages.css, envelope.css
  js/                   charms (SVG art), chain (decorative chains), spin360 (3D + photo spinner), ui, layout, pages/*
  admin/                admin studio (dashboard, orders, products, categories, emails, setup)
test/                   journey (end-to-end), concurrency (real parallel requests), migration (SQLite → Postgres + Storage)
```

### Order statuses

`pending_payment → paid → preparing → packed → ready_to_ship → shipped → out_for_delivery → delivered`

Side branches: `abandoned` (checkout expired), `cancelled`, `delivery_failed`, `rto_initiated → rto_delivered`.

Payment status is tracked separately: `pending`, `paid`, `failed`, `refunded`, `partially_refunded`, `expired`.
