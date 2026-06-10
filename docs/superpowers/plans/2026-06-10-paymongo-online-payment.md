# PayMongo Online Payment (online-only, webhook-confirmed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-enable PayMongo online payment as the only payment path for court rental and open play, with the webhook as the sole writer of bookings and DB-level protection against double-booking.

**Architecture:** The frontend wizard's final step triggers the already-implemented `payWithPaymongo()` / `payWithPaymongoOp()`, which redirect to PayMongo hosted checkout. On `checkout_session.payment.paid`, `api/paymongo-webhook.js` writes the row to `bookings` / `open_play_queue` (authoritative; shows on the separate admin app). On the `?payment=success` redirect the page polls Supabase until that row appears, then shows the receipt. Court double-booking is guaranteed by a unique index; open-play capacity by an atomic `register_open_play` Postgres function.

**Tech Stack:** Vanilla JS single-file frontend (`index.html`), Vercel serverless functions (`api/*.js`), Supabase (Postgres + PostgREST), PayMongo Checkout + webhooks, manually-mirrored `dist/` for Vercel.

---

## Conventions for this plan

- **No automated test harness exists** in this repo (no lint/test scripts, buildless vanilla JS). "Verify" steps are therefore **manual**: `npm run dev` smoke tests for UI, Supabase SQL queries for DB objects, and a final deployed end-to-end run for the webhook (PayMongo cannot reach localhost). This is deliberate — we are not adding a test framework the user didn't ask for.
- **Dual-file rule (CLAUDE.md):** every edit to `index.html` must be applied **identically** to `dist/index.html`. Each frontend task shows the code once; apply it to both files. If a region in `dist/index.html` has drifted from `index.html`, reconcile it to match before editing.
- **SW cache rule (CLAUDE.md):** bump `CACHE` in **both** `sw.js` and `dist/sw.js` (Task 8) so returning users don't keep the cached walk-in build.
- Work happens on branch `feat/paymongo-online-payment` (already created).

---

## Task 1: Database migration (Supabase SQL)

Creates/verifies the DB objects the webhook and double-booking guarantees depend on. Run in the Supabase SQL editor.

**Files:**
- Create: `db/migrations/2026-06-10-online-payment.sql`

- [ ] **Step 1: Create the migration file**

```sql
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
```

- [ ] **Step 2: Run the type-check query first**

In the Supabase SQL editor, run the `information_schema.columns` query from section 0.
Expected: confirm `open_play_sessions.id` type. If it is `uuid`, change `p_session_id bigint` to `p_session_id uuid` in section 4 before running it.

- [ ] **Step 3: Run sections 1–4**

Run the file. Expected: success, no errors. If section 1 or 2 errors with a duplicate-key message, run the matching duplicate-finder query (in the comments), resolve the duplicates, then re-run.

- [ ] **Step 4: Verify the objects exist**

Run:
```sql
select indexname from pg_indexes
  where indexname in ('bookings_court_date_slot_uniq','open_play_queue_session_mobile_uniq');
select to_regclass('public.booking_failures') as booking_failures;
select proname from pg_proc where proname = 'register_open_play';
```
Expected: both indexes listed, `booking_failures` non-null, `register_open_play` listed.

- [ ] **Step 5: Smoke-test the function**

Run (replace `<REAL_SESSION_ID>` with an existing open_play_sessions id):
```sql
select public.register_open_play(<REAL_SESSION_ID>, 'PLAN TEST', '09990000000', 'beginner', true);
```
Expected: JSON `{"ok": true, "status": "registered", "queue_number": <n>}`. Then clean up:
```sql
delete from public.open_play_queue where mobile = '09990000000' and player_name = 'PLAN TEST';
```

- [ ] **Step 6: Commit the migration file**

```bash
git add db/migrations/2026-06-10-online-payment.sql
git commit -m "feat(db): add online-payment double-booking guards and register_open_play"
```

---

## Task 2: Webhook — court slot-conflict handling

Make the webhook return 200 (not 500) on a unique-violation so PayMongo stops retrying, and record a refund trail.

**Files:**
- Modify: `api/paymongo-webhook.js` (court branch, currently lines ~133–139)

- [ ] **Step 1: Replace the court insert block**

