import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Session issuance is loopback-only AND browser-origin gated (see
  // `sessionOriginRefusal` in ../auth): a page the user merely visited must not
  // be able to mint a cookie that satisfies every mutating route. The whole
  // request is passed, not just the IP, because the origin and the
  // browser-fetch-metadata markers are what decide it.
  app.post('/api/v1/auth/session', async (req, reply) => {
    const session = ctx.auth.issueSession({
      headers: req.headers as Record<string, unknown>,
      cookies: req.cookies as Record<string, string | undefined>,
      method: req.method,
      ip: req.ip,
    });
    reply.setCookie(session.cookieName, session.cookieValue, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      expires: session.expires,
      secure: false, // localhost HTTP; enable when served over TLS
    });
    return { ok: true, expiresInMs: session.ttlMs };
  });
}
