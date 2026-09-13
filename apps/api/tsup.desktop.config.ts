import { defineConfig } from 'tsup';

/**
 * Desktop sidecar bundle (CJS, single file).
 *
 * The bundle runs either via the bundled portable Node runtime
 * (scripts/build-backend-sea.mjs copies node.exe/bin/node into the staging
 * dir) or via system node in dev. In both cases the staged node_modules
 * beside the bundle resolves the externals (better-sqlite3 native module and
 * its bindings loader), so we keep only the native package external.
 */
export default defineConfig({
  entry: ['src/desktop-index.ts'],
  format: ['cjs'],
  outDir: 'dist-desktop',
  target: 'node22',
  dts: false,
  sourcemap: false,
  // Bundle all pure-JS workspace/package code; the native better-sqlite3
  // (and its `bindings` loader) resolve from the staged node_modules.
  noExternal: [/^(?!better-sqlite3).*$/],
  external: ['better-sqlite3'],
});