Find:
```js
            const insert = await supabaseRequest('bookings', supabaseUrl, supabaseKey, {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify(rows),
            });
            if (!insert.ok) throw new Error(`Supabase court insert failed: ${JSON.stringify(insert.body)}`);
            console.log('Webhook: court booking saved via webhook for ref', metadata.booking_ref);
```
Replace with:
```js
            const insert = await supabaseRequest('bookings', supabaseUrl, supabaseKey, {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify(rows),
            });
            if (!insert.ok) {
                const isConflict = insert.status === 409 ||
                    (insert.body && JSON.stringify(insert.body).includes('23505'));
                if (isConflict) {
                    console.error('Webhook: court slot conflict — recording booking_failure for ref', metadata.booking_ref);
                    await supabaseRequest('booking_failures', supabaseUrl, supabaseKey, {
                        method: 'POST',
                        headers: { 'Prefer': 'return=minimal' },
                        body: JSON.stringify({
                            type: 'court',
                            booking_ref: metadata.booking_ref,
                            reason: 'slot_taken',
                            payload: metadata,
                        }),
                    });
                    return res.status(200).json({ received: true, status: 'slot_conflict_refund_needed' });
                }
                throw new Error(`Supabase court insert failed: ${JSON.stringify(insert.body)}`);
            }
            console.log('Webhook: court booking saved via webhook for ref', metadata.booking_ref);
```

- [ ] **Step 2: Verify it parses**

Run: `node --check api/paymongo-webhook.js`
Expected: no output (exit 0). If it errors, fix the syntax shown.

- [ ] **Step 3: Commit**

```bash
git add api/paymongo-webhook.js
git commit -m "feat(webhook): handle court slot conflicts with refund trail, return 200"
```

---

## Task 3: Webhook — open play via atomic RPC

Replace the raw open-play insert with a call to `register_open_play`, recording a refund trail when the session is full.

**Files:**
- Modify: `api/paymongo-webhook.js` (openplay branch, currently lines ~84–107)

- [ ] **Step 1: Replace the openplay branch**

Find:
```js
        if (metadata.type === 'openplay') {
            // Idempotency: skip if already registered (same session + mobile)
            const check = await supabaseRequest(
                `open_play_queue?session_id=eq.${encodeURIComponent(metadata.session_id)}&mobile=eq.${encodeURIComponent(metadata.mobile)}&select=id&limit=1`,
                supabaseUrl, supabaseKey
            );
            if (check.ok && check.body?.length > 0) {
                console.log('Webhook: openplay already registered, skipping');
                return res.status(200).json({ received: true, status: 'already_registered' });
            }

            const insert = await supabaseRequest('open_play_queue', supabaseUrl, supabaseKey, {
                method: 'POST',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify({
                    session_id: metadata.session_id,
                    player_name: metadata.player_name,
                    mobile: metadata.mobile,
                    skill_level: metadata.skill_level || 'beginner',
                    is_guest: true,
                }),
            });
            if (!insert.ok) throw new Error(`Supabase openplay insert failed: ${JSON.stringify(insert.body)}`);
            console.log('Webhook: openplay registered via webhook', insert.body);

        } else if (metadata.type === 'court') {
```
Replace with:
```js
        if (metadata.type === 'openplay') {
            const rpc = await supabaseRequest('rpc/register_open_play', supabaseUrl, supabaseKey, {
                method: 'POST',
                body: JSON.stringify({
                    p_session_id: metadata.session_id,
                    p_player_name: metadata.player_name,
                    p_mobile: metadata.mobile,
                    p_skill_level: metadata.skill_level || 'beginner',
                    p_is_guest: true,
                }),
            });
            if (!rpc.ok) throw new Error(`Supabase register_open_play failed: ${JSON.stringify(rpc.body)}`);

            // PostgREST returns the function's jsonb result directly; if your project
            // wraps it in an array, use Array.isArray(rpc.body) ? rpc.body[0] : rpc.body.
            const result = Array.isArray(rpc.body) ? rpc.body[0] : rpc.body;
            if (result && result.ok === false) {
                console.error('Webhook: openplay could not register —', result.reason, 'session', metadata.session_id);
                await supabaseRequest('booking_failures', supabaseUrl, supabaseKey, {
                    method: 'POST',
                    headers: { 'Prefer': 'return=minimal' },
                    body: JSON.stringify({
                        type: 'openplay',
                        booking_ref: metadata.booking_ref,
                        reason: result.reason || 'register_failed',
                        payload: metadata,
                    }),
                });
                return res.status(200).json({ received: true, status: `openplay_${result.reason}_refund_needed` });
            }
            console.log('Webhook: openplay registered via RPC', JSON.stringify(result));

        } else if (metadata.type === 'court') {
```

