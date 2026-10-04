import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { replyApiError } from '../util/apiError';

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
  notFound: { code: string; message: string },
): FastifyReply {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return replyApiError(reply, 404, notFound.code, notFound.message);
  }
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('cache-control', 'no-store')
    // ETag from size+mtime: a poll loop gets cheap 304s, and a re-published
    // feed changes mtime so clients never pin a stale manifest.
    .header('etag', etag);
  if (reply.request.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }
  reply.header('content-length', stat.size);
  // RETURN the send: inside an async handler, a bare `void reply.send(...)`
  // followed by handler resolution makes Fastify resolve the empty payload
  // over the stream — observed live as `content-length: 0` on a 200. Returning
  // the reply is the documented contract for sending from async handlers.
  return reply.send(fs.createReadStream(file));
}

export function registerUpdateFeedRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * The manifest the updater polls. Its `platforms.windows-x86_64.url` must
   * point back at these loopback routes — release:feed writes exactly that
   * when the repo slug is `local` (see scripts/lib/updateFeed.mjs).
   */  app.get('/api/v1/update-feed/latest.json', async (_req, reply) => {
    const file = resolveInReleaseDir(ctx, MANIFEST_FILE);
    if (!file) {
      return replyApiError(reply, 404, 'no_feed', 'No local release directory is configured (NETPULSE_RELEASE_DIR unset)');
    }
    return sendJsonFile(reply, file, { code: 'no_manifest', message: 'No release has been published to the local feed yet' });
  });

  /**
   * The signed artifact (the zipped installer). Served with a stream (37 MB)
   * and content-length so the updater's progress events are accurate.
   *
   * The file name comes from the manifest's URL query (`?file=...`), written
   * there by release:feed — the same artifactName used at publish time. It is
   * UNTRUSTED INPUT: reduced to a bare name and resolved strictly inside the
   * release dir before anything is opened.
   */
  app.get('/api/v1/update-feed/artifact', async (req, reply) => {
    const dir = ctx.config.releaseDir;
    if (!dir) {
      return replyApiError(reply, 404, 'no_feed', 'No local release directory is configured (NETPULSE_RELEASE_DIR unset)');
    }
    const raw = (req.query as { file?: string } | undefined)?.file ?? '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return replyApiError(reply, 404, 'bad_manifest', 'Manifest artifact name is malformed');
    }
    const fileName = path.basename(decoded);
    if (!fileName || fileName.startsWith('.') || fileName !== decoded) {
      return replyApiError(reply, 404, 'bad_manifest', 'Manifest does not name a local artifact');
    }
    const file = resolveInReleaseDir(ctx, fileName);
    if (!file) {
      return replyApiError(reply, 404, 'no_artifact', 'Manifest artifact is missing from the local feed');
    }
    return sendJsonFile(reply, file, { code: 'no_artifact', message: 'Artifact file missing from the release directory' });
  });
}
