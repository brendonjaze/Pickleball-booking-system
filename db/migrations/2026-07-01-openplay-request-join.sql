-- db/migrations/2026-07-01-openplay-request-join.sql
-- Sub-project 1: Open Play "Request to Join + Group Chat + Receipt Approval".
-- Run in the Supabase SQL editor. Safe to re-run (idempotent guards throughout).
--
-- IMPORTANT: This migration does NOT modify open_play_queue. That table already
-- has its own lifecycle (status waiting/called/playing/skipped/finished/no_show),
-- a (session_id, queue_number) unique key, and three BEFORE/AFTER-insert triggers
-- (assign_queue_number, generate_receipt_code, create_receipt_on_join). We leave
-- it as the CONFIRMED roster / game queue and layer approval on top:
--
--   A. open_play_join_requests: NEW table holding pending -> approved/declined requests.
--   B. open_play_messages:      NEW per-session group chat (text + receipt image).
--   C. approve_open_play_request(): capacity-safe approval that INSERTS the player
--      into open_play_queue (existing triggers then assign queue_number + receipt).
--   D. get_open_play_request(): a player reads their own request status by device token.
--   E. RLS + grants for the two NEW tables only.
--   F. Realtime: publish the two NEW tables.
--   G. (OPTIONAL) Supabase Storage bucket for receipt images.

-- ─── A. open_play_join_requests (NEW) ─────────────────────────────────────────
create table if not exists public.open_play_join_requests (
    id           uuid primary key default gen_random_uuid(),
    session_id   uuid not null references public.open_play_sessions(id) on delete cascade,
    player_name  text not null,
    mobile       text,
    skill_level  text not null,
    player_token text not null,                 -- device token that owns this request
    status       text not null default 'pending',
    queue_id     uuid references public.open_play_queue(id) on delete set null, -- set on approval
    created_at   timestamptz not null default now(),
    decided_at   timestamptz
);

do $$ begin
    alter table public.open_play_join_requests
        add constraint opjr_status_check check (status in ('pending','approved','declined'));
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.open_play_join_requests
        add constraint opjr_skill_level_check
        check (skill_level in ('beginner','novice','intermediate','advanced'));
exception when duplicate_object then null; end $$;

-- One request per person per session (mobile-based; NULL mobile not deduped).
create unique index if not exists opjr_session_mobile_uniq
    on public.open_play_join_requests (session_id, mobile) where mobile is not null;

create index if not exists opjr_session_status_idx
    on public.open_play_join_requests (session_id, status);

-- ─── B. open_play_messages (NEW): per-session group chat ──────────────────────
create table if not exists public.open_play_messages (
    id           bigint generated always as identity primary key,
    session_id   uuid not null references public.open_play_sessions(id) on delete cascade,
    sender_token text,           -- device token of a player sender (null for organizer)
    sender_name  text,
    is_organizer boolean not null default false,
    body         text,
    image_url    text,           -- receipt / attached image URL
    created_at   timestamptz not null default now()
);

create index if not exists open_play_messages_session_created_idx
    on public.open_play_messages (session_id, created_at);

do $$ begin
    alter table public.open_play_messages
        add constraint open_play_messages_content_check
        check (coalesce(nullif(btrim(body), ''), image_url) is not null);
exception when duplicate_object then null; end $$;

-- ─── C. Capacity-safe approval RPC ────────────────────────────────────────────
-- Locks the session row so concurrent approvals can't exceed max_players, then
-- inserts the confirmed player into open_play_queue (its triggers assign the
-- queue_number + receipt). Marks the request approved and links the queue row.
create or replace function public.approve_open_play_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_req      public.open_play_join_requests%rowtype;
    v_cap      integer;
    v_count    integer;
    v_queue_id uuid;
begin
    select * into v_req
    from public.open_play_join_requests
    where id = p_request_id
    for update;

    if v_req.id is null then
        return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if v_req.status = 'approved' then
        return jsonb_build_object('ok', true, 'status', 'already_approved', 'queue_id', v_req.queue_id);
    end if;
    if v_req.status = 'declined' then
        return jsonb_build_object('ok', false, 'reason', 'declined');
    end if;

    -- Lock the session to serialize capacity checks.
    select max_players into v_cap
    from public.open_play_sessions
    where id = v_req.session_id
    for update;

    -- Null/0 max_players means capacity isn't configured — nothing can be approved.
    v_cap := coalesce(v_cap, 0);

    select count(*) into v_count
    from public.open_play_queue
    where session_id = v_req.session_id;

    if v_count >= v_cap then
        return jsonb_build_object('ok', false, 'reason', 'full');
    end if;

    -- Confirmed player enters the game queue (status defaults to 'waiting';
    -- assign_queue_number / generate_receipt_code / create_receipt_on_join fire).
    insert into public.open_play_queue (session_id, player_name, mobile, skill_level, is_guest)
    values (v_req.session_id, v_req.player_name, v_req.mobile, v_req.skill_level, true)
    returning id into v_queue_id;

    update public.open_play_join_requests
    set status = 'approved', queue_id = v_queue_id, decided_at = now()
    where id = p_request_id;

    return jsonb_build_object('ok', true, 'status', 'approved', 'queue_id', v_queue_id);