- [ ] **Step 2: Verify it parses**

Run: `node --check api/paymongo-webhook.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add api/paymongo-webhook.js
git commit -m "feat(webhook): register open play via atomic register_open_play RPC"
```

---

## Task 4: Court wizard — wire up online payment

Stop forcing walk-in; make the final step a "Pay Online" screen that triggers the existing `payWithPaymongo()`.

**Files:**
- Modify: `index.html` **and** `dist/index.html` — `wizardNext()` (~4734), `renderStepContent()` step 3 (~4242–4272), `renderWizardFooter()` (~4571–4585)

- [ ] **Step 1: Point the final step at PayMongo in `wizardNext()`**

Find:
```js
            if (wizardStep === 3) { await finishBooking(); return; }
```
Replace with:
```js
            if (wizardStep === 3) { await payWithPaymongo(); return; }
```

- [ ] **Step 2: Set the online payment label in `wizardNext()`**

Find:
```js
            if (wizardStep === 1) {
                bookingPayment = 'Walk-in (Pay at venue)';
                wizardStep = 3;
            } else {
                wizardStep++;
            }
```
Replace with:
```js
            if (wizardStep === 1) {
                bookingPayment = 'QRPh (GCash/Maya/ShopeePay)';
                wizardStep = 3;
            } else {
                wizardStep++;
            }
```

- [ ] **Step 3: Replace the step-3 body (walk-in → pay online)**

Find the entire `else if (wizardStep === 3) { ... }` block in `renderStepContent()` (the one that builds `dlBtn` and renders the "🚶 Walk-in Payment" screen, ~lines 4242–4272) and replace the whole block with:
```js
            } else if (wizardStep === 3) {
                if (!window._bookingRef) window._bookingRef = 'GPC-' + Date.now().toString(36).toUpperCase();
                body.innerHTML = `
                <div style="text-align:center;padding:1.5rem 1rem;">
                    <div style="font-size:3rem;margin-bottom:0.75rem;">💳</div>
                    <div style="font-size:1.1rem;font-weight:800;color:var(--green-dark);margin-bottom:0.5rem;">Pay Online to Confirm</div>
                    <p style="font-size:0.88rem;color:#555;line-height:1.6;margin-bottom:1.25rem;">
                        Your slot is confirmed <strong>only after payment</strong>.<br>Pay securely via GCash, Maya, or QR Ph.
                    </p>
                    <div style="background:#f0faf3;border:2px solid var(--green-dark);border-radius:12px;padding:1rem 1.5rem;margin-bottom:1.25rem;">
                        <div style="font-size:0.8rem;color:#555;margin-bottom:0.25rem;">Total amount</div>
                        <div style="font-size:2rem;font-weight:800;color:var(--green-dark);">&#8369;${amount.toLocaleString()}</div>
                    </div>
                    <button id="paymongo-btn" onclick="payWithPaymongo()" style="
                        width:100%;background:var(--green-dark);color:#fff;border:none;border-radius:10px;
                        padding:0.85rem 1.3rem;font-size:0.95rem;font-weight:700;
                        cursor:pointer;font-family:'Montserrat',sans-serif;">
                        Proceed to Payment
                    </button>
                </div>`;
            }
```

- [ ] **Step 4: Hide the footer Next on step 3 in `renderWizardFooter()`**

