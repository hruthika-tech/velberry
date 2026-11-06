-- ═══════════════════════════════════════════════════════════════════════════
-- Velberry — "Today's Special" (the floral curtain introduction on the homepage)
--
-- One settings row (id = 1) holding the three chosen products, in display order.
--  • Slots reference existing products by id (no copies of products or images).
--  • If a product is ever hard-deleted, its slot simply becomes empty (ON DELETE SET NULL) and the admin
--    is asked to replace it. Products with order history are archived, not deleted; the server hides
--    archived products from the public board.
--  • A product can be chosen only once.
--
-- Access: the public API roles may read the row only while the special is published (is_active);
-- they can never change it. The shop server (table owner) reads and writes it, and only for
-- authenticated Velberry admins (checked by the server on every request).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists todays_special (
  id          smallint primary key default 1 check (id = 1),
  is_active   boolean not null default false,
  product_1   bigint references products(id) on delete set null,
  product_2   bigint references products(id) on delete set null,
  product_3   bigint references products(id) on delete set null,
  -- how often a visitor sees the closed curtains again: every new browsing session, once a day, or once a week
  show_again  text not null default 'session' check (show_again in ('session', 'day', 'week')),
  updated_at  timestamptz not null default now(),
  updated_by  bigint references users(id) on delete set null,
  constraint todays_special_distinct check (
    (product_1 is null or product_2 is null or product_1 <> product_2) and
    (product_1 is null or product_3 is null or product_1 <> product_3) and
    (product_2 is null or product_3 is null or product_2 <> product_3)
  )
);

insert into todays_special (id) values (1) on conflict (id) do nothing;

alter table todays_special enable row level security;
revoke all on table todays_special from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table todays_special from anon, authenticated;
    grant select on table todays_special to anon, authenticated;
    drop policy if exists "Public can read the published special" on todays_special;
    create policy "Public can read the published special" on todays_special
      for select to anon, authenticated using (is_active);
  end if;
end $$;
