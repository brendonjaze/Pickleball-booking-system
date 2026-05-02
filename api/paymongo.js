export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { body } = req;
    const path = req.url.replace(/^\/api\/paymongo/, '');
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