Find:
```js
            if (wizardStep === 3) {
                next.textContent = 'Done';
                next.disabled = false;
            } else {
                next.innerHTML = 'Next &#8594;';
                if (wizardStep === 1) next.disabled = bookingName.length < 2 || bookingPhone.length < 10;
                else next.disabled = false;
            }
```
Replace with:
```js
            if (wizardStep === 3) {
                next.style.display = 'none';
            } else {
                next.style.display = '';
                next.innerHTML = 'Next &#8594;';
                if (wizardStep === 1) next.disabled = bookingName.length < 2 || bookingPhone.length < 10;
                else next.disabled = false;
            }
```

- [ ] **Step 5: Apply Steps 1–4 identically to `dist/index.html`**

Make the same four edits in `dist/index.html`. The surrounding code should match `index.html`; if it has drifted, reconcile it to match before editing.

- [ ] **Step 6: Smoke-test locally**

Run: `npm run dev` and open the printed URL. Start a court booking, enter name + a valid phone, advance to the final step.
Expected: the final step shows "Pay Online to Confirm", the total, and a "Proceed to Payment" button; the footer "Done/Next" button is gone. Clicking "Proceed to Payment" shows "Preparing Checkout…" (it will then error locally because the `/api/paymongo` proxy isn't running — that's expected; we verify the real redirect on Vercel in Task 8).

- [ ] **Step 7: Commit**

```bash
git add index.html dist/index.html
git commit -m "feat(court): replace walk-in step with online payment via PayMongo"
```

---

## Task 5: Open-play wizard — wire up online payment

Mirror Task 4 for the open-play wizard.

**Files:**
- Modify: `index.html` **and** `dist/index.html` — `opWizardNext()` (~5375), `opRenderStepContent()` step 3 (~5338–5356), `opRenderFooter()` (~5364–5372)

- [ ] **Step 1: Point the final step at PayMongo in `opWizardNext()`**

Find:
```js
            if (opWizardStep === 3) { await finishOpRegistration(); return; }
```
Replace with:
```js
            if (opWizardStep === 3) { await payWithPaymongoOp(); return; }
```

- [ ] **Step 2: Set the online payment label in `opWizardNext()`**

Find:
```js
            if (opWizardStep === 1) {
                opPayment = 'Walk-in (Pay at venue)';
                opWizardStep = 3;
            } else {
                opWizardStep++;
            }
```
Replace with:
```js
            if (opWizardStep === 1) {
                opPayment = 'QRPh (GCash/Maya/ShopeePay)';
                opWizardStep = 3;
            } else {
                opWizardStep++;
            }
```

- [ ] **Step 3: Replace the op step-3 body (walk-in → pay online)**

Find the entire `else if (opWizardStep === 3) { ... }` block in `opRenderStepContent()` (the "🚶 Walk-in Payment" screen, ~5338–5356) and replace the whole block with:
```js
            } else if (opWizardStep === 3) {
                body.innerHTML = `
                <div style="text-align:center;padding:1.5rem 1rem;">
                    <div style="font-size:3rem;margin-bottom:0.75rem;">💳</div>
                    <div style="font-size:1.1rem;font-weight:800;color:var(--green-dark);margin-bottom:0.5rem;">Pay Online to Confirm</div>
                    <p style="font-size:0.88rem;color:#555;line-height:1.6;margin-bottom:1.25rem;">
                        Your spot is confirmed <strong>only after payment</strong>.<br>Pay securely via GCash, Maya, or QR Ph.
                    </p>
                    <div style="background:#f0faf3;border:2px solid var(--green-dark);border-radius:12px;padding:1rem 1.5rem;margin-bottom:1.25rem;">
                        <div style="font-size:0.8rem;color:#555;margin-bottom:0.25rem;">Amount per player</div>
                        <div style="font-size:2rem;font-weight:800;color:var(--green-dark);">&#8369;${Number(amount).toLocaleString()}</div>
                    </div>
                    <button id="paymongo-op-btn" onclick="payWithPaymongoOp()" style="
                        width:100%;background:var(--green-dark);color:#fff;border:none;border-radius:10px;
                        padding:0.85rem 1.3rem;font-size:0.95rem;font-weight:700;
                        cursor:pointer;font-family:'Montserrat',sans-serif;">
                        Proceed to Payment
                    </button>
                </div>`;
            }
```

- [ ] **Step 4: Hide the footer Next on step 3 in `opRenderFooter()`**

