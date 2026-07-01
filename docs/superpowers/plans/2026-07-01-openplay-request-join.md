# Open Play Request-to-Join + Group Chat + Receipt Approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PayMongo for open play with a request → post GCash/QR receipt in a per-session group chat → organizer approves → confirmed flow, identified by a device token.

**Architecture:** A new `open_play_join_requests` table holds pending/approved/declined requests; approval inserts the player into the existing `open_play_queue` (its triggers assign queue number + receipt). A new `open_play_messages` table is a per-session group chat; receipt images go to a Supabase Storage bucket `openplay-receipts`. The player (booking app, CDN `supabase-js` = `db`) gets realtime chat + status; the admin panel (raw REST, no realtime) polls.

**Tech Stack:** Vanilla JS single-file `index.html` (+ manual `dist/index.html` mirror) with CDN `supabase-js`; admin `src/main.js` (Vite, raw REST `sbFetch`); Supabase (Postgres + Storage + Realtime).

## Global Constraints

- **DB migration is already applied** (`db/migrations/2026-07-01-openplay-request-join.sql`) and must not be re-designed here. Tables/RPCs available: `open_play_join_requests`, `open_play_messages`, `approve_open_play_request(p_request_id uuid)`, `get_open_play_request(p_token text, p_session_id uuid)`. Storage bucket: `openplay-receipts` (public).
- **Dual-file rule:** every edit to `index.html` must be mirrored verbatim into `dist/index.html`.
- **SW cache bump:** bump `CACHE = 'bmj-court-YYYY-MM-DD-vN'` in BOTH `public/sw.js` and `dist/sw.js` on completion.
- **Do NOT touch `open_play_queue` schema or its triggers.** Confirmed players are created only via the `approve_open_play_request` RPC.
- **Storage = Supabase Storage** (`openplay-receipts`). ImgBB is retired (it produced broken images).
- **Skill categories** stay `beginner` / `novice` (existing UI + CHECK constraint).
- No test framework exists. "Verify" = `node --check` on an extracted script for `index.html`, `npm run build` for admin, plus the manual end-to-end checklist in Task 9.

## Data / interface contracts (shared across tasks)

- `localStorage['op_player_token']` — device token (uuid string), created once via `crypto.randomUUID()`.
- `localStorage['op_req_' + sessionId]` — JSON `{ requestId: uuid, token: string }` for that session.
- Booking app globals available: `db` (supabase-js client), `openPlaySession` (current session object with `id,date,start_time,end_time,price_per_player,max_players`), `openPlayRegCount`, `escHtml()`, `fmtDate()`, `fmtTime()`, `showToast()`.
- Request row shape (from `get_open_play_request`): `{ id, status: 'pending'|'approved'|'declined', player_name, skill_level, queue_id }`.
- Message row shape: `{ id, session_id, sender_token, sender_name, is_organizer, body, image_url, created_at }`.

## File structure

- `index.html` — add token/storage/upload helpers, chatroom UI + realtime, rework op wizard, retire PayMongo-op. (~+300 lines, one `<script>`.)
- `dist/index.html` — verbatim mirror.
- `public/sw.js`, `dist/sw.js` — cache bump.
- `src/main.js` (admin) — request data helpers, pending-requests UI, approve/decline, organizer chat view + polling.

---

### Task 1: Booking app — token, per-session request storage, and receipt upload helpers

**Files:**
- Modify: `index.html` (add a new helper block near the other open-play helpers, ~after line 5490)

**Interfaces:**
- Produces: `opPlayerToken()` → string; `opGetSavedRequest(sessionId)` → `{requestId,token}|null`; `opSaveRequest(sessionId, requestId)` → void; `opUploadReceipt(file)` → `Promise<string>` (public URL).

- [ ] **Step 1: Add the helpers**

