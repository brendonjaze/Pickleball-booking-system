# Time-Based Court Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically charge ₱150 for court slots starting before 6 PM and ₱200 for slots starting 6 PM–midnight, with the rates editable in the database.

**Architecture:** Add a single-row `pricing_settings` table in Supabase. The booking app (`index.html`) loads it once at startup into a global `PRICING` object and derives each slot's rate from its start hour (`9 + slotIndex`). Every place that previously used `count × price_per_hour` instead sums per-slot rates. If the config fails to load, the app falls back to the court's existing flat `price_per_hour`.

**Tech Stack:** Vanilla JS single-file app, Supabase REST (anon key), PWA service worker. No build step for `index.html`; `dist/index.html` is a manually maintained mirror.

## Global Constraints

- **Dual-file edits:** every edit to `index.html` must be applied identically to `dist/index.html`. (CLAUDE.md)
- **SW cache bump:** increment the version suffix in `CACHE = 'bmj-court-YYYY-MM-DD-vN'` in both `public/sw.js` and `dist/sw.js` on release. (The service-worker source is `public/sw.js`, served at `/sw.js`; there is no root `sw.js` despite CLAUDE.md's wording. Current value: `bmj-court-2026-06-21-v26`.)
- **Slot→hour invariant:** `TIME_SLOTS[0]` is the 9 AM slot, so slot index `i` starts at 24h hour `9 + i`. The 6 PM cutoff is hour `18` (index `9`).
- **Pricing config is one global row** shared by all courts (`daytime_rate`, `evening_rate`, `cutoff_hour`). Not per-court.
- **No automated test harness exists** (CLAUDE.md: "No lint or test scripts are configured"). Verification is (a) a DevTools console assertion snippet for the pure helper math, and (b) a manual browser walkthrough with exact expected peso values. There is no `npm test`.
- **No amount column in `bookings`:** the table stores one row per slot. Do NOT add price storage; totals are computed at display/payment time only.

---

### Task 1: Create `pricing_settings` table in Supabase

**Files:**
- Create: `db/migrations/2026-06-22-pricing-settings.sql` (committed for record; run manually in the Supabase SQL editor — matches the existing migration in that folder)

**Interfaces:**
- Produces: a table `pricing_settings` with exactly one row, columns `id` (int PK), `daytime_rate` (numeric), `evening_rate` (numeric), `cutoff_hour` (int). The app reads it via `GET /rest/v1/pricing_settings?select=*&order=id.asc&limit=1`.

- [ ] **Step 1: Write the SQL file**

Create `db/migrations/2026-06-22-pricing-settings.sql`, matching the house style of `db/migrations/2026-06-10-online-payment.sql` (path header, "safe to re-run", numbered sections, idempotent guards):

```sql
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
-- Admin edits use the service-role key (bypasses RLS), so no write policy is needed here.
```

- [ ] **Step 2: Run the SQL in Supabase**

Paste the file's contents into the Supabase dashboard → SQL Editor → Run.

- [ ] **Step 3: Verify the row exists and is readable with the anon key**

In the booking app's DevTools console (so `SUPABASE_URL` / `SUPABASE_ANON_KEY` are already defined), run:

```js
fetch(`${SUPABASE_URL}/rest/v1/pricing_settings?select=*&order=id.asc&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY } })
  .then(r => r.json()).then(console.log)