Find:
```js
            if (opWizardStep === 3) {
                next.textContent = 'Done';
                next.style.display = '';
                next.disabled = false;
            } else {
```
Replace with:
```js
            if (opWizardStep === 3) {
                next.style.display = 'none';
            } else {
```

- [ ] **Step 5: Apply Steps 1–4 identically to `dist/index.html`**

Make the same four edits in `dist/index.html`; reconcile drift if any.

- [ ] **Step 6: Smoke-test locally**

Run `npm run dev` (or reuse the running server). Open an open-play session, click "Join Open Play", enter name + valid phone + category, advance to the final step.
Expected: "Pay Online to Confirm" screen with the per-player amount and a "Proceed to Payment" button; footer button gone.

- [ ] **Step 7: Commit**

```bash
git add index.html dist/index.html
git commit -m "feat(openplay): replace walk-in step with online payment via PayMongo"
```

---

## Task 6: Success redirect — poll for the webhook's row

On `?payment=success`, stop inserting client-side; show "Verifying…", poll Supabase for the webhook-written row, then show the receipt.

**Files:**
- Modify: `index.html` **and** `dist/index.html` — success handler court block (~3421–3434) and openplay block (~3448–3455); add three new functions near `payWithPaymongo()` (~before line 4587)

- [ ] **Step 1: Add the polling + thank-you functions**

Insert these three functions immediately **before** `async function payWithPaymongo() {`:
```js
        async function confirmPaidBooking(type, data) {
            const body = document.getElementById('modal-body');
            const prev = document.getElementById('btn-prev');
            const next = document.getElementById('btn-next');
            const cancel = document.querySelector('.btn-cancel');
            if (prev) prev.style.display = 'none';
            if (next) next.style.display = 'none';
            if (cancel) cancel.style.display = 'none';
            if (body) {
                body.innerHTML = `
                <div style="text-align:center;padding:2rem 1rem;">
                    <div style="font-size:2.5rem;margin-bottom:0.75rem;">⏳</div>
                    <div style="font-size:1.05rem;font-weight:800;color:var(--green-dark);margin-bottom:0.4rem;">Verifying your payment…</div>
                    <div style="font-size:0.85rem;color:#666;line-height:1.6;">Please wait while we confirm your booking.</div>
                </div>`;
            }

            const ref = data.bookingRef;
            const deadline = Date.now() + 15000;
            let found = null;
            while (Date.now() < deadline && !found) {
                try {
                    if (type === 'court') {
                        const { data: rows } = await db.from('bookings')
                            .select('booking_ref').eq('booking_ref', ref).limit(1);
                        if (rows && rows.length > 0) found = rows[0];
                    } else {
                        const { data: rows } = await db.from('open_play_queue')
                            .select('queue_number').eq('session_id', data.sessionId).eq('mobile', data.phone).limit(1);
                        if (rows && rows.length > 0) found = rows[0];
                    }
                } catch (e) { console.error('Payment poll error:', e); }
                if (!found) await new Promise(r => setTimeout(r, 1500));
            }

            if (found) {
                if (type === 'court') renderCourtPaidThankYou();
                else renderOpPaidThankYou(data.name, found.queue_number);
            } else if (body) {
                body.innerHTML = `
                <div style="text-align:center;padding:2rem 1rem;">
                    <div style="font-size:2.5rem;margin-bottom:0.5rem;">🧾</div>
                    <div style="font-size:1.05rem;font-weight:800;color:var(--green-dark);margin-bottom:0.5rem;">Payment received</div>
                    <div style="font-size:0.85rem;color:#666;line-height:1.7;">
                        Your booking is being processed. Keep your reference<br>
                        <strong>${ref}</strong><br>and contact us if it doesn't appear shortly.
                    </div>
                </div>`;
            }
        }

        function renderCourtPaidThankYou() {
            const slots = getSelSlotRange();
            const timeStr = slotRangeLabel(slots);
            const dateStr = formatDate(selDate);
            const body = document.getElementById('modal-body');
            if (!body) return;
            body.innerHTML = `
            <div style="text-align:center;padding:1.5rem 1rem;">
                <div style="font-size:2.5rem;margin-bottom:0.5rem;">🎉</div>
                <div style="font-size:1.1rem;font-weight:800;color:var(--green-dark);margin-bottom:0.35rem;">Payment confirmed!</div>
                <div style="font-size:0.84rem;color:#555;line-height:1.7;margin-bottom:1rem;">
                    <strong>${bookingName}</strong>, your court is reserved.<br>
                    <span style="color:var(--green-dark);font-weight:600;">${curCourt?.name || 'Court'}</span> &nbsp;·&nbsp; ${dateStr}<br>
                    ${timeStr}
                </div>
                <button onclick="downloadReceipt()" style="
                    display:inline-flex;align-items:center;gap:0.4rem;justify-content:center;width:100%;
                    background:var(--green-dark);color:#fff;border:none;border-radius:8px;
                    padding:0.7rem 1.2rem;font-size:0.85rem;font-weight:700;
                    cursor:pointer;font-family:'Montserrat',sans-serif;">
                    Download Receipt
                </button>
            </div>`;
        }

        function renderOpPaidThankYou(name, queueNumber) {
            const body = document.getElementById('modal-body');
            if (!body) return;
            const safeName = (name || '').replace(/'/g, "\\'");
            body.innerHTML = `
            <div style="text-align:center;padding:1.5rem 1rem;">
                <div style="font-size:2.5rem;margin-bottom:0.5rem;">🎉</div>
                <div style="font-size:1.1rem;font-weight:800;color:var(--green-dark);margin-bottom:0.4rem;">Payment confirmed — You're In!</div>
                ${queueNumber ? `
                <div style="margin:0.75rem auto 0.5rem;background:var(--green-light);border:2px solid var(--green-dark);border-radius:14px;display:inline-block;padding:0.5rem 1.5rem;">
                    <div style="font-size:0.72rem;color:var(--green-dark);font-weight:600;letter-spacing:1px;text-transform:uppercase;">Your Player Number</div>
                    <div style="font-size:2.2rem;font-weight:800;color:var(--green-dark);line-height:1.2;">#${queueNumber}</div>
                </div>` : ''}
                <div style="font-size:0.86rem;color:#666;line-height:1.7;margin-top:0.5rem;margin-bottom:1rem;">
                    See you on the court, <strong>${name}</strong>!
                </div>
                <button onclick="downloadOpReceipt('${safeName}', ${queueNumber || 'null'})" style="
                    display:inline-flex;align-items:center;gap:0.4rem;justify-content:center;width:100%;
                    background:var(--green-dark);color:#fff;border:none;border-radius:8px;
                    padding:0.7rem 1.2rem;font-size:0.85rem;font-weight:700;
                    cursor:pointer;font-family:'Montserrat',sans-serif;">
                    Download Receipt
                </button>
            </div>`;
        }
```

