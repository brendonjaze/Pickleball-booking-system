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

            const rows = slots.map(slot => ({
                court_id: metadata.court_id,
                date: metadata.date,
                time_slot: slot,
                name: metadata.player_name,
                phone: metadata.mobile,
                payment_method: metadata.payment_method || 'QRPh (GCash/Maya/ShopeePay)',
                booking_ref: metadata.booking_ref,
            }));

            const insert = await supabaseRequest('bookings', supabaseUrl, supabaseKey, {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify(rows),
            });
            if (!insert.ok) throw new Error(`Supabase court insert failed: ${JSON.stringify(insert.body)}`);
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
