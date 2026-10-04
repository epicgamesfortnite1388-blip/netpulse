import { z } from 'zod';

import {
  assertCloudUrl,
  classify,
  cloudOrigin,
  currentProxy,
  egressFetch,
  EgressError,
  SOCKS_UNSUPPORTED,
} from '../services/egressProxy';
import { replyApiError, replyValidationError } from '../util/apiError';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

/**
 * Cloud egress — the webview's route to the cloud, over the machine's proxy.
 *
 * The webview used to call the Worker directly with `fetch()`. That path cannot
 * honour a system proxy, so on any network where the Worker is only reachable
 * through one (Iran, most obviously) every sign-in and every Telegram sync died
 * with "check your connection" while the user's tunnel sat right there unused.
 * The requests now come through this sidecar, which resolves the proxy once
 * (see services/egressProxy.ts) and returns the upstream response verbatim.
 *
 * Two properties keep this from becoming an open relay:
 *
 *  - It sits behind the same `/api/` session gate as everything else, so it is
 *    reachable only from an authenticated local session.
 *  - The client sends a **path**, never a URL. This route builds the absolute
 *    URL from the cloud origin itself, so there is no caller-supplied host to
 *    validate and nothing else on the network can be reached through it.
 */

const BodySchema = z.object({
  path: z.string().startsWith('/'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
});

/** Request headers worth carrying to the cloud; nothing else is forwarded. */
const FORWARDED_REQUEST_HEADERS = new Set(['content-type', 'authorization', 'accept']);

/** The proxy in play, for naming it in a failure that escaped classification. */
async function resolvedProxyForError(): Promise<string | null> {
  try {
    const p = await currentProxy();
    return p === SOCKS_UNSUPPORTED ? null : p;
  } catch {
    return null;
  }
}

export function registerCloudRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.post('/api/v1/cloud/egress', async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return replyValidationError(reply, 'validation_error', parsed.error);
    }

    const { path, method, headers, body, timeoutMs } = parsed.data;

    const forwarded: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (FORWARDED_REQUEST_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
    }

    let url: URL;
    try {
      // Resolve the client's path against the cloud origin — this route owns
      // the origin, the caller never supplies a host. assertCloudUrl is still
      // applied afterwards as a backstop (it rejects a `//other.host` path, and
      // anything not https on the cloud origin).
      url = assertCloudUrl(new URL(path, cloudOrigin().origin).toString());
    } catch {
      return replyApiError(reply, 400, 'invalid_egress_path', 'That path is not a cloud API path.');
    }

    try {
      const out = await egressFetch({
        url: url.toString(),
        method,
        headers: forwarded,
        body,
        timeoutMs,
      });
      return { status: out.status, headers: out.headers, body: out.body };
    } catch (err) {
      // Every failure reaching here is a delivery failure: we are the ones who
      // could not deliver it, not the cloud. Classifying even the unexpected
      // ones matters — a proxy that resets the connection mid-tunnel throws
      // something undici-specific, and letting that escape as a bare 500
      // would put the user right back to "check your connection" with no idea
      // their proxy was the thing that broke.
      const failure =
        err instanceof EgressError ? err : classify(err, await resolvedProxyForError());
      return replyApiError(reply, 502, failure.reason, failure.message, {
        hint: failure.proxy ? `proxy: ${failure.proxy}` : undefined,
      });
    }
  });
}