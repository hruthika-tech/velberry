-- ═══════════════════════════════════════════════════════════════════════════
-- Velberry — Row Level Security
--
-- How access works:
--   • The browser NEVER talks to Supabase directly. All reads and writes go through the
--     Velberry server, which connects with a privileged role (DATABASE_URL / service key)
--     and enforces "customers see only their own data" and "admins only" in its API layer.
--   • RLS is therefore a second wall: anyone holding the public anon/publishable key can
--     read the live catalogue and NOTHING else. Users, sessions, carts, addresses, orders,
--     payments, refunds, shipments, tracking, emails, webhooks and settings have no
--     policies for anon/authenticated, which means every row is denied to them.
--   • The `postgres` and `service_role` roles bypass RLS (Supabase default), so the server
--     keeps full access.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'users','sessions','addresses','categories','products','product_images','product_variants','inventory_movements',
    'carts','cart_items','orders','order_items','order_status_history','payments','refunds','shipments',
    'tracking_events','notifications','webhook_events','settings'
  ] loop
    -- ENABLE (not FORCE): the table owner — the role the server connects as — keeps full access.
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Private tables: strip the default Data-API grants as well, so they are invisible even if a policy is added by mistake.
do $$
declare t text;
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    foreach t in array array[
      'users','sessions','addresses','inventory_movements','carts','cart_items','orders','order_items',
      'order_status_history','payments','refunds','shipments','tracking_events','notifications','webhook_events','settings'
    ] loop
      execute format('revoke all on table %I from anon, authenticated', t);
    end loop;
    -- Catalogue tables: read-only for the public roles.
    foreach t in array array['categories','products','product_images','product_variants'] loop
      execute format('revoke insert, update, delete, truncate on table %I from anon, authenticated', t);
      execute format('grant select on table %I to anon, authenticated', t);
    end loop;
  end if;
end $$;

-- Public catalogue policies (read-only, live items only).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    drop policy if exists "Public can read categories" on categories;
    create policy "Public can read categories" on categories
      for select to anon, authenticated using (true);

    drop policy if exists "Public can read live products" on products;
    create policy "Public can read live products" on products
      for select to anon, authenticated using (is_active);

    drop policy if exists "Public can read images of live products" on product_images;
    create policy "Public can read images of live products" on product_images
      for select to anon, authenticated
      using (exists (select 1 from products p where p.id = product_images.product_id and p.is_active));

    drop policy if exists "Public can read live variants" on product_variants;
    create policy "Public can read live variants" on product_variants
      for select to anon, authenticated
      using (is_active and exists (select 1 from products p where p.id = product_variants.product_id and p.is_active));
  end if;
end $$;

-- The server role must be able to bypass RLS. On Supabase, `postgres` and `service_role` already have BYPASSRLS.
-- (If you connect with a custom role instead, grant it: ALTER ROLE your_role BYPASSRLS;)
