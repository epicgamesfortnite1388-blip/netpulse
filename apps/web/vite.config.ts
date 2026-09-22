import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // react-globe.gl's dependency three-conic-polygon-geometry touches `window`
  // at import time; pure-logic map tests import from the page module, so give
  // every test run a DOM.
  test: {
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@netpulse/shared': path.resolve(__dirname, '../../packages/shared/src'),
      // Tests import the Worker's zod contract directly, so the desktop and
      // cloud schemas cannot silently drift.
      '@cloud-contract': path.resolve(__dirname, '../../cloud/worker/src/api.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        // Point the dev proxy at the API the developer is actually running —
        // `npm run dev:api` on 8787 by default, or another instance by setting
        // VITE_API_PORT (e.g. a second server on a scratch data dir).
        target: `http://127.0.0.1:${process.env.VITE_API_PORT ?? 8787}`,
        ws: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
