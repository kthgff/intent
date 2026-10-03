import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev server proxies the conductor API surface (API.md: ui.bind:ui.port,
 * default 127.0.0.1:4711). `/api/*` always proxies; the loopback
 * `GET /?token=` bootstrap route also proxies so the session cookie can
 * be set through the dev origin. Everything else is served by Vite.
 */
const API_ORIGIN = process.env.SR_API_ORIGIN ?? 'http://127.0.0.1:4711';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_ORIGIN, secure: false },
      '/': {
        target: API_ORIGIN,
        secure: false,
        bypass: (req) =>
          req.url?.startsWith('/?token=') ? null : (req.url ?? '/index.html'),
      },
    },
  },
  build: {
    // Conductor serves these static assets (API.md: one surface).
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
