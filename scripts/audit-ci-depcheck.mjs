import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? '.';
const pkgPath = path.resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const deps = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) };
const dirs = [
  path.resolve(root, 'packages/shared/src'),
  path.resolve(root, 'apps/api/src'),
  path.resolve(root, 'apps/web/src'),
  path.resolve(root, 'scripts'),
];
// Root-level config files where plugins/tooling are referenced by name.
const rootFiles = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts'];
const nameSet = new Set(
  Object.keys(deps)
    .filter((n) => n[0] !== '@' || n.startsWith('@scope/'))
    .map((n) => n.replace(/^@[^/]+\//, ''))
);
// Tooling invoked by binary name (npx <tool>, npm script) or referenced only in
// configs outside src trees — a token scan of src cannot see these.
const BINARY_TOOLING = new Set([
  '@tauri-apps/cli',
  'depcheck',
  'eslint',
  'madge',
  'ts-prune',
  'typescript',
  'vitest',
]);
const hits = new Set();
let cnt = 0;

// Seed hits from root config files (eslint plugins, etc.) and npm scripts.
for (const f of rootFiles) {
  const fp = path.resolve(root, f);
  try {
    const t = readFileSync(fp, 'utf8');
    const tokens = new Set(t.split(/[^A-Za-z0-9@/_-]+/));
    for (const n of Object.keys(deps)) tokens.has(n.replace(/^@[^/]+\//, '')) && hits.add(n.replace(/^@[^/]+\//, ''));
    cnt++;
  } catch { /* config file may not exist */ }
}
{
  const t = Object.values(pkg.scripts ?? {}).join(' ');
  const tokens = new Set(t.split(/[^A-Za-z0-9@/_-]+/));
  for (const n of Object.keys(deps)) {
    const un = n.replace(/^@[^/]+\//, '');
    if (tokens.has(un)) hits.add(un);
  }
}

for (const d of dirs) {
  if (!d || typeof d !== 'string') continue;
  let entries;
  try { entries = readdirSync(d, { recursive: true }); }
  catch { continue; }
  if (!Array.isArray(entries)) continue;
  for (const e of entries) {
    const fp = path.join(d, e);
    if (!/\.tsx?$/.test(fp)) continue;
    let t;
    try { t = readFileSync(fp, 'utf8'); }
    catch { continue; }
    // Word-boundary match without regex construction: split on non-name
    // characters and look the dependency (or its unscoped name) up as a token.
    const tokens = new Set(t.split(/[^A-Za-z0-9@/_-]+/));
    for (const n of nameSet) {
      if (tokens.has(n)) hits.add(n);
    }
    cnt++;
  }
}

const unused = Object.keys(deps).filter(
  (n) =>
    !hits.has(n.replace(/^@[^/]+\//, '')) &&
    !n.startsWith('@types/') &&
    !BINARY_TOOLING.has(n),
);

if (unused.length === 0) {
  console.log(`PASS  depcheck — scanned ${cnt} files, no unused deps`);
  process.exit(0);
}
console.error(`FAIL  depcheck — possibly unused dependencies:`);
for (const n of unused.sort()) console.error(`  ${n}`);
process.exit(1);