```

Expected: `[{ id: 1, daytime_rate: 150, evening_rate: 200, cutoff_hour: 18 }]` (numbers may print as strings — that's fine; the loader coerces with `Number()`).

- [ ] **Step 4: Commit**

```bash
git add db/migrations/2026-06-22-pricing-settings.sql
git commit -m "feat(db): add pricing_settings table for time-based court pricing"
```

---

### Task 2: Load pricing config + add pure pricing helpers

**Files:**
- Modify: `index.html` — add `PRICING`, `fetchPricing()`, helpers near `getSelSlotRange()` (~`:3995`), and call `fetchPricing()` at the two init sites (`:3394`, `:3467`)
- Modify: `dist/index.html` — identical edits

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (`:3121-3122`), `TIME_SLOTS` (`:3209`), `curCourt` (`:3224`)
- Produces (used by Task 3 & 4):
  - `let PRICING` — `null` or `{ daytimeRate:number, eveningRate:number, cutoffHour:number }`
  - `async function fetchPricing()` — populates `PRICING`
  - `function rateForHour(startHour)` → number
  - `function rateForSlotIndex(idx)` → number
  - `function rateForSlotLabel(label)` → number
  - `function rangeAmount(start, end)` → number (sum over index range, inclusive)
  - `function slotsAmount(slots)` → number (sum over an array of slot label strings)

- [ ] **Step 1: Add the config loader and helpers**

In `index.html`, immediately AFTER the `getSelSlotRange()` function (ends at `:4002`), insert:

```js
        // ── Time-based pricing ────────────────────────────────
        // Loaded once from the single-row pricing_settings table. Null until loaded;
        // helpers fall back to the court's flat price_per_hour if it never loads.
        let PRICING = null;   // { daytimeRate, eveningRate, cutoffHour }

        async function fetchPricing() {
            try {
                const res = await fetch(
                    `${SUPABASE_URL}/rest/v1/pricing_settings?select=*&order=id.asc&limit=1`,
                    { headers: { 'apikey': SUPABASE_ANON_KEY } }
                );
                const data = await res.json();
                if (Array.isArray(data) && data.length) {
                    const r = data[0];
                    PRICING = {
                        daytimeRate: Number(r.daytime_rate),
                        eveningRate: Number(r.evening_rate),
                        cutoffHour: Number(r.cutoff_hour),
                    };
                    console.log('[fetchPricing] Loaded', PRICING);
                }
            } catch (e) {
                console.error('[fetchPricing] failed — falling back to court price_per_hour', e);
            }
        }

        // Rate for a slot given its 24h start hour. Falls back to the court's flat rate.
        function rateForHour(startHour) {
            if (!PRICING) return Number(curCourt && curCourt.price_per_hour) || 0;
            return startHour >= PRICING.cutoffHour ? PRICING.eveningRate : PRICING.daytimeRate;
        }
        // TIME_SLOTS[0] is the 9 AM slot, so slot index i starts at hour (9 + i).
        function rateForSlotIndex(idx) { return rateForHour(9 + idx); }
        function rateForSlotLabel(label) {
            const idx = TIME_SLOTS.indexOf(label);
            return idx === -1 ? (Number(curCourt && curCourt.price_per_hour) || 0) : rateForSlotIndex(idx);
        }
        // Total for a contiguous index range (inclusive), e.g. selStart..selEnd.
        function rangeAmount(start, end) {
            let total = 0;
            for (let i = start; i <= end; i++) total += rateForSlotIndex(i);
            return total;
        }
        // Total for an array of slot label strings (e.g. getSelSlotRange()).
        function slotsAmount(slots) {
            return slots.reduce((sum, s) => sum + rateForSlotLabel(s), 0);
        }
```

- [ ] **Step 2: Call `fetchPricing()` at both init sites**

In `index.html` at `:3394`, change:

```js
                    await Promise.all([fetchCourts(), fetchOpenPlay()]);
```
to:
```js
                    await Promise.all([fetchCourts(), fetchOpenPlay(), fetchPricing()]);
```

And at `:3467`, change:

```js
            await Promise.all([fetchCourts(), fetchOpenPlay()]);
```
to:
```js
            await Promise.all([fetchCourts(), fetchOpenPlay(), fetchPricing()]);
