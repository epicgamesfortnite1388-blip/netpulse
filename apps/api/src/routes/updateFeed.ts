import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppContext } from './context';

/**
 * Local update feed — the fully-offline answer to "where does latest.json
 * live when there is no server?".
 *
 * The desktop sidecar serves `latest.json` and the signed update artifact
 * from `config.releaseDir` (NETPULSE_RELEASE_DIR) at these PUBLIC routes, so
 * the Tauri updater — which can only poll http(s) URLs — works with no
 * internet and no release host. Publishing a release locally is exactly one
 * step: run `release:feed`, which drops latest.json + .zip + .sig into the
 * release dir; the routes stream whatever is there now (no cache, so a new
 * manifest is live on the next poll).
 *
 * Security posture:
 *   - Public (no bearer): the updater process is not the webview and cannot
 *     hold the per-launch secret; the feed exposes only release metadata and
 *     a signature the CLIENT verifies against the shipped pubkey. Tampering
 *     with these files cannot produce a working malicious update — the
 *     minisign signature over the artifact must match the compiled-in key.
 *   - Path safety: file names are fixed constants, never derived from the
 *     request URL; the manifest's artifact URL is what the updater fetches
 *     and points back at these same fixed routes. Nothing user-controlled
 *     ever reaches path resolution, so there is no traversal surface.
 */

const MANIFEST_FILE = 'latest.json';

/** Resolve a file inside the release dir, refusing anything outside it. */
function resolveInReleaseDir(ctx: AppContext, file: string): string | null {
  const dir = ctx.config.releaseDir;
  if (!dir) return null;
  const resolved = path.resolve(dir, file);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

function sendJsonFile(
  reply: FastifyReply,
  file: string,
  notFoundBody: { error: { code: string; message: string } },
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    void reply.code(404).send(notFoundBody);
    return;
  }
  reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-length', stat.size)
    .header('cache-control', 'no-store')
    // ETag from size+mtime: a poll loop gets cheap 304s, and a re-published
    // feed changes mtime so clients never pin a stale manifest.
    .header('etag', `"${stat.size}-${stat.mtimeMs}"`);
  if (reply.request.headers['if-none-match'] === `"${stat.size}-${stat.mtimeMs}"`) {
    void reply.code(304).send();
    return;
  }
  void reply.send(fs.createReadStream(file));
}

export function registerUpdateFeedRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * The manifest the updater polls. Its `platforms.windows-x86_64.url` must
   * point back at these loopback routes — release:feed writes exactly that
   * when the repo slug is `local` (see scripts/lib/updateFeed.mjs).
   */
  app.get('/api/v1/update-feed/latest.json', async (_req, reply) => {
    const file = resolveInReleaseDir(ctx, MANIFEST_FILE);
    if (!file) {
      void reply.code(404).send({ error: { code: 'no_feed', message: 'No local release directory is configured (NETPULSE_RELEASE_DIR unset)' } });
      return;
    }
    sendJsonFile(reply, file, { error: { code: 'no_manifest', message: 'No release has been published to the local feed yet' } });
  });

  /**
   * The signed artifact (the zipped installer). Served with a stream (37 MB)
   * and content-length so the updater's progress events are accurate.
   */
  app.get('/api/v1/update-feed/artifact', async (_req, reply) => {
    const dir = ctx.config.releaseDir;
    if (!dir) {
      void reply.code(404).send({ error: { code: 'no_feed', message: 'No local release directory is configured (NETPULSE_RELEASE_DIR unset)' } });
      return;
    }
    // The artifact file name comes from the manifest itself, so the feed
    // serves whatever release:feed published without hard-coding a version.
    let manifest: { platforms?: { 'windows-x86_64'?: { url?: string } } };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    } catch {
      void reply.code(404).send({ error: { code: 'no_manifest', message: 'No release has been published to the local feed yet' } });
      return;
    }
    const url = manifest.platforms?.['windows-x86_64']?.url;
    const fileName = url?.split('/').pop();
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      void reply.code(404).send({ error: { code: 'bad_manifest', message: 'Manifest does not name a local artifact' } });
      return;
    }
    const file = resolveInReleaseDir(ctx, fileName);
    if (!file) {
      void reply.code(404).send({ error: { code: 'no_artifact', message: 'Manifest artifact is missing from the local feed' } });
      return;
    }
    sendJsonFile(reply, file, { error: { code: 'no_artifact', message: 'Artifact file missing from the release directory' } });
  });
}