```js
// ── Open Play: device identity + receipt upload ───────────────────────
function opPlayerToken() {
    let t = localStorage.getItem('op_player_token');
    if (!t) { t = crypto.randomUUID(); localStorage.setItem('op_player_token', t); }
    return t;
}
function opGetSavedRequest(sessionId) {
    try { return JSON.parse(localStorage.getItem('op_req_' + sessionId) || 'null'); }
    catch { return null; }
}
function opSaveRequest(sessionId, requestId) {
    localStorage.setItem('op_req_' + sessionId, JSON.stringify({ requestId, token: opPlayerToken() }));
}
// Upload a receipt image to Supabase Storage; returns its public URL.
async function opUploadReceipt(file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${opPlayerToken()}/${Date.now()}.${ext}`;
    const { error } = await db.storage.from('openplay-receipts').upload(path, file, {
        cacheControl: '3600', upsert: false, contentType: file.type || 'image/jpeg'
    });
    if (error) throw error;
    return db.storage.from('openplay-receipts').getPublicUrl(path).data.publicUrl;
}
```

- [ ] **Step 2: Verify syntax** — extract the `<script>` block to a temp file and check:

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');fs.writeFileSync(process.env.TEMP+'/op_check.js',m);" && node --check "$TEMP/op_check.js" && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(openplay): add device-token, request-storage, receipt-upload helpers"
```

---

### Task 2: Booking app — rework the wizard to "Request to Join" (retire PayMongo)

**Files:**
- Modify: `index.html` — `OP_WIZARD_STEPS` (~5493), `opRenderStepContent()` (~5534), `opRenderFooter()` (~5630), `opWizardNext()` (~5643); remove the step-2/step-3 payment UI usage.

**Interfaces:**
- Consumes: helpers from Task 1; `opName`, `opPhone`, `opSkillLevel`, `openPlaySession`.
- Produces: `opSubmitRequest()` → `Promise<void>` (inserts a pending request, saves it, opens the chatroom via `opOpenChat(session)` from Task 3).

- [ ] **Step 1: Reduce the wizard to three steps.** Replace `OP_WIZARD_STEPS` with:

```js
const OP_WIZARD_STEPS = [
    { label: 'Review', icon: '&#128203;' },
    { label: 'Your Details', icon: '&#128100;' },
    { label: 'Chat & Pay', icon: '&#128172;' },
];
```

- [ ] **Step 2: Replace step-2 rendering** in `opRenderStepContent()` (the `else if (opWizardStep === 2)` and the old `=== 3` block) with a single request-confirmation screen shown at step 2:

```js
} else if (opWizardStep === 2) {
    body.innerHTML = `
    <div style="text-align:center;padding:1.25rem 1rem;">
        <div style="font-size:2.6rem;margin-bottom:0.5rem;">&#128172;</div>
        <div style="font-size:1.05rem;font-weight:800;color:var(--green-dark);margin-bottom:0.5rem;">Request to Join</div>
        <p style="font-size:0.88rem;color:#555;line-height:1.6;margin-bottom:1rem;">
            Tap below to send your request. You'll enter the session chat where you
            <strong>post your GCash/QR payment receipt</strong>. The organizer confirms your spot after reviewing it.
        </p>
        <div class="m-total-card" style="margin-bottom:1rem;">
            <div class="m-total-label">Amount per player</div>
            <div class="m-total-amount">&#8369;${Number(openPlaySession?.price_per_player || 0).toLocaleString()}</div>
        </div>
        <button id="op-request-btn" onclick="opSubmitRequest()" style="
            width:100%;background:var(--green-dark);color:#fff;border:none;border-radius:10px;
            padding:0.85rem 1.3rem;font-size:0.95rem;font-weight:700;cursor:pointer;font-family:'Montserrat',sans-serif;">
            Request to Join &amp; Open Chat
        </button>
    </div>`;
}
```

- [ ] **Step 3: Simplify `opWizardNext()` and footer** so step 1 advances to step 2 (no PayMongo). Replace `opWizardNext()`:

```js
async function opWizardNext() {
    if (opWizardStep === 1) { opWizardStep = 2; }
    else if (opWizardStep < 2) { opWizardStep++; }
    history.pushState({ page: 'openplay-wizard', step: opWizardStep }, '');
    opRenderWizard();
}
```

And in `opRenderFooter()` change the step-3 hide condition to step 2 (hide Next on the request step):

