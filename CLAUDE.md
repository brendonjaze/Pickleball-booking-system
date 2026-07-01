# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server (Vite, with --host for LAN access)
npm run build    # Build to dist/
npm run preview  # Preview the dist/ build locally
```

No lint or test scripts are configured.

## Architecture

This is a **dual-track** app sharing one repo:

### Track 1 — Main booking app (`index.html`)
A **single-file vanilla JS app** (~5000+ lines). No framework, no build step required. All logic (UI rendering, Supabase calls, wizard state, service worker registration) lives in one HTML file.

- **State machine**: `wizardMode` (`'booking'` | `'openplay'`) controls which wizard runs.
  - Court booking: `wizardStep` + `renderWizard()`
  - Open play: `opWizardStep` + `opRenderWizard()`
- **Navigation**: History API (`history.pushState` / `popstate`) for hardware back-button support in both wizards. Each wizard step pushes a state entry; `popstate` reads `e.state.page` and `e.state.step` to restore.
- **Supabase**: CDN-loaded client (`/supabase.min.js`). Tables: `courts`, `bookings`, `open_play_sessions`, `open_play_queue`.
- **PWA**: Registered service worker at `/sw.js`. Cache name is versioned — **must bump `CACHE` version in both `sw.js` and `dist/sw.js` on every deploy** to force cache invalidation.
- **Receipts**: Generated with Canvas API → JPEG download. Toast notification (`showToast()`) shown on download.

### Track 2 — Court diagram (`court.html` + `src/`)
A React + Vite app. `court.html` uses `src/court-main.jsx` as entry point. `PickleballCourt.jsx` renders an SVG court diagram with Framer Motion animations. This is a **separate page**, not integrated into the booking wizard.

### `dist/` — Production build output (generated, do NOT hand-edit)
Vercel serves the **committed** `dist/` as the output directory (`vercel.json` uses `buildCommand: echo` — Vercel does not build). `dist/` is produced by **`npm run build`** (`vite build`), which builds BOTH `index.html` (entry `main`) and `court.html` (entry `court`) per `vite.config.js` `rollupOptions.input`, with `base: './'`. The build substitutes the `%VITE_*%` placeholders in `index.html` from `.env`, bundles `/src/*` module scripts into hashed `dist/assets/*.js`, hashes fonts into `dist/assets/`, and copies `public/*` (logo, QR images, `manifest.json`, `sw.js`, `supabase.min.js`) into `dist/`.

**Never hand-edit or `cp` into `dist/index.html`.** It has real config baked in (`SUPABASE_URL`, keys) and hashed asset paths the raw source lacks — copying the source over it ships `%VITE_%` placeholders (breaks `createClient` → blank prod app) and dev asset paths (JS/font 404s). Instead: edit the SOURCE (`index.html`, `court.html`, `public/*`) → run `npm run build` → commit the regenerated `dist/`.

## Critical Maintenance Rules

1. **Regenerate `dist/` via build**: After editing `index.html`, `court.html`, or anything in `public/`, run `npm run build` and commit the regenerated `dist/`. Do NOT hand-edit or `cp` into `dist/index.html` — it is build output (see the `dist/` section above).
2. **SW cache bump**: Increment the version suffix in `CACHE = 'bmj-court-YYYY-MM-DD-vN'` in **`public/sw.js`** on every deploy; `npm run build` copies it into `dist/sw.js`.
3. **`open_play_queue.skill_level`**: The Open Play wizard shows an **active** category selector offering `'beginner'` and `'novice'` (`index.html` ~line 5493). The chosen value flows through PayMongo metadata and is written server-side by the `register_open_play` RPC (`api/paymongo-webhook.js`) — `finishOpRegistration()` is legacy/unused. The column has a `CHECK` constraint; **keep the UI's category values in sync with whatever that constraint allows** — a value the constraint rejects makes a *paid* registration fail and require a manual refund. Verified by live test: `'novice'` is currently accepted.
4. **Static assets live in `public/`**: Images/QR codes/logo/`manifest.json` referenced from the root path go in `public/` — `npm run build` copies them into `dist/` automatically. Do not place them only in `dist/` (a rebuild would not reproduce them).

## Key Functions in `index.html`

| Function | Purpose |
|---|---|
| `renderWizard()` | Re-renders court booking wizard step |
| `opRenderWizard()` | Re-renders open play wizard step |
| `finishBooking()` | Inserts booking to Supabase, shows thank-you modal with receipt download |
| `finishOpRegistration()` | Inserts to `open_play_queue`, shows success inside modal |
| `buildAnnouncementHtml(a)` | Parses schedule string → structured HTML grouped by day/time |
| `showToast(msg)` | Shows floating toast notification |
| `fetchOpenPlay()` | Loads all enabled open play session dates into `openPlayDates` Set; used to block court booking on those dates |
