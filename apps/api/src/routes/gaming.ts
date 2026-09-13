import { gameById } from '../services/gameCatalog';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const GameTestSchema = z.object({
  gameId: z.string().min(1).max(64),
  timeoutMs: z.number().int().min(500).max(5_000).optional(),
});

const SessionSchema = z.object({
  gameId: z.string().min(1).max(64),
  customTarget: z.string().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  intervalMs: z.number().int().min(5_000).max(60_000).optional(),
});

const CompareSchema = z.object({
  gameId: z.string().min(1).max(64),
  mode: z.enum(['direct', 'vpn']),
  serverName: z.string().max(128).optional(),
});

export function registerGamingRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Catalog (games + platform ecosystems)
  app.get('/api/v1/gaming/games', async () => {
    const games = ctx.services.gaming.listGames();
    return {
      games,
      total: games.length,
      note: 'Endpoints are documented publisher/service front doors — reachability and latency to these do not equal in-game server RTT. From geo-filtered or sanctioned networks (e.g. most game publishers block Iranian IPs) an unreachable result is usually publisher-level blocking rather than an outage — retest with a different DNS (the DNS Lab lists Iranian resolvers such as Shecan and Begzar that restore access to sanctioned services) or compare Direct vs VPN before concluding a game is down.',
    };
  });

  app.get('/api/v1/gaming/games/:id', async (req) => {
    const { id } = req.params as { id: string };
    const game = gameById(id);
    if (!game) return { found: false };
    return { game };
  });

  // Run a region latency/reachability test for one game (202 + WS progress on testId)
  app.post(
    '/api/v1/gaming/test',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = GameTestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      if (!gameById(parsed.data.gameId)) {
        throw Object.assign(new Error(`Unknown game '${parsed.data.gameId}'`), { statusCode: 400, code: 'unknown_game' });
      }
      const testId = crypto.randomUUID();
      void ctx.services.gaming.runGameTest(parsed.data, testId).catch((err) => {
        ctx.log.error({ err, testId }, 'gaming test failed');
      });
      return reply.status(202).send({ testId });
    },
  );

  // Session monitor
  app.post(
    '/api/v1/gaming/session',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = SessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      return ctx.services.gaming.startSession(parsed.data);
    },
  );

  app.post('/api/v1/gaming/session/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    const state = ctx.services.gaming.stopSession(id);
    if (!state) return { stopped: false };
    return { stopped: true, state };
  });

  app.get('/api/v1/gaming/sessions', async () => ({ sessions: ctx.services.gaming.listSessions() }));

  app.get('/api/v1/gaming/session/:id', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.services.gaming.sessionDetail(id);
  });

  // Direct vs VPN comparison
  app.post(
    '/api/v1/gaming/compare',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = CompareSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      return ctx.services.gaming.captureComparison(parsed.data.gameId, parsed.data.mode, parsed.data.serverName);
    },
  );

  app.get('/api/v1/gaming/compare', async (req) => {
    const q = req.query as { gameId?: string };
    if (!q.gameId) return { found: false };
    return ctx.services.gaming.comparisonFor(q.gameId);
  });
}
