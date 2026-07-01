-- db/migrations/2026-07-01-openplay-request-join-fixups.sql
-- Follow-up to 2026-07-01-openplay-request-join.sql. Run in the Supabase SQL editor.
-- Safe to re-run.
--
-- Fixes the "declined dead-end": the unique (session_id, mobile) index means a
-- second direct INSERT for the same phone fails (23505), so a declined player
-- could never re-request. This SECURITY DEFINER RPC upserts the request: it
-- creates a pending row, or resets an existing pending/declined row back to
-- pending (leaving already-approved rows alone). The booking app calls this
-- instead of inserting directly.

create or replace function public.request_open_play_join(
    p_session_id uuid,
    p_player_name text,
    p_mobile text,
    p_skill_level text,
    p_token text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id     uuid;
    v_status text;
begin
    -- Look up an existing request for this (session, mobile). NULL mobile never
    -- matches (so anonymous/no-mobile requests always create a fresh row).
    select id, status into v_id, v_status
    from public.open_play_join_requests
    where session_id = p_session_id and mobile is not null and mobile = p_mobile
    limit 1;

    if v_id is null then
        insert into public.open_play_join_requests
            (session_id, player_name, mobile, skill_level, player_token, status)
        values
            (p_session_id, p_player_name, p_mobile, coalesce(p_skill_level, 'beginner'), p_token, 'pending')
        returning id into v_id;
        return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending', 'created', true);
    end if;

    if v_status = 'approved' then
        return jsonb_build_object('ok', true, 'id', v_id, 'status', 'approved', 'created', false);
    end if;

    -- pending or declined → (re)set to pending; refresh name/token/skill.
    update public.open_play_join_requests
    set status = 'pending',
        player_name = p_player_name,
        player_token = p_token,
        skill_level = coalesce(p_skill_level, skill_level),
        decided_at = null
    where id = v_id;

    return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending', 'created', false);
end;
$$;

grant execute on function public.request_open_play_join(uuid, text, text, text, text) to anon, authenticated;