```

- [ ] **Step 3: Apply the identical edits to `dist/index.html`**

Repeat Step 1 and Step 2 in `dist/index.html`. Search `dist/index.html` for `function getSelSlotRange` and for the two `Promise.all([fetchCourts(), fetchOpenPlay()])` lines and apply the same changes.

- [ ] **Step 4: Verify the helper math with a console assertion snippet**

Run the app (`npm run dev`), open it in the browser, open DevTools console, and run:

```js
(() => {
  const saved = PRICING;
  PRICING = { daytimeRate: 150, eveningRate: 200, cutoffHour: 18 };
  const checks = [
    ['9 AM slot (idx 0)', rateForSlotIndex(0), 150],
    ['5 PM slot (idx 8)', rateForSlotIndex(8), 150],
    ['6 PM slot (idx 9)', rateForSlotIndex(9), 200],
    ['11 PM slot (idx 14)', rateForSlotIndex(14), 200],
    ['range 0..2 (3 daytime)', rangeAmount(0, 2), 450],
    ['range 8..9 (boundary 150+200)', rangeAmount(8, 9), 350],
    ['range 9..11 (3 evening)', rangeAmount(9, 11), 600],
    ['slotsAmount labels', slotsAmount([TIME_SLOTS[8], TIME_SLOTS[9]]), 350],
  ];
  let ok = true;
  for (const [name, got, want] of checks) {
    if (got !== want) { ok = false; console.error('FAIL', name, 'got', got, 'want', want); }
    else console.log('PASS', name, got);
  }
  PRICING = saved;
  console.log(ok ? '✅ ALL PASS' : '❌ FAILURES ABOVE');
})();
```

Expected: every line `PASS` and a final `✅ ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add index.html dist/index.html
git commit -m "feat(pricing): load pricing_settings and add per-slot rate helpers"
```

---

### Task 3: Wire helpers into all price-display touchpoints

**Files:**
- Modify: `index.html` — `b-price` header (`:3683`), `renderSlots` per-slot label (`:4054`), `updateConfirm` (`:4092`), `renderStepContent` (`:4194`), `downloadReceipt` (`:4288`)
- Modify: `dist/index.html` — identical edits

**Interfaces:**
- Consumes from Task 2: `PRICING`, `rateForSlotIndex`, `rangeAmount`, `slotsAmount`

- [ ] **Step 1: Court header price range (`:3683`)**

Change:
```js
            document.getElementById('b-price').textContent = `₱${curCourt.price_per_hour}/hour`;
```
to:
```js
            document.getElementById('b-price').textContent = PRICING
                ? `₱${PRICING.daytimeRate}–${PRICING.eveningRate}/hour`
                : `₱${curCourt.price_per_hour}/hour`;
```

- [ ] **Step 2: Per-slot price label in `renderSlots` (`:4054`)**

`idx` is in scope (the `TIME_SLOTS.map((slot, idx) => …)` at `:4022`). Change:
```js
                <div class="slot-price">₱${curCourt.price_per_hour}</div>
```
to:
```js
                <div class="slot-price">₱${rateForSlotIndex(idx)}</div>
```

- [ ] **Step 3: Confirm-bar total in `updateConfirm` (`:4092`)**

Change:
```js
                const amount = n * curCourt.price_per_hour;
```
to:
```js
                const amount = rangeAmount(selStart, selEnd);
```
(`n` is still used for the duration label on `:4101`; leave it.)

- [ ] **Step 4: Review + payment-step total in `renderStepContent` (`:4194`)**

Change:
```js
            const amount = n * curCourt.price_per_hour;
```
to:
```js
            const amount = slotsAmount(slots);
```
(`slots` is defined just above at `:4192` as `getSelSlotRange()`; `n` is still used for the duration label.)

- [ ] **Step 5: Receipt total in `downloadReceipt` (`:4288`)**

Change:
```js
            const amount = n * curCourt.price_per_hour;
```
to:
```js
            const amount = slotsAmount(slots);
