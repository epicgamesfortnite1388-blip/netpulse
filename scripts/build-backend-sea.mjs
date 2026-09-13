#!/usr/bin/env node
/**
 * Portable runtime launcher for the desktop backend.
 *
 * Why not Node SEA: (1) the SEA embedder `require` resolves ONLY builtins —
 * any bare specifier is fatal; (2) Fastify's validator chain (ajv /
 * fast-json-stringify) generates code at RUNTIME that requires
 * `ajv/dist/runtime/*` — such requires can only resolve from a real
 * node_modules tree. A single executable cannot provide both.
 *
 * The portable launcher instead copies the bundled Node runtime (node.exe,
 * MIT-licensed) beside the backend into src-tauri/backend/. The Rust
 * supervisor prefers it and end users need NO Node.js install; the tauri
 * bundle ships backend/ as a resource, so the launcher is packaged with the
 * app automatically. node_modules is already staged there by prepare-desktop.
 *
 * Result: `npm run desktop:build` produces a fully self-contained install —
 * no developer toolchain on the target machine.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'src-tauri', 'backend');

if (process.platform === 'win32') {
  const dest = path.join(backendDir, 'node.exe');
  fs.copyFileSync(process.execPath, dest);
  console.log(`[portable-launcher] bundled Node runtime -> ${dest}`);
} else {
  // macOS/Linux: the node binary must keep its real name for its dylib rpaths;
  // ship it as backend/bin/node and exec that.
  const binDir = path.join(backendDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, 'node');
  fs.copyFileSync(process.execPath, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`[portable-launcher] bundled Node runtime -> ${dest}`);
}
console.log('[portable-launcher] done');
