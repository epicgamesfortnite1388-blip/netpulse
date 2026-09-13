import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  // workspace packages ship as TS source; bundle them so `node dist/index.js` works
  noExternal: [/^@netpulse\//],
});
