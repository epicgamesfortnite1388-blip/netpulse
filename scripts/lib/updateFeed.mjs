/**
 * The update feed — one owner for "where does this app look for updates" and
 * "what does the manifest it finds have to look like".
 *
 * Two facts from the updater plugin (tauri-plugin-updater 2.11) drive the shape
 * here, and getting either wrong produces a feed the app silently rejects:
 *
 *  1. The manifest's `signature` is **base64 of the `.sig` file's text**, not
 *     the signature itself — the plugin base64-decodes the field and then
 *     parses it as a minisign signature. (`pubkey` in tauri.conf.json is
 *     encoded the same way.)
 *  2. Platform keys are `{target}-{arch}` as the plugin names them:
 *     `windows-x86_64`, `darwin-aarch64`, `linux-x86_64` — NOT the Rust triple
 *     (`x86_64-pc-windows-gnu`) and not the Tauri bundle target.
 */

import fs from 'node:fs';
import path from 'node:path';

import { toMinisignField } from './minisign.mjs';

/** Marker values that look configured but are not. */
const PLACEHOLDERS = [/example\.com/i, /REPLACE_WITH/i, /your[-_]?(org|user|repo)/i, /CHANGEME/i, /<[^>]+>/];

export class FeedConfigError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = 'FeedConfigError';
    this.hints = hints;
  }
}

/**
 * Pull a `owner/repo` slug out of a GitHub URL, an `owner/repo` string, or a
 * package.json `repository` value (string or `{ url }`).
 */
export function parseRepoSlug(value) {
  if (!value) return null;
  const raw = typeof value === 'string' ? value : (value.url ?? value.directory ?? '');
  const text = String(raw).trim();
  if (!text) return null;

  const cleaned = text
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');

  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const slug = `${parts[0]}/${parts[1]}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  return slug;
}

export function assertUsableSlug(slug, source) {
  if (!slug) {
    throw new FeedConfigError(`no GitHub repository configured for the update feed (${source})`, [
      'Set NETPULSE_RELEASE_REPO=owner/repo, or add "repository" to the root package.json.',
      'The updater endpoint is stamped from it, so the app can never be pointed at a feed nobody publishes.',
    ]);
  }
  const offending = PLACEHOLDERS.find((re) => re.test(slug));
  if (offending) {
    throw new FeedConfigError(`the update feed repository is still a placeholder (${slug}, from ${source})`, [
      'Replace it with the real GitHub owner/repo that hosts releases, or set NETPULSE_RELEASE_REPO.',
    ]);
  }
  return slug;
}

/**
 * Resolve the release repository. Three cases, in order:
 *   1. NETPULSE_RELEASE_REPO=local — the fully-offline feed: the sidecar
 *      itself serves latest.json + the artifact from the release dir at fixed
 *      loopback routes (no GitHub, no internet).
 *   2. NETPULSE_RELEASE_REPO=owner/repo — GitHub Releases feed.
 *   3. Root package.json `repository` field.
 */
export function resolveReleaseRepo({ env = process.env, repoRoot } = {}) {
  if (env.NETPULSE_RELEASE_REPO === 'local') {
    return { slug: 'local', source: 'NETPULSE_RELEASE_REPO', local: true };
  }
  const fromEnv = parseRepoSlug(env.NETPULSE_RELEASE_REPO);
  if (env.NETPULSE_RELEASE_REPO) {
    return { slug: assertUsableSlug(fromEnv, 'NETPULSE_RELEASE_REPO'), source: 'NETPULSE_RELEASE_REPO' };
  }
  let pkgRepo = null;
  if (repoRoot) {
    const pkgPath = path.join(repoRoot, 'package.json');
    if (fs.existsSync(pkgPath)) pkgRepo = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).repository;
  }
  return {
    slug: assertUsableSlug(parseRepoSlug(pkgRepo), 'package.json "repository"'),
    source: 'package.json "repository"',
  };
}

/**
 * The feed endpoint the built app polls.
 *
 * GitHub: the newest manifest sits at a stable "latest/download" URL, which is
 * why the endpoint never needs a version in it. Local: the sidecar serves the
 * manifest at a fixed loopback route (port is per-launch/ephemeral, so the
 * URL is version-less — see the port note in feedEndpointForPort).
 */
export function feedEndpoint(slug) {
  if (slug === 'local') {
    return 'http://127.0.0.1:update-feed/api/v1/update-feed/latest.json';
  }
  return `https://github.com/${slug}/releases/latest/download/latest.json`;
}

/**
 * Local mode's endpoint cannot be baked complete at build time: the sidecar
 * binds an EPHEMERAL loopback port each launch. The baked endpoint therefore
 * carries the literal `update-feed` host placeholder, and the Rust core
 * rewrites it with the real port when handing config to the updater. This
 * helper is the rewrite used at startup — and in tests as the contract.
 */
export function localEndpointForPort(port) {
  return `http://127.0.0.1:${port}/api/v1/update-feed/latest.json`;
}

export function releaseTag(version) {
  return `v${version}`;
}

/** A release asset's permanent download URL (tag-pinned, not "latest").
 *  Local mode instead points at the sidecar's fixed artifact route. */
export function releaseAssetUrl(slug, version, fileName) {
  if (slug === 'local') {
    return 'http://127.0.0.1:update-feed/artifact';
  }
  return `https://github.com/${slug}/releases/download/${releaseTag(version)}/${fileName}`;
}

/** The plugin's platform key: `{target}-{arch}`. */
export function platformKeyFor(os, arch) {
  const archMap = { x64: 'x86_64', ia32: 'i686', arm64: 'aarch64', arm: 'armv7' };
  const osMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
  const target = osMap[os];
  const cpu = archMap[arch];
  if (!target || !cpu) throw new FeedConfigError(`unsupported update platform: ${os}-${arch}`);
  return `${target}-${cpu}`;
}

/**
 * The `signature` field's value, normalized to what the plugin parses: base64
 * of the minisign signature text. The Tauri CLI already writes `<artifact>.sig`
 * in exactly this form (so the file's content IS the field), while a `.sig`
 * produced by `minisign` itself is raw text and gets encoded here. Either input
 * yields the same field.
 */
export function manifestSignatureField(sigFileContent) {
  return toMinisignField(sigFileContent, 'signature');
}

/**
 * The Static-format manifest the plugin parses.
 *
 * @param {{version: string, notes?: string|null, pubDate?: string, artifactUrl: string, signature: string, platformKey: string}} input
 */
export function buildLatestJson({ version, notes, pubDate, artifactUrl, signature, platformKey }) {
  if (!version) throw new FeedConfigError('latest.json needs a version');
  if (!artifactUrl) throw new FeedConfigError('latest.json needs an artifact URL');
  if (!signature) throw new FeedConfigError('latest.json needs a signature');
  if (!platformKey) throw new FeedConfigError('latest.json needs a platform key');
  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [platformKey]: { signature, url: artifactUrl },
    },
  };
}
