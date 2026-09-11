import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API server this dev server proxies /api to. 127.0.0.1 rather than
// "localhost" so the target never depends on how the host resolves IPv4 vs
// IPv6, which differs between platforms.
const API_TARGET = process.env.API_TARGET || `http://127.0.0.1:${process.env.API_PORT || 3000}`;

const API_DOWN = 'The candidate API is not running. Start it with `npm run dev:server`, or run `npm run dev` to start both.';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.CLIENT_PORT) || 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        // Without this, an unreachable API server makes Vite answer with a
        // bare 500 and no body, which reaches the recruiter as an unexplained
        // failure. Answer with the same JSON shape our backend uses so the
        // client renders a message that says what to actually do.
        configure(proxy) {
          proxy.on('error', (error, _request, response) => {
            console.error(`[api proxy] ${error.code || error.message} reaching ${API_TARGET} - ${API_DOWN}`);
            if (typeof response?.writeHead !== 'function') return; // websocket upgrade: response is a socket
            if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
            // The code marks a connection that never reached the API, which the
            // client uses to retry a free request instead of showing an error.
            response.end(JSON.stringify({ error: API_DOWN, code: 'API_UNREACHABLE' }));
          });
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    restoreMocks: true,
    include: ['src/**/*.test.{js,jsx}']
  }
});
