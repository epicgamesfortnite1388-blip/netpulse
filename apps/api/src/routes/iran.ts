import { z } from 'zod';

import { IRAN_CATALOG, catalogById } from '../services/iranCatalog';
import { resolveTarget } from '../util/targetGuard';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';
import type { ConnectivityTarget } from '@netpulse/shared';

const RunSchema = z.object({
  targetIds: z.array(z.string().min(1).max(120)).min(1).max(120).optional(),
  connections: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
  repeats: z.coerce.number().int().min(1).max(5).optional(),
  includeRoute: z.boolean().optional(),
});

const CustomTargetSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().min(2).max(40),
  host: z.string().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
});

export function registerIranRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Catalog (data-driven, editable via custom targets)
  app.get('/api/v1/iran/catalog', async () => ({
    ...ctx.services.iran.listCatalog(),
    defaults: ctx.services.iran.curatedTargetIds(),
    custom: IRAN_CATALOG.filter((c) => c.custom === true),
  }));

  app.post(
    '/api/v1/iran/custom',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = CustomTargetSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const { name, category, host, port } = parsed.data;
      // SSRF guard: must resolve to a public address before we store it
      await resolveTarget(host, { allowPrivate: false });
      const target: ConnectivityTarget = {
        id: `custom:${Date.now().toString(36)}`,
        name,
        category: category as ConnectivityTarget['category'],
        hostnames: [host],
        urls: [`https://${host}/`],
        expectedProtocols: ['https'],
        port: port ?? 443,
        source: 'user-added',
        custom: true,
      };
      IRAN_CATALOG.push(target);
      return reply.status(201).send({ target });
    },
  );

  app.delete('/api/v1/iran/custom/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const idx = IRAN_CATALOG.findIndex((c) => c.id === id && c.custom === true);
    if (idx === -1) return reply.status(404).send({ error: 'not_found' });
    IRAN_CATALOG.splice(idx, 1);
    return { removed: true };
  });

  // Connections (direct + VPN profiles)
  app.get('/api/v1/iran/connections', async () => ({ connections: await ctx.services.iran.listConnections() }));

  // Run a session (async; live progress on WS topic = sessionId)
  app.post(
    '/api/v1/iran/run',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = RunSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const { sessionId } = ctx.services.iran.startSession(parsed.data);
      return reply.status(202).send({ sessionId });
    },
  );

  // Sessions + history
  app.get('/api/v1/iran/sessions', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit) || 20, 100);
    return { sessions: ctx.services.iran.listSessions(limit) };
  });

  app.get('/api/v1/iran/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.services.iran.getSession(id);
    if (!session) return null;
    return session;
  });

  // Direct-vs-VPN matrix for a session
  app.get('/api/v1/iran/matrix', async (req) => {
    const q = req.query as { sessionId?: string };
    const sessionId = q.sessionId;
    if (!sessionId) return { rows: [] };
    return { rows: ctx.services.iran.matrix(sessionId) };
  });

  // Recommendations
  app.get('/api/v1/iran/recommendations', async (req) => {
    const q = req.query as { sessionId?: string };
    const sessionId = q.sessionId;
    if (!sessionId) return { recommendations: [] };
    return { recommendations: ctx.services.iran.recommendations(sessionId) };
  });

  // Incidents (personal history diff)
  app.get('/api/v1/iran/incidents', async (req) => {
    const q = req.query as { days?: string };
    const days = Math.min(Number(q.days) || 30, 365);
    return { incidents: ctx.services.iran.incidents(days) };
  });

  // Report (privacy-safe export)
  app.get('/api/v1/iran/report/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { redact?: string };
    const report = ctx.services.iran.report(id, {
      redactPublicIp: q.redact === '1',
      redactHostnames: q.redact === '1',
    });
    if (!report) return null;
    return report;
  });

  app.post('/api/v1/iran/clear', async () => ctx.services.iran.clearHistory());

  // Helpers used by the UI
  app.get('/api/v1/iran/target/:id', async (req) => {
    const { id } = req.params as { id: string };
    return catalogById(id);
  });
}