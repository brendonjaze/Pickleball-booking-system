# Open Play — Request to Join + Group Chat + Receipt Approval (Sub-project 1)

**Date:** 2026-07-01
**Status:** Design revised after schema discovery (pending spec review)
**Repos:** booking app (`Pickleball booking system`) + admin panel (`Pickleball Booking System (admin panel)`)

## Goal

Replace the automatic PayMongo online-payment path for **open play** with a manual flow:
a player **requests to join** a session (lands as `pending`), posts their **GCash/QR receipt**
in the session's **group chatroom**, and the **organizer approves** them in the admin panel —
at which point they become a **confirmed** participant. Identity is a device token (no login).

Sub-project 1 of 2. Sub-project 2 (live game rotation during play) is a separate later cycle and
builds on the confirmed roster / game queue this sub-project feeds.

## Decisions (locked)

1. **Replace PayMongo** for open play with request → receipt → approve. (Court bookings unaffected.)
2. **Identity:** device token in `localStorage` + mobile. No accounts, no OTP.
3. **Chatroom:** one **group** chat per session.
4. **Roster visibility:** confirmed players only publicly; pending requests visible to organizer.
5. **Receipt image storage:** Supabase Storage bucket `openplay-receipts` (recommended). ImgBB fallback.

## Critical schema discovery (why the design changed)

`open_play_queue` is **richer than the current code uses** and is already wired for the live-queue/
match system (Sub-project 2):
- `id` is **uuid** (not bigint); registration timestamp is **`joined_at`** (there is no `created_at`).
- `status` already exists with a CHECK: `('waiting','called','playing','skipped','finished','no_show')` — a game-queue lifecycle, NOT an approval flag.
- Three insert triggers fire on every row: `assign_queue_number` (BEFORE), `generate_receipt_code`
  (BEFORE), `create_receipt_on_join` (AFTER). So **inserting = a confirmed player joining the queue**.
- Constraints: `(session_id, queue_number)` unique, `queue_number` 1..100, `receipt_code` unique,
  `gender` check, `player_id` → `auth.users`, `match_id` → `open_play_matches`.

**Consequence:** we do NOT add a status/approval column to `open_play_queue` and do NOT insert
pending rows there (it would hand out queue numbers/receipts before approval and fight the triggers).
Instead the approval step lives in a **separate table**, and approval **inserts** the player into
`open_play_queue` so the existing triggers do the right thing.

## Data model

### `open_play_join_requests` (NEW)
`id uuid`, `session_id uuid → open_play_sessions`, `player_name text`, `mobile text`,
`skill_level text` (beginner/novice/intermediate/advanced), `player_token text`,
`status text` = `pending|approved|declined` (default `pending`),
`queue_id uuid → open_play_queue` (set on approval), `created_at`, `decided_at`.
Unique `(session_id, mobile)` where mobile not null → one request per person per session.

### `open_play_messages` (NEW)
`id bigint`, `session_id uuid → open_play_sessions`, `sender_token text`, `sender_name text`,
`is_organizer bool`, `body text`, `image_url text`, `created_at`. CHECK: body or image required.

### `open_play_queue` (UNCHANGED)
Remains the confirmed roster / game queue. Approval inserts into it; its triggers assign
`queue_number` + `receipt_code` + receipt. Nothing in this migration alters it.

### RPCs
- `approve_open_play_request(p_request_id uuid) → jsonb` — SECURITY DEFINER, granted to `authenticated`.
  Locks the session, counts `open_play_queue` rows, and if `< max_players` inserts the confirmed
  player (triggers do numbering/receipt), marks the request `approved`, links `queue_id`. Else `full`.
