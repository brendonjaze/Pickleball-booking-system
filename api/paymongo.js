export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { body } = req;
    // Allowlist: this app only ever creates checkout sessions. Reject anything
    // else so the proxy can't be abused as an open relay to the PayMongo API
    // with our live secret key (refunds, links, webhooks, payments, etc.).
    const path = req.url.replace(/^\/api\/paymongo/, '').split('?')[0];
    if (path !== '/checkout_sessions') {
        return res.status(404).json({ errors: [{ detail: 'Not found' }] });
    }
    const url = `https://api.paymongo.com/v1${path}`;

    try {
        const secret = process.env.PAYMONGO_SECRET_KEY || process.env.VITE_PAYMONGO_SECRET_KEY;
        if (!secret) {
            return res.status(401).json({ errors: [{ detail: 'Missing PAYMONGO_SECRET_KEY in Environment Variables' }] });
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(secret + ':').toString('base64')}`
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (error) {
        console.error('Paymongo proxy error:', error);
        return res.status(500).json({ errors: [{ detail: error.message }] });
    }
}
