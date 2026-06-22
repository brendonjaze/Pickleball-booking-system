-- db/migrations/2026-06-22-pricing-settings.sql
-- Run in the Supabase SQL editor. Safe to re-run (idempotent guards used).
-- Global time-based court pricing: one rate before cutoff_hour, another at/after.

-- ── 1. Config table (single row, id = 1) ─────────────────────────────────────
create table if not exists public.pricing_settings (
    id           int primary key default 1,
    daytime_rate numeric not null default 150,
    evening_rate numeric not null default 200,
    cutoff_hour  int     not null default 18,  -- 24h hour the evening rate begins (18 = 6 PM)
    constraint pricing_settings_single_row check (id = 1)
);

-- ── 2. Seed the single row (no-op if it already exists) ───────────────────────
insert into public.pricing_settings (id, daytime_rate, evening_rate, cutoff_hour)
values (1, 150, 200, 18)
on conflict (id) do nothing;

-- ── 3. Read access for the anon key (booking app reads with anon, same as courts) ──
grant select on public.pricing_settings to anon, authenticated;

alter table public.pricing_settings enable row level security;

drop policy if exists "pricing_settings read" on public.pricing_settings;
create policy "pricing_settings read"
    on public.pricing_settings for select
    to anon, authenticated
    using (true);

-- ── 4. Admin write access ─────────────────────────────────────────────────────
-- The admin panel writes directly to Supabase as the logged-in admin (the
-- `authenticated` role via its anon key + a Supabase Auth JWT), exactly like it
-- writes to `courts`. There is no service-role key in that app, so authenticated
-- writes must be allowed by RLS or saves silently no-op. The booking app never
-- authenticates users (anon only), so `authenticated` here effectively means an
-- admin. Insert is constrained to the single row (id = 1).
grant insert, update on public.pricing_settings to authenticated;

drop policy if exists "pricing_settings admin update" on public.pricing_settings;
create policy "pricing_settings admin update"
    on public.pricing_settings for update
    to authenticated
    using (true) with check (true);

drop policy if exists "pricing_settings admin insert" on public.pricing_settings;
create policy "pricing_settings admin insert"
    on public.pricing_settings for insert
    to authenticated
    with check (id = 1);
