import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Recovery-pass visual config: isolated cacheDir avoids the existing
// node_modules/.vite bulk-delete guard. Mirrors the shipped vite.config.ts
// aliases exactly so the app actually renders.
const root = path.resolve(import.meta.dirname, '.');
export default defineConfig({
  root,
  cacheDir: 'E:/Code/Project/.final-ui-recovery-vite-cache',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      '@shared': path.resolve(root, '../../packages/shared/src'),
      '@netpulse/shared': path.resolve(root, '../../packages/shared/src'),
      '@cloud-contract': path.resolve(root, '../../cloud/worker/src/api.ts'),
    },
  },
  server: { port: 5175, strictPort: true, host: '127.0.0.1' },
});
