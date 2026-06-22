# Time-Based Court Pricing — Design

**Date:** 2026-06-22
**Status:** Approved (design), pending implementation plan

## Goal

Automatically charge a different court rental rate depending on the time of day of the booked slot:

- **₱150** for slots starting **9:00 AM through 5:59 PM** (daytime)
- **₱200** for slots starting **6:00 PM through 12:00 midnight** (evening)

This must happen automatically — no manual switching — and the rate values must be editable by admin without a developer.

## Key Decisions

1. **One global rule for all courts.** Every court uses the same daytime/evening rates. Not per-court.
2. **Rates stored in the database.** So admin can change them without a code change/redeploy.
3. **Pricing is based on the slot's time of day, not the wall-clock moment of booking.** A 6–7 PM slot always costs ₱200, even if booked at noon. (Correct behavior for advance bookings.)

## Why This Is Clean

Time slots already run 9 AM → midnight in 1-hour blocks (`TIME_SLOTS`, `index.html:3209`), and slots are selected as a contiguous index range (`selStart`…`selEnd`). Because the array starts at 9 AM:

```
slot start hour = 9 + index
```

So the 6 PM cutoff is exactly **index 9** (9 + 9 = 18). Pricing can be derived from the slot index with no string parsing:

- index 0–8  → 9 AM–5 PM start → daytime (₱150)
- index 9–14 → 6 PM–11 PM start → evening (₱200)

Each slot falls cleanly on one side of the boundary, so there is no partial/mid-hour boundary case.

## Architecture

### 1. Data / Storage (Supabase)

New single-row table `pricing_settings`:

| column | type | example | meaning |
|---|---|---|---|
| `id` | int (PK) | 1 | single config row |
| `daytime_rate` | numeric | 150 | rate for slots starting before cutoff |
| `evening_rate` | numeric | 200 | rate for slots starting at/after cutoff |
| `cutoff_hour` | int | 18 | 24h hour the evening rate begins |

- Read access via the existing Supabase anon key (same pattern as `courts`).
- `courts.price_per_hour` is **kept** as a fallback used only if the config fetch fails, so nothing breaks on error.

### 2. Booking App (`index.html` + mirrored `dist/index.html`)

- **Load config:** fetch the one `pricing_settings` row in/around `fetchCourts()` into a module-level `PRICING` object `{ daytimeRate, eveningRate, cutoffHour }`, with safe fallbacks to `price_per_hour` if missing.
- **Helpers:**
  - `rateForSlotIndex(i)` → `(9 + i) >= PRICING.cutoffHour ? PRICING.eveningRate : PRICING.daytimeRate`
  - `rangeAmount(selStart, selEnd)` → sum of `rateForSlotIndex(i)` over the selected range (replaces `n * price_per_hour`)
- **Update every price touchpoint:**
  | Location | Current | Change |
  |---|---|---|
  | `renderSlots()` ~`:4054` | `₱${curCourt.price_per_hour}` per slot | show each slot's own rate via `rateForSlotIndex(idx)` |
  | `updateConfirm()` ~`:4092` | `n * price_per_hour` | `rangeAmount(selStart, selEnd)` |
  | Review modal total ~`:4194` | `n * price_per_hour` | `rangeAmount(...)` |
  | Payment step + Paymongo `amount` ~`:4695`, `:4749` | `n * price_per_hour` | `rangeAmount(...)` (must match exactly or payment breaks) |
  | Receipt canvas total ~`:4288`/`:4381` | `n * price_per_hour` | `rangeAmount(...)` |
  | Court header `b-price` `:3683` | `₱X/hour` | show range, e.g. `₱150–200/hr` |
- **Booking insert (`finishBooking`):** verify the stored total uses the computed `rangeAmount`, not the flat rate.

### 3. Admin Side (separate repo — out of scope for this repo)

For admin to edit the rates, the admin repo needs a small form that reads/writes the `pricing_settings` row (`daytime_rate`, `evening_rate`, `cutoff_hour`). This cannot be changed from this repo; it is a separate follow-up task. The booking-app changes here work as soon as the table exists and has a row, regardless of whether the admin UI is built yet.

## Maintenance Rules (from CLAUDE.md)

- All `index.html` edits mirrored to `dist/index.html`.
- Bump `CACHE` version in both `sw.js` and `dist/sw.js`.

## Out of Scope

- Per-court tiered rates.
- Admin UI (separate repo).
- Changing the 9 AM–midnight slot range.
- Wall-clock / "current time" based pricing.

## Acceptance Criteria

- Selecting only daytime slots totals `count × 150`.
- Selecting only evening slots totals `count × 200`.
- A selection spanning the boundary (e.g. 5–6 PM + 6–7 PM) totals `150 + 200 = 350`.
- Per-slot price labels show ₱150 before 6 PM and ₱200 from 6 PM on.
- Confirm button, review modal, Paymongo charge, and receipt all show the same correct total.
- Changing values in `pricing_settings` changes prices in the app with no code change.
- If the config fetch fails, the app falls back gracefully and still functions.
