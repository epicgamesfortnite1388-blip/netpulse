import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const TunnelTestRequestSchema = z.object({
  zone: z.string().trim().min(1).max(253).optional(),
  server: z.string().trim().min(1).max(64).optional(),
  pubkey: z.string().trim().min(1).max(160).optional(),
  url: z.string().url().optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(120_000).optional(),
});

export function registerWhitednsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Current WhiteDNS tunnel configuration (secrets are never returned).
  app.get('/api/v1/whitedns/config', async () => {
    return ctx.services.whitedns.config();
  });

  // Run the WhiteDNS Soar tunnel diagnostic. Falls back to the configured
  // zone/server/pubkey when the request omits them.
  app.post(
    '/api/v1/whitedns/tunnel-test',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = TunnelTestRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const configured = ctx.services.whitedns.config();
      const zone = parsed.data.zone ?? configured.zone;
      const server = parsed.data.server ?? configured.server;
      if (!zone || !server) {
        return {
          ok: false,
          stage: 'error',
          stages: [],
          checkedAt: Date.now(),
          tookMs: 0,
          error: 'WhiteDNS zone and server are not configured',
        };
      }
      return ctx.services.whitedns.test({
        zone: zone!,
        server: server!,
        pubkey: parsed.data.pubkey ?? undefined,
        url: parsed.data.url ?? 'https://example.com/',
        timeoutMs: parsed.data.timeoutMs ?? 60_000,
      });
    },
  );
}
