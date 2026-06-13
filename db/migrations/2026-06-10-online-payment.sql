-- db/migrations/2026-06-10-online-payment.sql
-- Run in the Supabase SQL editor. Safe to re-run (idempotent guards used).

-- ── 0. VERIFY column types before running the rest ───────────────────────────
-- Inspect these and confirm p_session_id type in register_open_play matches
-- open_play_sessions.id (this file assumes bigint; switch to uuid if needed).
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_name in ('bookings','open_play_queue','open_play_sessions')
--   order by table_name, ordinal_position;

-- ── 1. COURT: one confirmed booking per (court, date, time_slot) ──────────────
-- finishBooking() already handles 23505, so this constraint MAY already exist.
-- Check for duplicates first; if this returns rows, resolve them before the index:
--   select court_id, date, time_slot, count(*) from public.bookings
--   group by 1,2,3 having count(*) > 1;
create unique index if not exists bookings_court_date_slot_uniq
    on public.bookings (court_id, date, time_slot);
-- NOTE: if booking cancellation is ever added, replace the line above with a
-- partial index, e.g. ... (court_id, date, time_slot) where status <> 'cancelled';

-- ── 2. OPEN PLAY: one registration per (session, mobile) ──────────────────────
-- Check for duplicates first; resolve if this returns rows:
--   select session_id, mobile, count(*) from public.open_play_queue
--   group by 1,2 having count(*) > 1;
create unique index if not exists open_play_queue_session_mobile_uniq
    on public.open_play_queue (session_id, mobile);

-- ── 3. Refund trail for paid-but-unfulfillable bookings ───────────────────────
create table if not exists public.booking_failures (
    id          bigint generated always as identity primary key,
    created_at  timestamptz not null default now(),
    type        text not null,            -- 'court' | 'openplay'
    booking_ref text,
    reason      text,                      -- 'slot_taken' | 'full' | ...
    payload     jsonb                      -- the webhook metadata, for refunding
);

-- ── 4. Atomic open-play registration (capacity-safe under concurrency) ────────
-- p_session_id type MUST match open_play_sessions.id (assumed bigint here).
create or replace function public.register_open_play(
    p_session_id  bigint,
    p_player_name text,
    p_mobile      text,
    p_skill_level text,
    p_is_guest    boolean
) returns jsonb
language plpgsql
as $$
declare
    v_cap   integer;
    v_count integer;
    v_qnum  integer;
begin
    -- Normalize skill level to a constraint-valid value so a stray category
    -- can never fail a paid registration (defense-in-depth with the CHECK in §5).
    if p_skill_level is null or p_skill_level not in ('beginner','novice','intermediate','advanced') then
        p_skill_level := 'beginner';
    end if;

    -- Lock the session row so concurrent registrations serialize.
    select max_players into v_cap
    from public.open_play_sessions
    where id = p_session_id
    for update;

    if v_cap is null then
        return jsonb_build_object('ok', false, 'reason', 'session_not_found');
    end if;

    -- Idempotency: same person + session already registered.
    select queue_number into v_qnum
    from public.open_play_queue
    where session_id = p_session_id and mobile = p_mobile
    limit 1;
    if found then
        return jsonb_build_object('ok', true, 'status', 'already_registered', 'queue_number', v_qnum);
    end if;

    select count(*) into v_count
    from public.open_play_queue
    where session_id = p_session_id;

    if v_count >= v_cap then
        return jsonb_build_object('ok', false, 'reason', 'full');
    end if;

    insert into public.open_play_queue (session_id, player_name, mobile, skill_level, is_guest)
    values (p_session_id, p_player_name, p_mobile, p_skill_level, p_is_guest)
    returning queue_number into v_qnum;

    return jsonb_build_object('ok', true, 'status', 'registered', 'queue_number', v_qnum);
end;
$$;

-- ── 5. Allow 'novice' as a valid open-play skill level ────────────────────────
-- The registration UI offers Beginner/Novice, but the original CHECK allowed only
-- beginner/intermediate/advanced — so a 'novice' pick failed AFTER payment (the
-- webhook's register_open_play insert would violate the constraint and 500). Drop
-- any existing CHECK touching skill_level, then recreate it including 'novice'.
do $$
declare
    c record;
begin
    for c in
        select con.conname
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
        where nsp.nspname = 'public'
          and rel.relname = 'open_play_queue'
          and con.contype = 'c'
          and pg_get_constraintdef(con.oid) ilike '%skill_level%'
    loop
        execute format('alter table public.open_play_queue drop constraint %I', c.conname);
    end loop;
end $$;

alter table public.open_play_queue
    add constraint open_play_queue_skill_level_check
    check (skill_level in ('beginner','novice','intermediate','advanced'));
