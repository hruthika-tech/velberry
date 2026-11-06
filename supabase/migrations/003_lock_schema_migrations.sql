-- ═══════════════════════════════════════════════════════════════════════════
-- Velberry — close leftover default privileges for the public API roles
--
-- Supabase gives anon / authenticated ALL privileges on new tables in `public`.
-- 002_rls.sql revoked these on the shop's tables, but not on:
--   • public.schema_migrations — the server's internal migration log, created by the migrator itself,
--     where anon/authenticated were left with TRUNCATE, REFERENCES and TRIGGER (and RLS was off);
--   • the catalogue tables, which kept REFERENCES and TRIGGER next to the intended SELECT.
--
-- After this migration:
--   • the public roles have NO privileges on schema_migrations, and RLS is on (no policies → no rows);
--   • the public roles keep exactly SELECT on the catalogue (read through the existing RLS policies).
--
-- The server is unaffected: it connects as the table owner (`postgres`), which keeps all privileges and,
-- with RLS ENABLED (not FORCED), is not subject to row security. Explicit `public.` names are used because
-- Supabase also has auth.schema_migrations and realtime.schema_migrations, which this must not touch.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.schema_migrations enable row level security;

revoke all on table public.schema_migrations from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.schema_migrations from anon, authenticated;
    revoke references, trigger on table
      public.categories, public.products, public.product_images, public.product_variants
      from anon, authenticated;
  end if;
end $$;