- `get_open_play_request(p_token text, p_session_id uuid) → jsonb` — SECURITY DEFINER, granted to
  `anon`+`authenticated`. Lets a player read their own request status by token without exposing the
  requests table (or anyone's mobile) to anon.

### Decline
Admin sets `status='declined'` via a direct authenticated PATCH (RLS allows it) — no RPC needed.

### Migration
`db/migrations/2026-07-01-openplay-request-join.sql` — idempotent; adds the two tables + two RPCs
+ RLS/grants + realtime + optional storage bucket. **Does not touch `open_play_queue`.** Run before deploy.

## Security posture (honest limitations)

- `anon` may: insert a **pending** request (RLS `with check (status='pending')`); read + post chat
  messages (as non-organizer); read **its own** request status via the token RPC only.
- `anon` may NOT: read the requests table directly (no mobiles/tokens leak), approve/decline, or
  post as organizer.
- `authenticated` (admin) may: read/update/delete requests, approve via RPC, post as organizer, moderate chat.
- Device token is not cryptographically enforced (no login) — anon policies are permissive, matching
  the app's existing court-booking anon inserts. Chat reads gated only by knowledge of the session uuid.
- **Receipts posted in the group chat are visible to anyone who can open that session's chat** — an
  accepted trade-off of the "group chat" choice. Stricter privacy later = 1:1 threads or OTP login.

## Player flow (booking app — `index.html`, mirrored to `dist/index.html`)

1. Open-play wizard collects name / mobile / skill (unchanged).
2. Payment step replaced by **Request to Join**:
   - ensure device token in `localStorage` (`op_player_token`), create via `crypto.randomUUID()`;
   - insert `open_play_join_requests` `{session_id, player_name, mobile, skill_level, player_token, status:'pending'}`;
   - fetch own request via `get_open_play_request(token, session)` → store `{requestId, token}` per session;
   - duplicate (unique violation) → "You've already requested to join" and open the chat.
3. **Chatroom view**: load `open_play_messages` (asc), subscribe (realtime) on `session_id`; message
   input + image upload (receipt) → Supabase Storage (or ImgBB) → insert message with `image_url`.
   Status banner from `get_open_play_request`; re-fetched whenever a new chat message arrives (and a
   slow poll fallback), so `pending → "post your receipt & wait"` flips to `approved → "You're in ✅"` live.
4. Re-entry: from the open-play card, a stored `{requestId, token}` re-opens chat/status.

## Organizer flow (admin panel — `src/main.js`)

1. Per-session panel gains a **Pending requests** group alongside the existing **Confirmed** list
   (confirmed = `open_play_queue` rows, as today).
2. Pending row: name/mobile/skill/time + **Approve** (`approve_open_play_request`; on `full` shows a
   message, leaves pending) and **Decline** (PATCH `status='declined'`).
3. **Open chat** to view receipts and reply as organizer (`is_organizer=true`).
4. Realtime subscriptions on `open_play_join_requests` + `open_play_messages` keep pending list + chat live.

## Retiring the PayMongo open-play path

`payWithPaymongoOp()` no longer called for open play; the wizard's pay step is replaced. The webhook's
`openplay` branch + `register_open_play` RPC become dead for new registrations (left in place, removable later).

## Error handling

- Duplicate request → friendly message + open chat.
- Approve when full → organizer sees "Session is full"; request stays pending.
- Image upload failure → error toast + retry; typed text preserved.
- Realtime drop → manual refresh + re-subscribe.
- Missing token on a new device → re-request (dedup catches it).

## Testing / verification (no test framework)

- Run migration; verify both tables + both functions exist; `open_play_queue` untouched.
- End-to-end: request → pending in admin → post receipt in chat → admin sees it → approve → player's
  banner flips to confirmed live → a confirmed row appears in `open_play_queue` with queue_number + receipt.
- Capacity: fill to `max_players`; next approve returns `full`.
- Duplicate: request twice same mobile → single request row, friendly handling.
- RLS: as anon, cannot read the requests table or approve; own status only via RPC. Admin can.
- Booking app inline-JS syntax check; admin `npm run build` passes.
- Dual-file (`index.html` == `dist/index.html`) + SW cache bump.

## Open item for the user

- Confirm **storage choice**: Supabase Storage (section G) vs ImgBB (skip G).
- Approve the pivot to a separate `open_play_join_requests` table (leaving `open_play_queue` intact).
