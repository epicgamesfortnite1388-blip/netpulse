#!/usr/bin/env node
/**
 * Canonical release version sync.
 *
 * The root package.json `version` is the single source of truth for:
 *   - all workspace package.json files (@netpulse/api, @netpulse/web, shared)
 *   - src-tauri/tauri.conf.json  (app + installer version)
 *   - src-tauri/Cargo.toml       (rust core version)
 *   - src-tauri/backend staging manifest (via prepare-desktop.mjs, which reads
 *     the root version at staging time)
 *
 * Usage:
 *   node scripts/release.mjs            # sync current root version everywhere
 *   node scripts/release.mjs 0.3.0      # set a new version everywhere, then sync
 *
 * Run automatically at the start of `npm run desktop:build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

// Optional first arg: set the version at the source of truth first.
if (process.argv[2]) {
  const v = process.argv[2];
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
    console.error(`[release] invalid semver: ${v}`);
    process.exit(1);
  }
  const rootPkg = readJson(path.join(root, 'package.json'));
  rootPkg.version = v;
  writeJson(path.join(root, 'package.json'), rootPkg);
}

const rootPkg = readJson(path.join(root, 'package.json'));
const version = rootPkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('[release] root package.json has no valid version');
  process.exit(1);
}

const targets = [
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
];
for (const rel of targets) {
  const p = path.join(root, rel);
  const pkg = readJson(p);
  if (pkg.version !== version) {
    pkg.version = version;
    writeJson(p, pkg);
    console.log(`[release] ${rel} -> ${version}`);
  }
}

// tauri.conf.json (JSON5-free — plain JSON in this repo)
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = readJson(confPath);
if (conf.version !== version) {
  conf.version = version;
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  console.log(`[release] src-tauri/tauri.conf.json -> ${version}`);
}

// Cargo.toml — only the [package] version line under the header comment.
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
const updated = cargo.replace(
  /^(\[package\]\nname = "netpulse-desktop"\nversion = )"([^"]+)"/m,
  `$1"${version}"`,
);
if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  console.log(`[release] src-tauri/Cargo.toml -> ${version}`);
}

console.log(`[release] canonical version: ${version}`);
