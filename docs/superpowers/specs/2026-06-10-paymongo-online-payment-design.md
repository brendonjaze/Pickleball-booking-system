# Re-enable PayMongo Online Payment (online-only, webhook-confirmed)

**Date:** 2026-06-10
**Status:** Approved design — ready for implementation plan

## Goal

Bring back PayMongo online payment for **both court rental and open play**, as the
**only** payment path (walk-in retired). A booking is saved **only after PayMongo
confirms payment**, the **webhook is the sole writer**, and the booking then appears
automatically on the separate admin app (which reads the same Supabase tables).
Double-booking is made impossible at the database layer.

## Decisions (agreed)

1. **Admin side** — a separate app/repo that reads Supabase `bookings` /
   `open_play_queue`. No admin code in this repo; the booking "reflects in admin"
   simply by the webhook inserting the row.
2. **Payment options** — online payment only. Walk-in path is retired.
3. **Test environment** — the deployed Vercel site (PayMongo cannot reach localhost).
4. **Write path** — webhook is the sole writer. On `?payment=success` the page
   polls Supabase until the webhook's row appears, then shows the receipt.
5. **Dead code** — leave the now-unused walk-in code in place (don't rip it out);
   keep the diff small.
6. **Double-booking** — fixed properly, not just flagged (see §6).

## Current state (what exists today)

- `payWithPaymongo()` (court) and `payWithPaymongoOp()` (open play) are fully
  implemented: they stash a `pendingBooking` in `sessionStorage`, create a PayMongo
  checkout session via the `/api/paymongo` proxy, and redirect to hosted checkout.
  **Nothing calls them** — they're orphaned.
- `wizardNext()` hard-codes `bookingPayment = 'Walk-in (Pay at venue)'` and jumps
  step 1 → step 3, skipping the payment step. Step 3 renders a "Walk-in Payment"
  screen and `finishBooking()` inserts the booking **directly** with the anon key.
- `opWizardNext()` mirrors this: forces walk-in, `finishOpRegistration()` inserts
  into `open_play_queue` directly.
- The `?payment=success` handler restores `pendingBooking` and calls
  `finishBooking()` / `finishOpRegistration()` (direct insert) — this becomes the
  poll-and-confirm flow instead.
- `api/paymongo-webhook.js` already verifies the PayMongo signature, handles both
  `court` and `openplay` metadata types, is idempotent, and writes with the service
  role key. This is the authoritative writer.

## Target flow

```
Wizard (summary -> name/phone -> review)
  -> "Proceed to Payment PHP X"  -> payWithPaymongo() / payWithPaymongoOp()
  -> redirect to PayMongo hosted checkout
  -> user pays
       |- PayMongo fires checkout_session.payment.paid -> /api/paymongo-webhook
       |     -> inserts row into bookings / open_play_queue   [AUTHORITATIVE -> admin]
       |     -> on slot conflict / session full: record booking_failure, return 200
       \- PayMongo redirects to ?payment=success
             -> modal shows "Verifying your payment..."
             -> poll Supabase for the row (by booking_ref / session_id+mobile)
             -> found  -> thank-you + downloadable receipt
             -> timeout-> "Payment received, booking processing, keep ref XXX"
```

## Changes by area

### 1. Frontend wizard rewiring (`index.html` AND `dist/index.html`)

**Court track**
- `wizardNext()`: remove the forced `bookingPayment = 'Walk-in'` + skip-to-3. The
  final review step's button calls `payWithPaymongo()` instead of `finishBooking()`.
- `renderStepContent()` step 3: replace the "Walk-in Payment" screen with a
  **Review & Pay** screen showing the total and a **Proceed to Payment** button
  (`id="paymongo-btn"`, `onclick="payWithPaymongo()"`).

**Open play track** (symmetric)
- `opWizardNext()`: remove forced walk-in; final button calls `payWithPaymongoOp()`.
- Open-play review step: Review & Pay screen with `id="paymongo-op-btn"` ->
  `payWithPaymongoOp()`.

### 2. Success redirect -> poll for the webhook's row (`?payment=success`)

- Refactor `finishBooking()` / `finishOpRegistration()` to **separate** "render
  thank-you UI" from "insert". Keep the rendering; **remove the insert** (webhook owns writes).
- On `?payment=success`: open the modal in a **"Verifying your payment..."** state and
  poll Supabase every ~1.5s for up to ~15s:
  - Court: `bookings` where `booking_ref = <ref>`.
  - Open play: `open_play_queue` where `session_id = <id>` AND `mobile = <phone>`.
  - **Found** -> render thank-you + receipt download.
  - **Timeout** -> "Payment received - your booking is being processed. Keep ref
    `<ref>` and contact us if it doesn't appear." (still allow receipt download).
- Client needs only SELECT on these tables (already granted; the app reads them for
  availability). No client INSERT anymore.

### 3. Webhook changes (`api/paymongo-webhook.js`)

- **Court conflict handling:** the batch insert is atomic (all-or-nothing). On a
  unique-violation (`23505` / HTTP 409), do **not** throw/500 (which makes PayMongo
  retry forever). Instead record a `booking_failures` row and **return 200**.
- **Open play:** replace the raw insert with a call to the `register_open_play`
  Postgres function (RPC) that atomically enforces capacity (see §6). If it returns
  `full`, record a `booking_failures` row and return 200. The function also handles
  already-registered idempotency internally.

### 4. Database migrations (Supabase SQL)

> Column types below must be confirmed against the live schema during implementation
> (e.g. `session_id` may be `bigint` or `uuid`).

1. **Court unique index** (dedupe existing duplicates first, then):
   `CREATE UNIQUE INDEX bookings_court_date_slot_uniq ON bookings (court_id, date, time_slot);`
   - No `cancelled` status exists today, so a plain unique index is correct. If
     cancellation is added later, switch to a partial index excluding cancelled
     (leave a SQL comment noting this).
2. **Open-play per-person unique index** (dedupe first, then):
   `CREATE UNIQUE INDEX open_play_queue_session_mobile_uniq ON open_play_queue (session_id, mobile);`
3. **`booking_failures` table** — durable refund trail:
   `id`, `created_at`, `type` (court|openplay), `booking_ref`, `payload` (jsonb of
   the webhook metadata), `reason` (slot_taken|session_full|...).
4. **`register_open_play(...)` function** — `SELECT max_players ... FOR UPDATE` on the
   session row to serialize concurrent registrations, then count vs capacity, then
   insert only if room. Returns a JSON result (`ok`, `status`, `reason`,
   `queue_number`). Webhook calls it via `POST /rest/v1/rpc/register_open_play`.

### 5. Config prerequisites (no code, but the test fails silently without them)

- **Vercel env vars:** `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (preferred; falls back to anon).
- **PayMongo dashboard:** register a webhook -> `https://<vercel-domain>/api/paymongo-webhook`,
  enable event `checkout_session.payment.paid`, copy its signing secret into
  `PAYMONGO_WEBHOOK_SECRET`.
- Use **PayMongo test-mode keys** for the trial run.

### 6. User notification — already covered

In-app thank-you modal + downloadable receipt, plus PayMongo's own emailed receipt
(`send_email_receipt: true` is already set in both pay functions). No new work.

## Maintenance rules (from CLAUDE.md)

- Apply every edit to **both** `index.html` and `dist/index.html`.
- **Bump the SW cache** version (`CACHE = 'bmj-court-...'`) in **both** `sw.js` and
  `dist/sw.js`, or returning users keep the cached walk-in version.

## Testing plan (on deployed Vercel)

1. Set env vars; register the PayMongo test-mode webhook; deploy.
2. **Court happy path:** book end-to-end, pay with a test method -> confirm a row
   appears in `bookings` (written by webhook) -> success page shows thank-you ->
   appears on the admin app.
3. **Open play happy path:** same, into `open_play_queue`.
4. **Court double-booking:** attempt an already-booked slot -> blocked at the pre-pay
   re-check; if forced through, webhook records a `booking_failures` row and returns 200.
5. **Open-play capacity:** fill a session to `max_players`, attempt one more ->
   blocked by `register_open_play`, `booking_failures` row recorded.
6. **Webhook retry / idempotency:** confirm a repeated webhook delivery does not
   create a duplicate.

## Out of scope

- Refunds automation, booking cancellation, and the waitlist feature (separate thread).
- Teaching the separate admin app to surface `booking_failures` (the data will exist
  in Supabase; surfacing it in admin is a separate change there).
- Removing the dead walk-in code.