end;
$$;

grant execute on function public.approve_open_play_request(uuid) to authenticated;

-- ─── D. Player reads own request by device token ──────────────────────────────
-- SECURITY DEFINER so a player sees THEIR OWN request without anon needing read
-- access to the requests table (other people's requests/phones stay private).
create or replace function public.get_open_play_request(p_token text, p_session_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'id', id,
        'status', status,
        'player_name', player_name,
        'skill_level', skill_level,
        'queue_id', queue_id
    )
    from public.open_play_join_requests
    where player_token = p_token and session_id = p_session_id
    limit 1;
$$;

grant execute on function public.get_open_play_request(text, uuid) to anon, authenticated;

-- ─── E. RLS + grants (NEW tables only) ────────────────────────────────────────
-- open_play_join_requests: anon may create a pending request (and reads its own
-- status only via get_open_play_request, above — no direct anon SELECT). Admin
-- sees/updates/deletes all.
alter table public.open_play_join_requests enable row level security;

grant insert on public.open_play_join_requests to anon, authenticated;
grant select, update, delete on public.open_play_join_requests to authenticated;

drop policy if exists "opjr anon request" on public.open_play_join_requests;
create policy "opjr anon request"
    on public.open_play_join_requests for insert to anon
    with check (status = 'pending');

drop policy if exists "opjr auth select" on public.open_play_join_requests;
create policy "opjr auth select"
    on public.open_play_join_requests for select to authenticated using (true);

drop policy if exists "opjr auth update" on public.open_play_join_requests;
create policy "opjr auth update"
    on public.open_play_join_requests for update to authenticated using (true) with check (true);

drop policy if exists "opjr auth delete" on public.open_play_join_requests;
create policy "opjr auth delete"
    on public.open_play_join_requests for delete to authenticated using (true);

-- open_play_messages: anyone holding the session's uuid can read the chat;
-- players post as themselves (is_organizer=false), admin posts as organizer and
-- can moderate (delete).
alter table public.open_play_messages enable row level security;

grant select, insert on public.open_play_messages to anon, authenticated;
grant delete on public.open_play_messages to authenticated;

drop policy if exists "opm read" on public.open_play_messages;
create policy "opm read"
    on public.open_play_messages for select to anon, authenticated using (true);

drop policy if exists "opm anon post" on public.open_play_messages;
create policy "opm anon post"
    on public.open_play_messages for insert to anon with check (is_organizer = false);

drop policy if exists "opm auth post" on public.open_play_messages;
create policy "opm auth post"
    on public.open_play_messages for insert to authenticated with check (true);

drop policy if exists "opm auth delete" on public.open_play_messages;
create policy "opm auth delete"
    on public.open_play_messages for delete to authenticated using (true);

-- ─── F. Realtime publication (NEW tables) ─────────────────────────────────────
-- Lets the admin's pending list and everyone's chat update live. If your
-- supabase_realtime publication is FOR ALL TABLES these error harmlessly — skip them.
do $$ begin
    alter publication supabase_realtime add table public.open_play_join_requests;
exception when duplicate_object then null; end $$;

do $$ begin
    alter publication supabase_realtime add table public.open_play_messages;
exception when duplicate_object then null; end $$;

-- ─── G. (OPTIONAL) Supabase Storage bucket for receipt images ─────────────────
-- Run ONLY if using Supabase Storage (recommended). Skip for ImgBB.
insert into storage.buckets (id, name, public)
values ('openplay-receipts', 'openplay-receipts', true)
on conflict (id) do nothing;

drop policy if exists "openplay-receipts read" on storage.objects;
create policy "openplay-receipts read"
    on storage.objects for select to anon, authenticated
    using (bucket_id = 'openplay-receipts');

drop policy if exists "openplay-receipts upload" on storage.objects;
create policy "openplay-receipts upload"
    on storage.objects for insert to anon, authenticated
    with check (bucket_id = 'openplay-receipts');
