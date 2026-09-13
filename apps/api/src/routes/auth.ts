import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/session', async (req, reply) => {
    const session = ctx.auth.issueSession(req.ip);
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