```js
if (opWizardStep === 2) { next.style.display = 'none'; }
else {
    next.style.display = '';
    next.innerHTML = 'Next &#8594;';
    next.disabled = opWizardStep === 1 ? (opName.length < 2 || opPhone.length < 10 || !opSkillLevel) : false;
}
```

- [ ] **Step 4: Add `opSubmitRequest()`** (place near the wizard):

```js
async function opSubmitRequest() {
    const btn = document.getElementById('op-request-btn');
    const s = openPlaySession;
    if (!s) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending request…'; }
    try {
        const token = opPlayerToken();
        const { data, error } = await db.from('open_play_join_requests')
            .insert({ session_id: s.id, player_name: opName, mobile: opPhone,
                      skill_level: opSkillLevel || 'beginner', player_token: token, status: 'pending' })
            .select('id').single();
        if (error) {
            // Duplicate (unique session_id+mobile) → already requested; just open chat.
            if (error.code === '23505') {
                const { data: existing } = await db.rpc('get_open_play_request', { p_token: token, p_session_id: s.id });
                if (existing?.id) opSaveRequest(s.id, existing.id);
                showToast('You already requested to join — opening chat.');
                opOpenChat(s);
                return;
            }
            throw error;
        }
        opSaveRequest(s.id, data.id);
        opOpenChat(s);
    } catch (e) {
        console.error('[opSubmitRequest]', e);
        showToast('Could not send request. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = 'Request to Join & Open Chat'; }
    }
}
```

- [ ] **Step 5: Delete `payWithPaymongoOp()`** (the open-play PayMongo function, ~lines 4914–4997) and any call to it. Court booking's PayMongo is untouched — only the open-play variant is removed.