- [ ] **Step 2: Swap the court success block to poll instead of insert**

In the `?payment=success` handler, find:
```js
                            // Auto-complete the booking after data is restored
                            console.log('[LOAD] About to call finishBooking for court booking...');
                            setTimeout(async () => {
                                // First open the modal so finishBooking can populate it
                                document.getElementById('modal').classList.add('show');
                                // Set wizard to step 3 so the thank-you content is rendered
                                wizardStep = 3;
                                console.log('[LOAD] Calling finishBooking()...');
                                await finishBooking();
                                console.log('[LOAD] finishBooking completed');
                                // Clear the pending booking ONLY after booking is saved
                                sessionStorage.removeItem('pendingBooking');
                                window.history.replaceState({}, '', window.location.pathname);
                            }, 500);
```
Replace with:
```js
                            setTimeout(async () => {
                                document.getElementById('modal').classList.add('show');
                                wizardStep = 3;
                                await confirmPaidBooking('court', data);
                                sessionStorage.removeItem('pendingBooking');
                                window.history.replaceState({}, '', window.location.pathname);
                            }, 500);
```

- [ ] **Step 3: Swap the openplay success block to poll instead of insert**

Find:
```js
                            // Auto-complete the open play registration after data is restored
                            setTimeout(async () => {
                                document.getElementById('modal').classList.add('show');
                                opWizardStep = 3;
                                await finishOpRegistration();
                                // Clear the pending booking ONLY after registration is saved
                                sessionStorage.removeItem('pendingBooking');
                                window.history.replaceState({}, '', window.location.pathname);
                            }, 500);
```
Replace with:
```js
                            setTimeout(async () => {
                                document.getElementById('modal').classList.add('show');
                                opWizardStep = 3;
                                await confirmPaidBooking('openplay', data);
                                sessionStorage.removeItem('pendingBooking');
                                window.history.replaceState({}, '', window.location.pathname);
                            }, 500);
```

