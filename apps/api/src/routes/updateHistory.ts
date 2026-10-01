import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

/**
 * Update history — what the updater did, when, and why (see
 * services/updateFeedHistory.ts). Authenticated like every other user-data
 * route (unlike the PUBLIC update-feed file routes): history is the app's own
 * diary, not something another local process gets to read or write.
 */

const RecordSchema = z.object({
  kind: z.enum(['check', 'install']),
  outcome: z.enum(['up-to-date', 'available', 'failed', 'started', 'completed']),
  fromVersion: z.string().max(64).nullish(),
  toVersion: z.string().max(64).nullish(),
  reason: z.string().max(2000).nullish(),
});

export function registerUpdateHistoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/update-history', async (req) => {
    const q = z.coerce.number().int().min(1).max(100).default(100).parse((req.query as { limit?: string }).limit);
    return { events: ctx.services.updateHistory.list(q) };
  });

  app.post('/api/v1/update-history', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = RecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_event', message: 'Malformed update-history event' } });
    }
    ctx.services.updateHistory.record(parsed.data);
    return reply.code(204).send();
  });

  /**
   * Clear the diary. Same auth as read/write — wiping history is at least as
   * sensitive as writing it. Returns the removed count so the UI can confirm
   * what was actually deleted instead of assuming.
   */
  app.delete('/api/v1/update-history', async () => {
    const removed = ctx.services.updateHistory.clear();
    return { ok: true, removed };
  });
}