- [ ] **Step 6: Verify syntax** (same command as Task 1 Step 2). Expected `SYNTAX_OK`.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(openplay): replace PayMongo join with Request-to-Join flow"
```

---

### Task 3: Booking app — session chatroom view (render, send text, upload receipt, status banner)

**Files:**
- Modify: `index.html` — add chatroom functions near the wizard.

**Interfaces:**
- Consumes: Task 1 helpers; `db`, `escHtml`, `showToast`.
- Produces: `opOpenChat(session)` → void; `opRenderChat()`; `opLoadMessages()`; `opRefreshStatus()`; `opSendMessage()`; `opChatUpload(input)`. Module state: `opChatSession`, `opChatMessages`, `opChatStatus`.

- [ ] **Step 1: Add chat state + open/close**

```js
let opChatSession = null, opChatMessages = [], opChatStatus = 'pending';
function opOpenChat(session) {
    opChatSession = session;
    opChatMessages = [];
    opChatStatus = 'pending';
    document.getElementById('steps-bar').innerHTML = '';
    opRenderChat();
    opLoadMessages();
    opRefreshStatus();
    opSubscribeChat();   // Task 4
}
```

- [ ] **Step 2: Add render + banner**

```js
function opStatusBanner() {
    if (opChatStatus === 'approved')
        return `<div style="background:var(--green-light);border:2px solid var(--green-dark);color:var(--green-dark);border-radius:10px;padding:0.6rem 0.8rem;font-weight:700;font-size:0.85rem;">&#10003; You're confirmed! You're in this session.</div>`;
    if (opChatStatus === 'declined')
        return `<div style="background:#fdecea;border:2px solid #ef5350;color:#c62828;border-radius:10px;padding:0.6rem 0.8rem;font-weight:700;font-size:0.85rem;">Your request was declined. Contact the organizer in chat.</div>`;
    return `<div style="background:#fff8e1;border:2px solid #f6c343;color:#8a6d00;border-radius:10px;padding:0.6rem 0.8rem;font-weight:600;font-size:0.85rem;">Pending — post your GCash/QR receipt below and wait for the organizer to confirm.</div>`;
}
function opRenderChat() {
    const body = document.getElementById('modal-body');
    const myToken = opPlayerToken();
    const rows = opChatMessages.map(m => {
        const mine = m.sender_token === myToken && !m.is_organizer;
        const who = m.is_organizer ? 'Organizer' : (m.sender_name || 'Player');
        const align = mine ? 'flex-end' : 'flex-start';
        const bg = m.is_organizer ? '#e8f0fe' : (mine ? 'var(--green-light)' : '#f1f1f1');
        const img = m.image_url ? `<img src="${escHtml(m.image_url)}" style="max-width:180px;border-radius:8px;display:block;margin-top:4px;"/>` : '';
        const txt = m.body ? escHtml(m.body) : '';
        return `<div style="display:flex;flex-direction:column;align-items:${align};margin-bottom:8px;">
            <div style="font-size:0.68rem;color:#888;margin-bottom:2px;">${escHtml(who)}</div>
            <div style="max-width:80%;background:${bg};border-radius:10px;padding:6px 10px;font-size:0.85rem;word-break:break-word;">${txt}${img}</div>
        </div>`;
    }).join('') || `<div style="text-align:center;color:#aaa;font-size:0.82rem;padding:1rem;">No messages yet. Post your receipt to get started.</div>`;
    body.innerHTML = `
        <div style="margin-bottom:0.6rem;">${opStatusBanner()}</div>
        <div id="op-chat-scroll" style="height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:8px;background:#fff;">${rows}</div>
        <div id="op-chat-preview" style="margin-top:6px;"></div>
        <div style="display:flex;gap:6px;margin-top:8px;align-items:center;">
            <label style="cursor:pointer;font-size:1.3rem;" title="Attach receipt">&#128206;
                <input type="file" accept="image/*" style="display:none;" onchange="opChatUpload(this)"/></label>
            <input id="op-chat-input" type="text" placeholder="Message…" style="flex:1;padding:0.55rem 0.7rem;border:2px solid var(--border);border-radius:10px;font-family:inherit;"
                   onkeydown="if(event.key==='Enter'){opSendMessage();}"/>
            <button onclick="opSendMessage()" style="background:var(--green-dark);color:#fff;border:none;border-radius:10px;padding:0.55rem 0.9rem;font-weight:700;cursor:pointer;">Send</button>
        </div>`;
    const sc = document.getElementById('op-chat-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
}
```

- [ ] **Step 3: Add load, status, send, upload**

```js
async function opLoadMessages() {
    const { data } = await db.from('open_play_messages')
        .select('*').eq('session_id', opChatSession.id).order('created_at', { ascending: true });
    opChatMessages = data || [];
    opRenderChat();
}
async function opRefreshStatus() {
    const { data } = await db.rpc('get_open_play_request',
        { p_token: opPlayerToken(), p_session_id: opChatSession.id });
    if (data?.status) { opChatStatus = data.status; opRenderChat(); }
}
async function opSendMessage(imageUrl) {
    const input = document.getElementById('op-chat-input');
    const body = input ? input.value.trim() : '';
    if (!body && !imageUrl) return;
    if (input) input.value = '';
    const { error } = await db.from('open_play_messages').insert({
        session_id: opChatSession.id, sender_token: opPlayerToken(),
        sender_name: opName || 'Player', is_organizer: false,
        body: body || null, image_url: imageUrl || null
    });
    if (error) { showToast('Message failed to send.'); if (input && body) input.value = body; }
}
async function opChatUpload(inputEl) {
    const file = inputEl.files[0]; if (!file) return;
    const prev = document.getElementById('op-chat-preview');
    if (prev) prev.innerHTML = `<span style="font-size:0.8rem;color:#888;">Uploading receipt…</span>`;
    try {
        const url = await opUploadReceipt(file);
        await opSendMessage(url);
        if (prev) prev.innerHTML = '';
    } catch (e) {
        console.error('[opChatUpload]', e);
        if (prev) prev.innerHTML = `<span style="font-size:0.8rem;color:#c62828;">Upload failed — try again.</span>`;
    } finally { inputEl.value = ''; }
}
```

- [ ] **Step 4: Verify syntax** (Task 1 Step 2 command). Expected `SYNTAX_OK`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(openplay): session group chatroom with receipt upload + status banner"
```

---

### Task 4: Booking app — realtime chat + status, and re-entry from the open-play card

**Files:**
- Modify: `index.html` — add subscription functions; hook a "Open chat" affordance where the open-play session card is rendered (search for `openOpWizard(` call site).

**Interfaces:**
- Consumes: Task 3 state/functions.
- Produces: `opSubscribeChat()`, `opUnsubscribeChat()`; module state `opChatChan`.

- [ ] **Step 1: Add subscription (new messages + status re-check on each message)**

```js
let opChatChan = null;
function opSubscribeChat() {
    opUnsubscribeChat();
    opChatChan = db.channel('op-chat-' + opChatSession.id)
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'open_play_messages', filter: `session_id=eq.${opChatSession.id}` },
            payload => {
                opChatMessages.push(payload.new);
                opRenderChat();
                if (opChatStatus !== 'approved') opRefreshStatus(); // organizer often approves around chat activity
            })
        .subscribe();
}
function opUnsubscribeChat() {
    if (opChatChan) { db.removeChannel(opChatChan); opChatChan = null; }
}
```

- [ ] **Step 2: Unsubscribe on modal close.** Find the open-play modal close handler (`closeModal()` / the modal `popstate`) and call `opUnsubscribeChat()` there. Add a slow fallback poll while chat is open: inside `opOpenChat`, start `opStatusPoll = setInterval(opRefreshStatus, 12000)`; clear it in `opUnsubscribeChat` (`clearInterval(opStatusPoll)`).

- [ ] **Step 3: Re-entry.** Where the open-play session card shows the "Join Open Play" button, also render an "Open chat / status" button when `opGetSavedRequest(session.id)` is truthy, calling `opOpenChat(session)` after setting `openPlaySession`, `opName`, `opPhone` from the saved values (name/phone re-prompt not required; `opName` may be empty — messages then send as 'Player').

- [ ] **Step 4: Verify syntax** (Task 1 Step 2 command). Expected `SYNTAX_OK`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(openplay): realtime chat + live status + chat re-entry"
```

---

### Task 5: Booking app — mirror to `dist/` and bump the service worker

**Files:**
- Overwrite: `dist/index.html` with `index.html`.
- Modify: `public/sw.js`, `dist/sw.js` — bump `CACHE`.

- [ ] **Step 1: Mirror** `index.html` → `dist/index.html` (verbatim copy of the file).

Run: `cp index.html dist/index.html && echo MIRRORED`
Expected: `MIRRORED`

- [ ] **Step 2: Bump SW cache** in both files, e.g. `bmj-court-2026-07-01-v1` (increment if today already used).

- [ ] **Step 3: Verify** the two index files match.

Run: `diff index.html dist/index.html && echo IDENTICAL`
Expected: `IDENTICAL`

- [ ] **Step 4: Commit**

```bash
git add index.html dist/index.html public/sw.js dist/sw.js
git commit -m "chore(openplay): mirror dist + bump SW cache"
```

---

### Task 6: Admin — request data helpers

**Files:**
- Modify: `src/main.js` — add helpers near the other open-play API functions (~line 551).

**Interfaces:**
- Produces: `fetchOpenPlayRequests(sessionId)` (pending only), `approveOpenPlayRequest(requestId)`, `declineOpenPlayRequest(requestId)`, `fetchOpenPlayMessages(sessionId)`, `postOpenPlayMessage(sessionId, body, imageUrl)`.

- [ ] **Step 1: Add helpers** (uses existing `sbFetch`, which sends the admin JWT):

```js
async function fetchOpenPlayRequests(sessionId) {
  return sbFetch(`open_play_join_requests?session_id=eq.${sessionId}&status=eq.pending&select=*&order=created_at.asc`);
}
async function approveOpenPlayRequest(requestId) {
  const res = await sbFetch('rpc/approve_open_play_request', {
    method: 'POST', body: JSON.stringify({ p_request_id: requestId }),
  });
  return Array.isArray(res) ? res[0] : res;
}
async function declineOpenPlayRequest(requestId) {
  return sbFetch(`open_play_join_requests?id=eq.${requestId}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'declined', decided_at: new Date().toISOString() }),
  });
}
async function fetchOpenPlayMessages(sessionId) {
  return sbFetch(`open_play_messages?session_id=eq.${sessionId}&select=*&order=created_at.asc`);
}
async function postOpenPlayMessage(sessionId, body, imageUrl) {
  return sbFetch('open_play_messages', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, sender_name: 'Organizer', is_organizer: true,
                           body: body || null, image_url: imageUrl || null }),
  });
}
```

- [ ] **Step 2: Verify build**

Run: `npm --prefix "C:/Users/brendon.lambago/Pickleball Booking System (admin panel)" run build`
Expected: `✓ built` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(admin/openplay): request + chat data helpers"
```

---

### Task 7: Admin — pending-requests UI with Approve / Decline

**Files:**
- Modify: `src/main.js` — `renderRegistrationsPanel(row, maxPlayers)` (~2080) to add a Pending section; wire buttons; poll while a session is expanded.

**Interfaces:**
- Consumes: Task 6 helpers; existing `fetchOpenPlayRegistrations`, `showToast`.
- Produces: `renderPendingRequests(sessionId, containerEl)`; approve/decline click handlers.

- [ ] **Step 1: Render a Pending block** above the confirmed list inside the registrations panel. After the panel's confirmed list renders, fetch and render pending requests:

```js
async function renderPendingRequests(sessionId, containerEl) {
  const reqs = await fetchOpenPlayRequests(sessionId);
  if (!containerEl) return;
  if (!reqs.length) { containerEl.innerHTML = ''; return; }
  containerEl.innerHTML = `
    <div class="op-pending-title" style="font-weight:700;margin:0.5rem 0;">Pending requests (${reqs.length})</div>
    ${reqs.map(r => `
      <div class="op-pending-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;">
        <span style="flex:1;">${r.player_name || '—'} · ${r.mobile || '—'} · ${r.skill_level}</span>
        <button class="btn-approve-req" data-id="${r.id}" style="background:#2e7d32;color:#fff;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;">Approve</button>
        <button class="btn-decline-req" data-id="${r.id}" style="background:#c62828;color:#fff;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;">Decline</button>
      </div>`).join('')}`;
  containerEl.querySelectorAll('.btn-approve-req').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    const res = await approveOpenPlayRequest(b.dataset.id);
    if (res && res.ok) { showToast('Player approved.'); }
    else { showToast(res && res.reason === 'full' ? 'Session is full.' : 'Approve failed.', true); b.disabled = false; return; }
    // refresh confirmed list + pending
    refreshRegistrationsPanel(sessionId, containerEl);
  }));
  containerEl.querySelectorAll('.btn-decline-req').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    await declineOpenPlayRequest(b.dataset.id);
    showToast('Request declined.');
    renderPendingRequests(sessionId, containerEl);
  }));
}
```

- [ ] **Step 2: Add `refreshRegistrationsPanel(sessionId, pendingEl)`** that re-fetches the confirmed registrations (existing `fetchOpenPlayRegistrations`) and re-renders both the confirmed list and pending block. Reuse the existing confirmed-render code path.

- [ ] **Step 3: Poll** — when a session row is expanded, start `setInterval(() => renderPendingRequests(sessionId, pendingEl), 10000)`; store the id on the row element and `clearInterval` when the row collapses/closes. (Follow the existing expand/collapse handler in `renderSessionRow`.)

- [ ] **Step 4: Fix the confirmed-list timestamp bug** discovered during schema work: the registrations render uses `r.created_at`, which does not exist — change it to `r.joined_at`.

- [ ] **Step 5: Verify build** (Task 6 Step 2). Expected `✓ built`.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat(admin/openplay): pending requests with approve/decline + poll; fix joined_at"
```

