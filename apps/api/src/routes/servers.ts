import crypto from 'node:crypto';

import { TargetSchema } from '@netpulse/shared';
import { z } from 'zod';

import { badRequest, newNotFound } from '../util/appError';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

export const ServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['vps', 'diag', 'speedtest']),
  host: TargetSchema,
  ipv4: z.ipv4().nullish(),
  ipv6: z.ipv6().nullish(),
  provider: z.string().trim().max(100).nullish(),
  region: z.string().trim().max(100).nullish(),
  country: z.string().trim().max(100).nullish(),
  city: z.string().trim().max(100).nullish(),
  protocol: z.string().trim().max(20).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  capabilities: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).default([]),
  enabled: z.boolean().default(true),
});

const ServerPatchSchema = ServerCreateSchema.partial();

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/servers', async () => ({ servers: ctx.repos.servers.list() }));

  app.get('/api/v1/servers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const server = ctx.repos.servers.get(id);
    if (!server) throw newNotFound(`Server "${id}" not found`);
    return { server };
  });

  app.post('/api/v1/servers', async (req, reply) => {
    const parsed = ServerCreateSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const created = ctx.repos.servers.create(crypto.randomUUID(), parsed.data);
    ctx.services.events.record('info', 'system', `Server "${parsed.data.name}" added (${parsed.data.kind})`);
    reply.status(201);
    return { server: created };
  });

  app.patch('/api/v1/servers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ServerPatchSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    if (!ctx.repos.servers.get(id)) throw newNotFound(`Server "${id}" not found`);
    const updated = ctx.repos.servers.update(id, parsed.data);
    return { server: updated };
  });

  app.delete('/api/v1/servers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const removed = ctx.repos.servers.remove(id);
    if (!removed) throw newNotFound(`Server "${id}" not found`);
    return { ok: true };
  });

  app.get('/api/v1/servers/:id/health', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.servers.get(id)) throw newNotFound(`Server "${id}" not found`);
    const samples = ctx.repos.serverHealth.latestForServer(id, 100).reverse();
    return { serverId: id, samples, monitorRunning: ctx.services.healthMonitor.isRunning() };
  });

  app.post('/api/v1/servers/:id/check', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.servers.get(id)) throw newNotFound(`Server "${id}" not found`);
    await ctx.services.healthMonitor.checkServer(id);
    const samples = ctx.repos.serverHealth.latestForServer(id, 1);
    return { serverId: id, latest: samples[0] ?? null };
  });

  app.post('/api/v1/servers/recommend', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = z
      .object({
        serverIds: z.array(z.string().min(1).max(64)).max(32).optional(),
        probes: z.coerce.number().int().min(3).max(12).optional(),
        withRoute: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw parsed.error;

    const all = ctx.repos.servers.list().filter((s) => s.enabled);
    const wanted = parsed.data.serverIds
      ? parsed.data.serverIds
          .map((id) => all.find((s) => s.id === id))
          .filter((s): s is NonNullable<typeof s> => s != null)
      : all;
    if (wanted.length === 0) {
      throw badRequest('no_candidates', 'No enabled servers available to recommend from. Add servers first.');
    }

    const candidates = wanted.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port ?? (s.protocol === 'http' || s.kind === 'diag' ? 443 : null),
    }));

    // long-running: 202 + job pattern, progress over WebSocket by testId
    const testId = crypto.randomUUID();
    void ctx.services.selection
      .run({ candidates, probes: parsed.data.probes, withRoute: parsed.data.withRoute }, testId)
      .catch(() => undefined);
    return reply.status(202).send({ testId });
  });

  app.get('/api/v1/servers/recommendations', async (req) => {
    // history of selection runs (reuses optimization test records)
    const q = z.coerce.number().int().min(1).max(50).default(10).safeParse((req.query as { limit?: string }).limit ?? undefined);
    const rows = ctx.repos.tests.list({ type: 'optimization', limit: q.success ? q.data : 10 });
    return { runs: rows };
  });

  app.post('/api/v1/health-monitor/:action', async (req) => {
    const { action } = req.params as { action: string };
    if (action === 'start') {
      ctx.services.healthMonitor.start();
      return { running: ctx.services.healthMonitor.isRunning() };
    }
    if (action === 'stop') {
      ctx.services.healthMonitor.stop();
      return { running: ctx.services.healthMonitor.isRunning() };
    }
    throw badRequest('invalid_action', `Unknown action "${action}"`, 'Use "start" or "stop".');
  });

  app.get('/api/v1/health-monitor/status', async () => ({
    running: ctx.services.healthMonitor.isRunning(),
  }));
}
