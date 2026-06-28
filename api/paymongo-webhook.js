import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function verifySignature(rawBody, signatureHeader, secret) {
    // Format: t=<timestamp>,te=<test_hmac>,li=<live_hmac>
    const parts = {};
    signatureHeader.split(',').forEach(part => {
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) parts[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    });
    if (!parts.t) return false;
    const message = `${parts.t}.${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return parts.te === expected || parts.li === expected;
}

async function supabaseRequest(url, supabaseUrl, key, options = {}) {
    const headers = {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...options.headers,
    };
    const res = await fetch(`${supabaseUrl}/rest/v1/${url}`, { ...options, headers });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}

// ── Server-side price re-derivation (anti price-tampering) ──────────────────
// The browser sends both the charged amount and the slots/session independently,
// so the server must recompute the expected price and reject mismatches.
function slotStartHour(label) {
    const m = String(label).match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12;
    if (/PM/i.test(m[3])) h += 12;
    return h;
}

function rateForHourServer(startHour, pricing, fallbackRate) {
    if (!pricing) return Number(fallbackRate) || 0;
    const cutoff = Number.isFinite(Number(pricing.cutoff_hour)) ? Number(pricing.cutoff_hour) : 18;
    const rate = startHour >= cutoff ? Number(pricing.evening_rate) : Number(pricing.daytime_rate);
    return Number.isFinite(rate) ? rate : (Number(fallbackRate) || 0);
}

// Amount actually paid, in centavos, from the paid checkout session.
function paidCentavosFrom(checkoutAttrs) {
    const payments = Array.isArray(checkoutAttrs.payments) ? checkoutAttrs.payments : [];
    for (const p of payments) {
        const amt = p && p.attributes && p.attributes.amount;
        if (typeof amt === 'number') return amt;
    }
    const items = Array.isArray(checkoutAttrs.line_items) ? checkoutAttrs.line_items : [];
    if (items.length) return items.reduce((s, li) => s + (Number(li.amount) || 0) * (Number(li.quantity) || 1), 0);
    return null;
}

// Returns { ok, reason?, expected?, paid?, skipped? }. Throws on DB-fetch
// failure so the outer handler returns 500 and PayMongo retries.
async function validateAmount(metadata, checkoutAttrs, supabaseUrl, supabaseKey) {
    const paid = paidCentavosFrom(checkoutAttrs);
    if (paid == null) {
        console.warn('Webhook: could not read paid amount — skipping price check for ref', metadata.booking_ref);
        return { ok: true, skipped: true };
    }
    let expected;
    // Per-slot price (pesos), keyed by slot label, so the booking rows can record
    // the actual amount charged instead of having the admin recompute it later.
    let slotPriceByLabel = null;
    if (metadata.type === 'court') {
        const slots = JSON.parse(metadata.slots_json || '[]');
        if (!slots.length) return { ok: false, reason: 'no_slots', expected: null, paid };
        const pricingRes = await supabaseRequest('pricing_settings?select=*&order=id.asc&limit=1', supabaseUrl, supabaseKey);
        if (!pricingRes.ok) throw new Error('pricing_settings fetch failed: ' + JSON.stringify(pricingRes.body));
        const pricing = (Array.isArray(pricingRes.body) && pricingRes.body[0]) || null;
        let fallback = 0;
        if (!pricing) {
            const courtRes = await supabaseRequest(`courts?id=eq.${encodeURIComponent(metadata.court_id)}&select=price_per_hour`, supabaseUrl, supabaseKey);
            if (!courtRes.ok) throw new Error('courts fetch failed: ' + JSON.stringify(courtRes.body));
            fallback = (Array.isArray(courtRes.body) && courtRes.body[0] && courtRes.body[0].price_per_hour) || 0;
        }
        expected = 0;
        slotPriceByLabel = {};
        for (const slot of slots) {
            const h = slotStartHour(slot);
            if (h == null) { expected = NaN; slotPriceByLabel = null; break; }
            const slotPesos = rateForHourServer(h, pricing, fallback);
            slotPriceByLabel[slot] = slotPesos;
            expected += slotPesos * 100;
        }
    } else if (metadata.type === 'openplay') {
        const sessRes = await supabaseRequest(`open_play_sessions?id=eq.${encodeURIComponent(metadata.session_id)}&select=price_per_player`, supabaseUrl, supabaseKey);
        if (!sessRes.ok) throw new Error('open_play_sessions fetch failed: ' + JSON.stringify(sessRes.body));
        const sess = (Array.isArray(sessRes.body) && sessRes.body[0]) || null;
        if (!sess) return { ok: false, reason: 'session_not_found', expected: null, paid };
        expected = (Number(sess.price_per_player) || 0) * 100;
    } else {
        return { ok: true, skipped: true };
    }
    if (!Number.isFinite(expected)) return { ok: false, reason: 'amount_unverifiable', expected, paid };
    if (Math.abs(paid - expected) > 1) return { ok: false, reason: 'amount_mismatch', expected, paid };
    return { ok: true, expected, paid, slotPriceByLabel };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const rawBody = await getRawBody(req);

    const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    if (webhookSecret) {
        const sig = req.headers['paymongo-signature'];
        if (!sig || !verifySignature(rawBody, sig, webhookSecret)) {
            console.error('Webhook: invalid signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    let event;
    try {
        event = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const eventType = event?.data?.attributes?.type;
    console.log('Webhook received event type:', eventType);

    if (eventType !== 'checkout_session.payment.paid') {
        return res.status(200).json({ received: true, skipped: true });
    }

    const checkoutAttrs = event?.data?.attributes?.data?.attributes ?? {};
    const metadata = checkoutAttrs.metadata ?? {};
    console.log('Webhook metadata:', JSON.stringify(metadata));

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        || process.env.SUPABASE_ANON_KEY
        || process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.error('Webhook: missing Supabase credentials');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        // Price-tampering guard: re-derive the expected price server-side and
        // reject anything that doesn't match what was actually paid. A wrong
        // amount means a manual refund, not a confirmed booking/registration.
        const amountCheck = await validateAmount(metadata, checkoutAttrs, supabaseUrl, supabaseKey);
        if (!amountCheck.ok) {
            console.error('Webhook: amount validation failed —', amountCheck.reason, 'paid', amountCheck.paid, 'expected', amountCheck.expected, 'ref', metadata.booking_ref);
            const failLog = await supabaseRequest('booking_failures', supabaseUrl, supabaseKey, {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify({
                    type: metadata.type || 'unknown',
                    booking_ref: metadata.booking_ref,
                    reason: amountCheck.reason,
                    payload: metadata,
                }),
            });
            if (!failLog.ok) console.error('Webhook: booking_failures insert failed (amount):', JSON.stringify(failLog.body));
            return res.status(200).json({ received: true, status: `${amountCheck.reason}_refund_needed` });
        }

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

            // PostgREST may return the jsonb result either directly or wrapped in a single-element array.
            const result = Array.isArray(rpc.body) ? rpc.body[0] : rpc.body;
            if (!result || typeof result.ok !== 'boolean') {
                throw new Error(`register_open_play returned unexpected shape: ${JSON.stringify(rpc.body)}`);
            }
            if (result.ok === false) {
                const reason = result.reason || 'register_failed';
                console.error('Webhook: openplay could not register —', reason, 'session', metadata.session_id);
                const failLog = await supabaseRequest('booking_failures', supabaseUrl, supabaseKey, {
                    method: 'POST',
                    headers: { 'Prefer': 'return=minimal' },
                    body: JSON.stringify({
                        type: 'openplay',
                        booking_ref: metadata.booking_ref,
                        reason: reason,
                        payload: metadata,
                    }),
                });
                if (!failLog.ok) throw new Error(`booking_failures insert failed (openplay): ${JSON.stringify(failLog.body)}`);
                return res.status(200).json({ received: true, status: `openplay_${reason}_refund_needed` });
            }
            console.log('Webhook: openplay registered via RPC', JSON.stringify(result));

        } else if (metadata.type === 'court') {
            const slots = JSON.parse(metadata.slots_json || '[]');
            if (slots.length === 0) throw new Error('No slots in webhook metadata');

            // Idempotency: skip if booking_ref already exists
            const check = await supabaseRequest(
                `bookings?booking_ref=eq.${encodeURIComponent(metadata.booking_ref)}&select=id&limit=1`,
                supabaseUrl, supabaseKey
            );
            if (check.ok && check.body?.length > 0) {
                console.log('Webhook: court booking already exists, skipping');
                return res.status(200).json({ received: true, status: 'already_booked' });
            }

            // Record the actual amount charged per slot (pesos) so revenue never
            // has to be re-derived from later-changed pricing settings. Null when
            // the price check was skipped (paid amount unreadable) — admin then
            // falls back to recomputing for that row.
            const priceByLabel = amountCheck.slotPriceByLabel || {};
            const rows = slots.map(slot => ({
                court_id: metadata.court_id,
                date: metadata.date,
                time_slot: slot,
                name: metadata.player_name,
                phone: metadata.mobile,
                payment_method: metadata.payment_method || 'QRPh (GCash/Maya/ShopeePay)',
                booking_ref: metadata.booking_ref,
                price: Object.prototype.hasOwnProperty.call(priceByLabel, slot) ? priceByLabel[slot] : null,
            }));

            const insert = await supabaseRequest('bookings', supabaseUrl, supabaseKey, {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify(rows),
            });
            if (!insert.ok) {
                const isConflict = insert.status === 409 || insert.body?.code === '23505';
                if (isConflict) {
                    console.error('Webhook: court slot conflict — recording booking_failure for ref', metadata.booking_ref);
                    const failLog = await supabaseRequest('booking_failures', supabaseUrl, supabaseKey, {
                        method: 'POST',
                        headers: { 'Prefer': 'return=minimal' },
                        body: JSON.stringify({
                            type: 'court',
                            booking_ref: metadata.booking_ref,
                            reason: 'slot_taken',
                            payload: metadata,
                        }),
                    });
                    // If we can't even record the failure, let PayMongo retry (court idempotency gates re-insert)
                    if (!failLog.ok) throw new Error(`booking_failures insert failed (court): ${JSON.stringify(failLog.body)}`);
                    return res.status(200).json({ received: true, status: 'slot_conflict_refund_needed' });
                }
                throw new Error(`Supabase court insert failed: ${JSON.stringify(insert.body)}`);
            }
            console.log('Webhook: court booking saved via webhook for ref', metadata.booking_ref);

        } else {
            console.log('Webhook: unknown metadata type, skipping:', metadata.type);
        }

        return res.status(200).json({ received: true });
    } catch (e) {
        console.error('Webhook processing error:', e.message);
        // Return 500 so PayMongo retries the webhook
        return res.status(500).json({ error: e.message });
    }
}
