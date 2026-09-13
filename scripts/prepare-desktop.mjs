#!/usr/bin/env node
/**
 * Prepare desktop resources for `tauri build`:
 *
 *   src-tauri/backend/
 *     netpulse-backend.js      bundled CJS backend (desktop-index.ts)
 *     package.json             minimal runtime manifest (type: commonjs)
 *     node_modules/            pruned production deps (better-sqlite3 prebuild)
 *
 * The Tauri bundle copies src-tauri/backend/ next to the executable as
 * "backend/". The Rust supervisor prefers the bundled portable Node runtime
 * (backend/node.exe or backend/bin/node, staged by build-backend-sea.mjs) and
 * falls back to system `node` in dev.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'apps', 'api');
const outDir = path.join(root, 'src-tauri', 'backend');

/**
 * Run a workspace npm script without a shell (DEP0190 / arg-injection safe).
 *
 * We cannot spawn `npm` directly on Windows (`.cmd` requires shell:true since
 * the CVE-2024-27980 hardening), so we invoke npm's CLI JS with the current
 * Node executable instead — same result, no shell, no escaping hazards.
 */
function runNpm(args, opts = {}) {
  const npmCli = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : 'npm';
  const res = spawnSync(process.execPath, [npmCli, ...args], {
    stdio: 'inherit',
    cwd: root,
    ...opts,
  });
  if (res.status !== 0) {
    console.error(`[desktop-prepare] command failed: npm ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

// 1. Bundle the desktop backend (CJS, single file, native deps external).
runNpm(['run', 'build:desktop', '--workspace', '@netpulse/api']);

// 2. Reset the staging dir. Windows can hold transient locks on recently
// closed native modules (AV/indexer) — retry before giving up.
fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
fs.mkdirSync(path.join(outDir, 'node_modules'), { recursive: true });

// 3. Copy the bundle + minimal runtime manifest.
const bundleFile = fs.existsSync(path.join(apiDir, 'dist-desktop', 'desktop-index.cjs'))
  ? 'desktop-index.cjs'
  : 'desktop-index.js';
fs.copyFileSync(path.join(apiDir, 'dist-desktop', bundleFile), path.join(outDir, 'netpulse-backend.js'));
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'netpulse-backend',
      private: true,
      // Keep in lockstep with the canonical release version.
      version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      type: 'commonjs',
      main: 'netpulse-backend.js',
    },
    null,
    2,
  ) + '\n',
);

// 4. Stage the drizzle migrations folder (the sidecar must be able to run
//    schema migrations on first launch without the repo present).
fs.cpSync(path.join(apiDir, 'drizzle'), path.join(outDir, 'drizzle'), { recursive: true });

// 5. Prune-copy production dependencies needed at runtime.
//    better-sqlite3 ships prebuilt binaries for common platforms; other deps
//    are pure JS and bundled by tsup already. We copy only what the bundle
//    declares external plus drizzle/better-sqlite3 runtime pieces.
const depsToCopy = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
for (const dep of depsToCopy) {
  const src = path.join(root, 'node_modules', dep);
  const dest = path.join(outDir, 'node_modules', dep);
  if (!fs.existsSync(src)) {
    console.warn(`[desktop-prepare] warning: dependency not found, skipping: ${dep}`);
    continue;
  }
  fs.cpSync(src, dest, { recursive: true });
}

// 5. Bundle a portable Node runtime beside the backend so the packaged app
//    needs NO Node.js install on user machines (the SEA single-exe approach
//    is incompatible with Fastify/ajv runtime codegen — see the script).
const launcherScript = path.join(root, 'scripts', 'build-backend-sea.mjs');
if (fs.existsSync(launcherScript)) {
  const res = spawnSync(process.execPath, [launcherScript], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.warn('[desktop-prepare] portable runtime bundling failed; supervisor falls back to system node.');
  }
}

console.log('[desktop-prepare] backend staged in src-tauri/backend');
