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
 * It also stamps the updater endpoint from the release repository (env
 * NETPULSE_RELEASE_REPO, else package.json `repository`), so the URL the app
 * polls can never drift from where scripts/update-feed.mjs publishes. A build
 * with no repository configured keeps whatever endpoint the conf already has
 * and says so — it does not silently invent one.
 *
 * Usage:
 *   node scripts/release.mjs                   # sync current root version everywhere
 *   node scripts/release.mjs 0.3.0             # set a new version everywhere, then sync
 *   node scripts/release.mjs --repo owner/repo # record the release repository, then sync
 *
 * `--repo` is the one-step activation of the auto-update feed: it writes the
 * slug into the root package.json `repository` field (the single source the
 * endpoint is stamped from), clears any `netpulse.releaseFeed: "local"` marker,
 * and the updater endpoint follows in the same run.
 *
 * Run automatically at the start of `npm run desktop:build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

// --repo owner/repo|local: record the release repository at the source of
// truth. `local` is special: the fully-offline feed, where the sidecar itself
// serves the manifest — recorded as NETPULSE_RELEASE_REPO in .nmprc-style env
// is NOT available, so it is written into package.json as a private marker.
const repoIdx = process.argv.indexOf('--repo');
if (repoIdx !== -1) {
  const raw = process.argv[repoIdx + 1];
  if (raw === 'local') {
    const rootPkgPath = path.join(root, 'package.json');
    const rootPkg = readJson(rootPkgPath);
    if (rootPkg.netpulse?.releaseFeed !== 'local') {
      rootPkg.netpulse = { ...(rootPkg.netpulse ?? {}), releaseFeed: 'local' };
      writeJson(rootPkgPath, rootPkg);
      console.log('[release] package.json netpulse.releaseFeed -> local (sidecar-served update feed)');
    }
  } else {
    const { parseRepoSlug, assertUsableSlug, clearLocalFeedMarker, FeedConfigError } = await import('./lib/updateFeed.mjs');
    try {
      const slug = assertUsableSlug(parseRepoSlug(raw), '--repo');
      const rootPkgPath = path.join(root, 'package.json');
      const rootPkg = readJson(rootPkgPath);
      const slugChanged = parseRepoSlug(rootPkg.repository) !== slug;
      const markerCleared = clearLocalFeedMarker(rootPkg);
      if (slugChanged || markerCleared) {
        rootPkg.repository = `https://github.com/${slug}`;
        writeJson(rootPkgPath, rootPkg);
        console.log(`[release] package.json repository -> https://github.com/${slug}`);
        if (markerCleared) console.log('[release] package.json netpulse.releaseFeed marker cleared');
      }
    } catch (err) {
      if (!(err instanceof FeedConfigError)) throw err;
      console.error(`[release] --repo: ${err.message}`);
      for (const hint of err.hints) console.error(`  ${hint}`);
      process.exit(1);
    }
  }
}

// Optional first arg: set the version at the source of truth first.
const firstPositional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
if (firstPositional) {
  const v = firstPositional;
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
  /^(\[package\]\r?\nname = "netpulse-desktop"\r?\nversion = )"([^"]+)"/m,
  `$1"${version}"`,
);
if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  console.log(`[release] src-tauri/Cargo.toml -> ${version}`);
} else {
  // No replacement happened: either the version was already correct, or the
  // regex no-oped on a layout change. Verify the VERSION line itself, not
  // an incidental occurrence of the string in a comment (Kim P3).
  const packageBlock = cargo.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|\z)/m)?.[1] ?? '';
  const stamped = packageBlock.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (stamped !== version) {
    console.error(`[release] could not stamp Cargo.toml version ${version}: [package] layout changed (found ${stamped ?? 'no version line'}).`);
    process.exit(1);
  }
}

// Updater endpoint — derived, never hand-typed, so a release cannot advertise
// a feed at a different host than the one this pipeline uploads to.
try {
  const { resolveReleaseRepo, feedEndpoint } = await import('./lib/updateFeed.mjs');
  const { slug, source, local } = resolveReleaseRepo({ env: process.env, repoRoot: root });
  const endpoint = feedEndpoint(slug);
  const current = conf.plugins?.updater?.endpoints ?? [];
  if (current.length !== 1 || current[0] !== endpoint) {
    conf.plugins = conf.plugins ?? {};
    conf.plugins.updater = conf.plugins.updater ?? {};
    conf.plugins.updater.endpoints = [endpoint];
    fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
    console.log(`[release] src-tauri/tauri.conf.json updater endpoint -> ${endpoint} (${local ? 'local feed' : `from ${source}`})`);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // A release with an unstamped/unverifiable feed endpoint is not releasable
  // (DD-005); warn-only let the whole pipeline report success.
  console.error(`[release] updater endpoint NOT stamped: ${message}`);
  console.error('[release] set NETPULSE_RELEASE_REPO=owner/repo (or "local") or package.json "repository" before a release.');
  process.exit(1);
}

console.log(`[release] canonical version: ${version}`);