```
(`slots` is defined at `:4286`.)

- [ ] **Step 6: Apply the identical edits to `dist/index.html`**

Repeat Steps 1–5 in `dist/index.html`, locating each line by its surrounding code.

- [ ] **Step 7: Verify in the browser**

Run `npm run dev`, open the app, pick a court, and check each value against the table (assumes 150/200/cutoff 18):

| Action | Expected |
|---|---|
| Court header subtitle | `₱150–200/hour` |
| Slot tile "9:00 AM – 10:00 AM" | `₱150` |
| Slot tile "5:00 PM – 6:00 PM" | `₱150` |
| Slot tile "6:00 PM – 7:00 PM" | `₱200` |
| Slot tile "11:00 PM – 12:00 AM" | `₱200` |
| Select 9–10 AM only | Confirm button `₱150` |
| Select 9 AM–12 PM (3 daytime hrs) | Confirm button `₱450` |
| Select 5 PM–7 PM (5–6 PM + 6–7 PM) | Confirm button `₱350` |
| Select 6 PM–9 PM (3 evening hrs) | Confirm button `₱600` |
| Continue to Review step (boundary selection) | "Total Amount" shows `₱350` |
| Reach the Pay Online step | "Total amount" shows `₱350` |

All values must match. If any differ, stop and debug before committing.

- [ ] **Step 8: Commit**

```bash
git add index.html dist/index.html
git commit -m "feat(pricing): apply time-based rates to slot labels, totals, review, and receipt"
```

---

### Task 4: Apply tiered total to the Paymongo charge + release (SW cache bump)

**Files:**
- Modify: `index.html` — `payWithPaymongo` amount (`:4695`)
- Modify: `dist/index.html` — identical edit
- Modify: `public/sw.js` and `dist/sw.js` — bump `CACHE` version

**Interfaces:**
- Consumes from Task 2: `slotsAmount`

- [ ] **Step 1: Use the tiered total for the Paymongo charge (`:4695`)**

Change:
```js
            const amount = slots.length * curCourt.price_per_hour;
```
to:
```js
            const amount = slotsAmount(slots);
```
Leave `amount * 100` at `:4749` unchanged (Paymongo still expects centavos), and leave the `Booking for ${slots.length} hour(s)` description unchanged.

- [ ] **Step 2: Apply the identical edit to `dist/index.html`**

Locate the same line in `dist/index.html` (inside `payWithPaymongo`) and apply it.

- [ ] **Step 3: Bump the service-worker cache version**

In `public/sw.js`, change the current line `const CACHE = 'bmj-court-2026-06-21-v26';` to `const CACHE = 'bmj-court-2026-06-22-v1';`. Apply the **same** new value to the matching line in `dist/sw.js` (currently also `bmj-court-2026-06-21-v26`). Both files must end up identical.

- [ ] **Step 4: Verify the Paymongo amount matches the displayed total**

Run `npm run dev`, select a boundary range (5 PM–7 PM, expected `₱350`), proceed to the Pay Online step, click "Proceed to Payment", and in DevTools → Network inspect the POST to `/api/paymongo/checkout_sessions`. Confirm the request body `line_items[0].amount` is `35000` (₱350 × 100 centavos).

Expected: `amount: 35000`, matching the on-screen `₱350`.

- [ ] **Step 5: Confirm `index.html` and `dist/index.html` pricing regions match**

Run:
```bash
git --no-pager diff --no-index -- index.html dist/index.html | grep -iE "rateForSlot|rangeAmount|slotsAmount|PRICING|fetchPricing" || echo "no pricing-line differences"
```
Expected: `no pricing-line differences` (the two files use identical pricing code).

- [ ] **Step 6: Commit**

```bash
git add index.html dist/index.html sw.js dist/sw.js
git commit -m "feat(pricing): charge tiered total via Paymongo; bump SW cache"
```

---

## Out of Scope (do not implement here)

- Admin UI to edit the rates (lives in the separate admin repo). Until built, edit the `pricing_settings` row directly in Supabase.
- Per-court rates, changing the 9 AM–midnight slot range, wall-clock-based pricing.

## Post-Implementation Note

After this branch ships, the admin repo needs a small form reading/writing `pricing_settings` (`daytime_rate`, `evening_rate`, `cutoff_hour`) for non-developer edits. Track that as a separate task in that repo.