- [ ] **Step 4: Apply Steps 1–3 identically to `dist/index.html`**

Add the three functions and make the two block swaps in `dist/index.html`; reconcile drift if any.

- [ ] **Step 5: Verify HTML still loads**

Reload the local dev URL.
Expected: no JS console errors on load (the success path itself is exercised end-to-end on Vercel in Task 8). `finishBooking()` / `finishOpRegistration()` are now unreferenced by the live flow — that's intentional (dead walk-in code, left in place per design).

- [ ] **Step 6: Commit**

```bash
git add index.html dist/index.html
git commit -m "feat(payment): confirm bookings by polling for the webhook row on return"
```

---

## Task 7: Pre-pay availability re-check (shrink the race window)

Before redirecting to PayMongo, re-check that the slot/spots are still free, so a paid-but-lost-slot refund is rare rather than routine.

**Files:**
- Modify: `index.html` **and** `dist/index.html` — top of `payWithPaymongo()` (~4587) and `payWithPaymongoOp()` (~4663)

- [ ] **Step 1: Re-check court slots in `payWithPaymongo()`**

Find:
```js
        async function payWithPaymongo() {
            const slots = getSelSlotRange();
            const amount = slots.length * curCourt.price_per_hour;
            const bookingRef = window._bookingRef || ('GPC-' + Date.now().toString(36).toUpperCase());
```
Replace with:
```js
        async function payWithPaymongo() {
            const slots = getSelSlotRange();
            const amount = slots.length * curCourt.price_per_hour;
            const bookingRef = window._bookingRef || ('GPC-' + Date.now().toString(36).toUpperCase());

            // Pre-pay re-check: bail out if any chosen slot was just taken.
            try {
                const { data: taken } = await db.from('bookings')
                    .select('time_slot')
                    .eq('court_id', curCourt.id).eq('date', selDate).in('time_slot', slots);
                if (taken && taken.length > 0) {
                    alert('Sorry, one or more of your selected time slots were just booked. Please pick another time.');
                    closeModal();
                    if (typeof fetchBookedSlots === 'function') await fetchBookedSlots();
                    selStart = -1; selEnd = -1;
                    if (typeof renderSlots === 'function') renderSlots();
                    if (typeof updateConfirm === 'function') updateConfirm();
                    return;
                }
            } catch (e) { console.error('Pre-pay slot check failed:', e); }
```

- [ ] **Step 2: Re-check open-play capacity in `payWithPaymongoOp()`**

Find:
```js
        async function payWithPaymongoOp() {
            const s = (opSelectedSessionType && openPlaySessions[opSelectedSessionType]) || openPlaySession;
            if (!s) return;
            const amount = s.price_per_player;
            const bookingRef = window._opBookingRef || ('OPR-' + Date.now().toString(36).toUpperCase());
```
Replace with:
```js
        async function payWithPaymongoOp() {
            const s = (opSelectedSessionType && openPlaySessions[opSelectedSessionType]) || openPlaySession;
            if (!s) return;
            const amount = s.price_per_player;
            const bookingRef = window._opBookingRef || ('OPR-' + Date.now().toString(36).toUpperCase());

            // Pre-pay re-check: bail out if the session just filled up.
            try {
                const { count } = await db.from('open_play_queue')
                    .select('id', { count: 'exact', head: true })
                    .eq('session_id', s.id);
                if (typeof count === 'number' && count >= s.max_players) {
                    alert('Sorry, this Open Play session just filled up. Please check back for another session.');
                    closeModal();
                    return;
                }
            } catch (e) { console.error('Pre-pay capacity check failed:', e); }
```

- [ ] **Step 3: Apply Steps 1–2 identically to `dist/index.html`**

- [ ] **Step 4: Smoke-test locally**