---

### Task 8: Admin — organizer chat view (view receipts + reply)

**Files:**
- Modify: `src/main.js` — add a chat panel (modal or inline) opened from a session, using Task 6 helpers; poll while open.

**Interfaces:**
- Consumes: `fetchOpenPlayMessages`, `postOpenPlayMessage`.
- Produces: `openOrganizerChat(sessionId)`, `renderOrganizerChat(sessionId)`.

- [ ] **Step 1: Add an "Open chat" button** to each session row (near the registrations toggle) that calls `openOrganizerChat(session.id)`.

- [ ] **Step 2: Render chat** into a modal/panel with the same message layout as the player side (organizer messages right-aligned), an input, and a Send button calling `postOpenPlayMessage(sessionId, text)` then re-render. Receipts render as `<img src="${escaped image_url}">`. Poll `fetchOpenPlayMessages` every 4s while open; clear on close.

```js
let orgChatSession = null, orgChatPoll = null;
async function renderOrganizerChat(sessionId) {
  const msgs = await fetchOpenPlayMessages(sessionId);
  const el = document.getElementById('org-chat-scroll'); if (!el) return;
  el.innerHTML = msgs.map(m => {
    const who = m.is_organizer ? 'Organizer' : (m.sender_name || 'Player');
    const align = m.is_organizer ? 'flex-end' : 'flex-start';
    const img = m.image_url ? `<img src="${escapeHtml(m.image_url)}" style="max-width:180px;border-radius:8px;display:block;margin-top:4px;">` : '';
    return `<div style="display:flex;flex-direction:column;align-items:${align};margin-bottom:8px;">
      <div style="font-size:0.68rem;color:#888;">${escapeHtml(who)}</div>
      <div style="max-width:80%;background:${m.is_organizer ? '#e8f0fe' : '#f1f1f1'};border-radius:10px;padding:6px 10px;font-size:0.85rem;">${m.body ? escapeHtml(m.body) : ''}${img}</div>
    </div>`;
  }).join('') || '<div style="text-align:center;color:#aaa;padding:1rem;">No messages yet.</div>';
  el.scrollTop = el.scrollHeight;
}
```
(Use the admin's existing HTML-escape helper — confirm its name, e.g. `escapeHtml`/`esc`; if none exists, add a minimal one.)

- [ ] **Step 3: Verify build** (Task 6 Step 2). Expected `✓ built`.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat(admin/openplay): organizer chat view (receipts + reply)"
```

---

### Task 9: End-to-end verification

**Files:** none (manual + build).

- [ ] **Step 1:** Admin build passes: `npm --prefix "C:/Users/brendon.lambago/Pickleball Booking System (admin panel)" run build` → `✓ built`.
- [ ] **Step 2:** Booking app served locally (`npm run dev`); open an enabled open-play session.
- [ ] **Step 3:** Request to join → appears as **pending** in admin (within poll interval), does NOT appear in `open_play_queue`.
- [ ] **Step 4:** Post a receipt image in chat → image renders for player and admin (served from `openplay-receipts` public URL — no broken image).
- [ ] **Step 5:** Admin **Approve** → player's banner flips to "confirmed" live; a row now exists in `open_play_queue` with a `queue_number` and receipt; the confirmed list shows the player.
- [ ] **Step 6:** Capacity: fill to `max_players`; next Approve shows "Session is full" and leaves the request pending.
- [ ] **Step 7:** Duplicate: request twice from the same phone → single request, "already requested" handling, chat opens.
- [ ] **Step 8:** Decline a request → player banner shows declined.
- [ ] **Step 9:** Confirm `index.html` and `dist/index.html` are identical and the SW cache version is bumped.

---

## Self-Review notes

- **Spec coverage:** request/pending (T2,6,7), device token (T1), group chat (T3,4,8), receipt upload to Supabase Storage (T1,3), approval capacity-safe (T6,7 via RPC), confirmed via `open_play_queue` insert (RPC), live status/chat player-side (T4), admin poll (T7,8), retire PayMongo (T2), dual-file + SW (T5). Covered.
- **Known investigation points to resolve during execution (read exact current code first):** the open-play modal close/`popstate` path for `opUnsubscribeChat`; the session-card render site for the re-entry button; the admin `renderSessionRow` expand/collapse hook and its HTML-escape helper name; the admin confirmed-list render block for `refreshRegistrationsPanel` reuse.
- **Type consistency:** request status values `pending|approved|declined`; message fields match the migration; RPC names `approve_open_play_request` / `get_open_play_request` used consistently.
