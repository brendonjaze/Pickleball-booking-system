import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    // Load env file based on `mode` in the current working directory.
    // Set the third parameter to '' to load all envs regardless of the `VITE_` prefix.
    const env = loadEnv(mode, process.cwd(), '');
    const paymongoSecret = env.PAYMONGO_SECRET_KEY || env.VITE_PAYMONGO_SECRET_KEY || '';

    // Safety check: only encode if we have a key
    const authHeader = paymongoSecret ? `Basic ${Buffer.from(paymongoSecret + ':').toString('base64')}` : '';

    return {
        base: './',
        plugins: [react()],
        server: {
            proxy: {
                '/api/paymongo': {
                    target: 'https://api.paymongo.com/v1',
                    changeOrigin: true,
                    secure: false,
                    ws: true,
                    rewrite: (path) => path.replace(/^\/api\/paymongo/, ''),
                    headers: {
                        'Authorization': authHeader
                    },
                    configure: (proxy, options) => {
                        proxy.on('proxyReq', (proxyReq, req, res) => {
                            proxyReq.removeHeader('Origin');
                            proxyReq.removeHeader('Referer');
                        });
                    }
                }
            }
        },
        build: {
            rollupOptions: {
                input: {
                    main: 'index.html',
                    court: 'court.html',
                },
            },
        },
    };
});