Reload the dev URL and walk a court booking to the pay step; the pre-check query runs against Supabase (read-only). Expected: no console errors; for a free slot it proceeds to "Preparing Checkout…".

- [ ] **Step 5: Commit**

```bash
git add index.html dist/index.html
git commit -m "feat(payment): re-check availability before redirecting to PayMongo"
```

---

## Task 8: SW cache bump + deploy + end-to-end verification

**Files:**
- Modify: `sw.js` and `dist/sw.js` (CACHE version)

- [ ] **Step 1: Bump the service-worker cache version**

Open `sw.js`, find the line `const CACHE = 'bmj-court-...'` and change the suffix to a new unique value (e.g. `bmj-court-2026-06-10-v1`, or increment the existing `vN`). Apply the **same** new value to `dist/sw.js`.

- [ ] **Step 2: Commit**

```bash
git add sw.js dist/sw.js
git commit -m "chore(sw): bump cache version for online-payment release"
```

- [ ] **Step 3: Confirm the deployment prerequisites (one-time)**

In Vercel project settings, confirm these env vars exist: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or anon). In the PayMongo dashboard (test mode), confirm a webhook is registered to `https://<your-vercel-domain>/api/paymongo-webhook` with event `checkout_session.payment.paid` enabled, and that its signing secret matches `PAYMONGO_WEBHOOK_SECRET`.

- [ ] **Step 4: Deploy**

Push the branch and deploy to a Vercel preview (or merge per your normal flow). Use PayMongo **test-mode** keys.

- [ ] **Step 5: Court happy path**

On the deployed URL, book a court end-to-end and complete a test payment. Expected: redirect back to `?payment=success` → "Verifying your payment…" → "Payment confirmed!" with a working Download Receipt. Then in Supabase, confirm a `bookings` row exists for that `booking_ref` (written by the webhook), and confirm it appears on the admin app.

- [ ] **Step 6: Open-play happy path**

Register for an open-play session and pay (test mode). Expected: "Payment confirmed — You're In!" with a player number; an `open_play_queue` row exists for that session + mobile; appears on admin.

- [ ] **Step 7: Court double-booking**

Try to book a slot that is already booked. Expected: the pre-pay re-check blocks it before redirecting. (If forced through by racing two payments, the webhook records a `booking_failures` row with `reason = 'slot_taken'` and returns 200 — verify in Supabase.)

- [ ] **Step 8: Open-play capacity**

Fill a session to `max_players`, then attempt one more registration + payment. Expected: blocked by the pre-pay check; if raced through, `register_open_play` returns `full` and a `booking_failures` row with `reason = 'full'` is recorded.

- [ ] **Step 9: Webhook idempotency**

In the PayMongo dashboard, re-send the same `checkout_session.payment.paid` event. Expected: no duplicate row is created (court: same `booking_ref` already exists and is skipped; open play: `register_open_play` returns `already_registered`).

---

## Self-review (completed against the spec)

- **Spec coverage:** online-only wiring (Tasks 4–5), webhook-sole-writer + client poll (Task 6), webhook unchanged-config + conflict/capacity handling (Tasks 2–3), DB guards (Task 1), pre-pay re-check (Task 7), notifications already-covered (no task needed — receipts/modal/email exist), SW bump + dual-file + deployed test (Task 8). All spec sections map to a task.
- **Placeholders:** none — every code step shows full code; `<REAL_SESSION_ID>` and `<your-vercel-domain>` are explicit runtime substitutions, not undefined plan content.
- **Type/name consistency:** `confirmPaidBooking` / `renderCourtPaidThankYou` / `renderOpPaidThankYou` defined in Task 6 and called only there; `register_open_play` params (`p_session_id`…) match the webhook RPC body in Task 3; `booking_failures` columns match every insert; `paymongo-btn` / `paymongo-op-btn` ids match what `payWithPaymongo()` / `payWithPaymongoOp()` query.

## Out of scope

Refund automation, booking cancellation, the waitlist feature, teaching the separate admin app to surface `booking_failures`, and removing the dead walk-in code (`finishBooking()`, `finishOpRegistration()`, the walk-in payment-method options) — all intentionally left as-is per the design.
