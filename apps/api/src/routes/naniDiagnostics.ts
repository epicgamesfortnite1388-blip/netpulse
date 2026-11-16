/**
 * NANI read-only diagnostics.
 *
 * One endpoint that folds the existing TCP/TLS probes into the NANI core and
 * returns the diagnosis. It is additive: the live NANI routes
 * (`/api/v1/nani/*`) and their recovery/activation behaviour are unchanged.
 *
 * The endpoint never registers APIs, activates recovery or mutates system
 * network state.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';
import { NaniDiagnosticAdapter } from '../services/naniDiagnosticAdapter';
import { AppError } from '../util/appError';
import { replyApiError } from '../util/apiError';

const ReadOnlyDiagnosticQuery = z.object({
  target: z.string().trim().min(1).max(256),
  /** `true` forces a TLS handshake; default is port 443 only. */
  tls: z.enum(['true', 'false']).optional(),
});

export function registerNaniDiagnosticRoutes(app: FastifyInstance, ctx: AppContext): void {
  const adapter = new NaniDiagnosticAdapter({ log: ctx.log });

  app.get('/api/v1/nani/diagnostics/read-only', async (req, reply) => {
    const parsed = ReadOnlyDiagnosticQuery.safeParse(req.query);
    if (!parsed.success) {
      return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    }
    try {
      const result = await adapter.diagnose(
        parsed.data.target,
        parsed.data.tls === undefined ? {} : { tls: parsed.data.tls === 'true' },
      );
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof AppError) {
        return replyApiError(
          reply,
          err.status,
          err.code,
          err.message,
          err.hint === undefined ? {} : { hint: err.hint },
        );
      }
      return replyApiError(reply, 500, 'diagnosis_failed', err instanceof Error ? err.message : String(err));
    }
  });
}
