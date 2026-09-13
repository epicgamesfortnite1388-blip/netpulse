import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import { AppError } from '../util/appError';

import type { AppContext } from './context';
import type { NodesService } from '../services/nodesService';
import { getKnownSources, createSourceFromInput, isValidSourceUrl } from '../services/nodeSourceRegistry';
import type { NodeProtocol, NodeSecurity, NodeSort, NodeStatus, PublicSource } from '@netpulse/shared';
import { proxyEngineStatus } from '../services/proxyEngineRunner';

const NodeFilterSchema = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'not-in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
});
const NodeFiltersSchema = z.array(NodeFilterSchema).max(20);
const SourceInputSchema = z.object({
  name: z.string().min(1).max(128),
  urls: z.array(z.string().url()).min(1).max(20),
  type: z.enum(['github_raw', 'github_repo_index', 'raw_file', 'subscription_url', 'website', 'custom']).optional(),
  formats: z.array(z.string()).optional(),
  intervalMinutes: z.coerce.number().int().min(15).max(1440).optional(),
  homepage: z.string().url().optional(),
  repositoryUrl: z.string().url().optional(),
  notes: z.string().max(500).optional(),
});
const ScannerStartSchema = z.object({
  kind: z.enum(['test', 'deep-test', 'health-check']),
  nodeIds: z.array(z.string()).optional(),
  filter: NodeFiltersSchema.optional(),
  concurrency: z.coerce.number().int().min(1).max(50).optional(),
  maxPerMinute: z.coerce.number().int().min(10).max(6000).optional(),
});
const TestEndpointInputSchema = z.object({
  name: z.string().min(1).max(128),
  url: z.string().url(),
  expectedStatus: z.coerce.number().int().min(100).max(599).optional(),
  timeoutMs: z.coerce.number().int().min(500).max(30000).optional(),
  maxBytes: z.coerce.number().int().min(100).max(1_000_000).optional(),
});

const NodeTestBodySchema = z.object({
  type: z.enum(['tcp', 'tls', 'proxy', 'icmp']).optional(),
  ip: z.string().trim().min(1).max(253).optional(),
});

const NodeTestBatchSchema = z.object({
  nodeIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  type: z.enum(['tcp', 'tls', 'proxy', 'icmp']).optional(),
});

const FavoriteSchema = z.object({
  favorite: z.boolean(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
});

const TagsSchema = z.object({
  tags: z.array(z.string().min(1).max(64)).min(0).max(20),
});

// Real scan registry: jobId -> cancel fn. Lets /scanner/stop abort a running
// scan between probes instead of only flipping the DB row.
const activeScanJobs = new Map<string, () => void>();

export function registerNodesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const nodesService = ctx.services.nodes as NodesService | undefined;

  // ================================================================
  // NODES
  // ================================================================

  // List nodes with filtering, sorting, pagination
  app.get('/api/v1/nodes', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const q = req.query as {
      limit?: string;
      offset?: string;
      protocol?: string;
      country?: string;
      asn?: string;
      status?: string;
      transport?: string;
      security?: string;
      freshness?: string;
      favorite?: string;
      search?: string;
      minScore?: string;
      maxLatency?: string;
      minReliability?: string;
      sortField?: string;
      sortDir?: string;
    };

    const limit = Math.min(Number(q.limit) || 100, 500);
    const offset = Number(q.offset) || 0;

    const sort: { field: string; dir: 'asc' | 'desc' } | undefined = q.sortField
      ? { field: q.sortField, dir: (q.sortDir as 'asc' | 'desc') || 'desc' }
      : undefined;

    const result = nodesService.listNodes({
      limit,
      offset,
      protocol: q.protocol as NodeProtocol,
      country: q.country || undefined,
      asn: q.asn ? Number(q.asn) : undefined,
      status: q.status as NodeStatus,
      transport: q.transport || undefined,
      security: q.security as NodeSecurity,
      freshness: q.freshness || undefined,
      favorite: q.favorite === '1' ? true : q.favorite === '0' ? false : undefined,
      search: q.search || undefined,
      minScore: q.minScore ? Number(q.minScore) : undefined,
      maxLatency: q.maxLatency ? Number(q.maxLatency) : undefined,
      minReliability: q.minReliability ? Number(q.minReliability) : undefined,
      sort: sort as NodeSort | undefined,
    });

    return {
      nodes: result.nodes,
      total: result.total,
      limit,
      offset,
    };
  });

  // Get single node
  app.get('/api/v1/nodes/:id', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { id } = req.params as { id: string };
    const node = nodesService.getNode(id);
    // 404 status, not a 200 body: api.get on the frontend throws on non-2xx,
    // so detail pages show their not-found/error state instead of rendering
    // the error object as a node (which crashed on node.ipv4[0]).
    if (!node) return reply.status(404).send({ error: 'not_found', message: `Node "${id}" not found` });

    return node;
  });

  // Search nodes
  app.get('/api/v1/nodes/search', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const q = req.query as { q?: string; limit?: string };
    const query = q.q || '';
    if (!query) return { results: [] };

    const limit = Math.min(Number(q.limit) || 50, 200);
    const results = nodesService.searchNodes(query, limit);

    return { results };
  });

  // Get nodes by IP
  app.get('/api/v1/nodes/by-ip/:ip', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { ip } = req.params as { ip: string };
    const nodes = nodesService.getNodesByIp(ip);

    return { nodes };
  });

  // Get nodes by ASN
  app.get('/api/v1/nodes/by-asn/:asn', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { asn } = req.params as { asn: string };
    const asnNum = Number(asn);
    if (!Number.isFinite(asnNum)) throw new AppError(400, 'invalid_asn', 'ASN must be a positive integer');

    const nodes = nodesService.getNodesByAsn(asnNum);

    return { nodes };
  });

  // Get nodes by hostname
  app.get('/api/v1/nodes/by-host/:host', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { host } = req.params as { host: string };
    const nodes = nodesService.getNodesByHostname(host);

    return { nodes };
  });

  // Test a node
  app.post('/api/v1/nodes/:id/test', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { id } = req.params as { id: string };
    const parsed = NodeTestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }
    const type = parsed.data.type ?? 'tcp';

    // Check rate limit
    const node = nodesService.getNode(id);
    if (!node) return reply.status(404).send({ error: 'not_found', message: `Node "${id}" not found` });

    const nodeTests = ctx.repos.nodeTests;
    const recentCount = nodeTests.recentForNode(id, Date.now() - 60_000);
    if (recentCount.length >= 60) {
      return reply.status(429).send({ error: 'rate_limited', reason: 'too many tests in last minute' });
    }

    try {
      const result = await nodesService.testNode(id, type, parsed.data.ip || undefined);
      return result;
    } catch (err) {
      // AppError (e.g. private_target_not_allowed from the SSRF guard) is
      // rethrown so the global error handler renders it with the standard
      // nested error shape and the AppError's own 4xx status.
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'test_failed', detail: message });
    }
  });

  // Test multiple nodes (batch)
  app.post('/api/v1/nodes/test-batch', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const parsed = NodeTestBatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }
    const nodeIds = parsed.data.nodeIds;
    const type = parsed.data.type ?? 'tcp';

    const results: Record<string, { success: boolean; latencyMs?: number; error?: string }> = {};

    // Bounded parallelism: sequential testing of 100 nodes would hold this
    // request open for minutes; unbounded Promise.all would saturate sockets.
    // 8 workers keep completion times reasonable without overwhelming the OS.
    const CONCURRENCY = 8;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < nodeIds.length) {
        const nodeId = nodeIds[cursor++] ?? '';
        if (!nodeId) break;
        try {
          const result = await nodesService.testNode(nodeId, type);
          results[nodeId] = {
            success: result.status === 'done',
            latencyMs: result.latencyMs || undefined,
            error: result.error || undefined,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results[nodeId] = { success: false, error: message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, nodeIds.length) }, worker));

    return { results };
  });

  // Set favorite
  app.post('/api/v1/nodes/:id/favorite', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { id } = req.params as { id: string };
    const parsed = FavoriteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      nodesService.setFavorite(id, parsed.data.favorite, parsed.data.tags);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Set tags
  app.post('/api/v1/nodes/:id/tags', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const { id } = req.params as { id: string };
    const parsed = TagsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      nodesService.setTags(id, parsed.data.tags);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Export nodes
  app.get('/api/v1/nodes/export', async (req, _reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const q = req.query as { nodeIds?: string; format?: string };
    const nodeIdsParam = q.nodeIds || '';
    const format = (q.format || 'uri') as 'uri' | 'plaintext' | 'base64' | 'json' | 'clash' | 'singbox';

    const nodeIds = nodeIdsParam.split(',').filter((s) => s.trim().length > 0);
    if (nodeIds.length === 0) throw new AppError(400, 'no_node_ids', 'Provide at least one node id');
    if (nodeIds.length > 1000) throw new AppError(400, 'too_many_nodes', 'Maximum 1000 node ids per request');

    const exportData = nodesService.exportNodes(nodeIds, format);

    return {
      format,
      exportedAt: Date.now(),
      count: nodeIds.length,
      data: exportData,
    };
  });

  // ================================================================
  // SOURCES
  // ================================================================

  // List all known sources
  app.get('/api/v1/sources', async () => {
    // DB is the single source of truth (built-ins are seeded at boot; custom
    // sources live here too). Falls back to constants if the DB is empty.
    const dbRows = ctx.repos.publicSources.list();
    const sources = dbRows.length > 0
      ? dbRows.map((r) => ({
          id: r.id,
          name: r.name,
          homepage: r.homepage,
          repositoryUrl: r.repositoryUrl,
          enabled: r.enabled,
          type: r.type as PublicSource['type'],
          urls: r.urls,
          formats: r.formats,
          intervalMinutes: r.intervalMinutes,
          lastFetch: r.lastFetch,
          lastSuccess: r.lastSuccess,
          lastFailure: r.lastFailure,
          status: r.status,
          discoveredConfigCount: r.discoveredConfigCount,
          importedConfigCount: r.importedConfigCount,
          duplicateCount: r.duplicateCount,
          invalidCount: r.invalidCount,
          recentDiscovered: r.recentDiscovered,
          recentImported: r.recentImported,
          recentHealthy: r.recentHealthy,
          health: r.health,
          lastContentHash: r.lastContentHash,
          notes: r.notes,
          createdAt: r.createdAt,
        }))
      : getKnownSources();
    return {
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        homepage: s.homepage,
        repositoryUrl: s.repositoryUrl,
        enabled: s.enabled,
        type: s.type,
        urls: s.urls,
        formats: s.formats,
        intervalMinutes: s.intervalMinutes,
        lastFetch: s.lastFetch,
        lastSuccess: s.lastSuccess,
        lastFailure: s.lastFailure,
        status: s.status,
        discoveredConfigCount: s.discoveredConfigCount,
        importedConfigCount: s.importedConfigCount,
        duplicateCount: s.duplicateCount,
        invalidCount: s.invalidCount,
        recentDiscovered: s.recentDiscovered,
        recentImported: s.recentImported,
        recentHealthy: s.recentHealthy,
        health: s.health,
        lastContentHash: s.lastContentHash,
        notes: s.notes,
        createdAt: s.createdAt,
      })),
      total: sources.length,
    };
  });

  // Get single source
  app.get('/api/v1/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = ctx.repos.publicSources.get(id);
    const source = row ?? getKnownSources().find((s) => s.id === id);
    if (!source) return reply.status(404).send({ error: 'not_found', message: `Source "${id}" not found` });

    return source;
  });

  // Toggle a source enabled/disabled (sources UI).
  app.patch('/api/v1/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }
    if (!ctx.repos.publicSources.get(id)) {
      return reply.status(404).send({ error: 'not_found', message: `Source "${id}" not found` });
    }
    ctx.repos.publicSources.update(id, { enabled: parsed.data.enabled });
    return { ok: true, id, enabled: parsed.data.enabled };
  });

  // Delete a custom source (sources UI).
  app.delete('/api/v1/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.publicSources.get(id)) {
      return reply.status(404).send({ error: 'not_found', message: `Source "${id}" not found` });
    }
    const removed = ctx.repos.publicSources.remove(id);
    return { ok: removed };
  });

  // Create custom source
  app.post('/api/v1/sources', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = SourceInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const input = parsed.data;

    // Validate URLs
    for (const url of input.urls) {
      const validation = isValidSourceUrl(url);
      if (!validation.ok) {
        return reply.status(400).send({ error: 'invalid_url', detail: `${url}: ${validation.error}` });
      }
    }

    const source = createSourceFromInput(input);

    // Store in database
    ctx.repos.publicSources.insert({
      id: source.id,
      name: source.name,
      homepage: source.homepage ?? null,
      repositoryUrl: source.repositoryUrl ?? null,
      enabled: source.enabled,
      type: source.type,
      urls: source.urls,
      formats: source.formats,
      intervalMinutes: source.intervalMinutes,
      lastFetch: source.lastFetch,
      lastSuccess: source.lastSuccess,
      lastFailure: source.lastFailure,
      status: source.status,
      discoveredConfigCount: source.discoveredConfigCount,
      importedConfigCount: source.importedConfigCount,
      duplicateCount: source.duplicateCount,
      invalidCount: source.invalidCount,
      recentDiscovered: source.recentDiscovered,
      recentImported: source.recentImported,
      recentHealthy: source.recentHealthy,
      health: source.health,
      lastContentHash: source.lastContentHash,
      notes: source.notes ?? null,
      createdAt: source.createdAt,
    });

    return reply.status(201).send(source);
  });

  // Fetch source manually
  // Trigger a real fetch+parse+import of a source through the nodes service.
  app.post('/api/v1/sources/:id/fetch', async (req, reply) => {
    const { id } = req.params as { id: string };

    if (!nodesService) return reply.status(503).send({ error: 'nodes service unavailable' });

    const source = ctx.repos.publicSources.get(id) ?? getKnownSources().find((s) => s.id === id);
    if (!source) return reply.status(404).send({ error: 'not_found' });

    try {
      const result = await nodesService.discoverFromSource(id);
      ctx.bus.publish('sources', {
        type: 'source:fetch:completed',
        sourceId: id,
        sourceName: source.name,
        imported: result.imported,
        duplicates: result.duplicates,
        invalid: result.invalid,
      });
      return { status: 'completed', ...result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ctx.bus.publish('sources', {
        type: 'source:fetch:failed',
        sourceId: id,
        sourceName: source.name,
        error,
      });
      // Use the app-wide error body shape ({error:{code,message}}) so the UI's
      // ApiError parser surfaces the real upstream failure, not just the status text.
      return reply.status(502).send({ error: { code: 'fetch_failed', message: error } });
    }
  });

  // ================================================================
  // SCANNER
  // ================================================================

  // Start scan job
  app.post('/api/v1/scanner/start', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = ScannerStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    if (!nodesService) return reply.status(503).send({ error: 'not configured' });

    const body = parsed.data;
    const jobId = `scan:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    // Resolve the work set BEFORE creating the job row: resolving can bail
    // out with a 400 (no nodeIds + empty DB), and creating the row first
    // would strand it as status='running' forever.
    const MAX_SCAN_TARGETS = 1000;
    let targets: string[] = (body.nodeIds ?? []).slice(0, MAX_SCAN_TARGETS);
    if (targets.length === 0) {
      const { nodes } = nodesService.listNodes({ limit: MAX_SCAN_TARGETS });
      targets = nodes.map((n) => n.id);
    }
    if (targets.length === 0) {
      return reply.status(400).send({ error: 'no_targets', detail: 'Provide nodeIds or a filter that matches at least one node.' });
    }

    // Create scan job
    ctx.repos.scanJobs.create({
      id: jobId,
      name: `Scan ${body.kind} ${body.nodeIds?.length || 'all'} nodes`,
      kind: body.kind,
      status: 'running',
      filter: body.filter ? JSON.parse(JSON.stringify(body.filter)) : null,
      nodeIds: body.nodeIds || [],
      concurrency: body.concurrency || 10,
      maxPerMinute: body.maxPerMinute || 600,
      progress: 0,
      discovered: 0,
      tested: 0,
      healthy: 0,
      degraded: 0,
      failed: 0,
      startedAt: now,
      finishedAt: null,
      error: null,
      createdAt: now,
    });

    const testType: 'tcp' | 'tls' | 'proxy' | 'icmp' =
      body.kind === 'deep-test' ? 'proxy' : body.kind === 'health-check' ? 'icmp' : 'tcp';
    const concurrency = Math.min(body.concurrency ?? 8, 16);
    const total = targets.length;

    ctx.repos.scanJobs.update(jobId, { nodeIds: targets, concurrency });

    // Real scan: bounded workers run the same probe pipeline as /nodes/test.
    // Progress counters reflect actual probe outcomes — no simulation.
    let cancelled = false;
    activeScanJobs.set(jobId, () => { cancelled = true; });

    setImmediate(async () => {
      let tested = 0;
      let healthy = 0;
      let degraded = 0;
      let failed = 0;
      const startedAt = Date.now();
      const publishProgress = () => {
        ctx.bus.publish('scanner', {
          type: 'scanner:progress',
          jobId,
          progress: Math.round((tested / total) * 100),
          tested,
          healthy,
          degraded,
          failed,
          // Measured, not invented: probes completed per second since start.
          throughput: tested > 0 ? Math.round((tested / Math.max(0.001, (Date.now() - startedAt) / 1000)) * 10) / 10 : 0,
        });
      };

      try {
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (!cancelled) {
            const nodeId = targets[cursor++];
            if (!nodeId) break;
            try {
              const result = await nodesService.testNode(nodeId, testType);
              tested++;
              if (result.status === 'done') {
                healthy++;
              } else if (result.status === 'error' || result.status === 'failed') {
                failed++;
              } else {
                degraded++;
              }
            } catch {
              tested++;
              failed++;
            }
            if (tested % Math.max(1, Math.floor(total / 20)) === 0 || tested === total) publishProgress();
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

        if (cancelled) {
          ctx.repos.scanJobs.finish(jobId, 'cancelled');
          ctx.bus.publish('scanner', { type: 'scanner:cancelled', jobId });
        } else {
          ctx.repos.scanJobs.bumpProgress(jobId, { progress: 100, tested, healthy, degraded, failed });
          ctx.repos.scanJobs.finish(jobId, 'completed');
          ctx.bus.publish('scanner', { type: 'scanner:completed', jobId, progress: 100, tested, healthy, degraded, failed });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.repos.scanJobs.finish(jobId, 'error', error);
        ctx.bus.publish('scanner', {
          type: 'scanner:failed',
          jobId,
          error,
        });
      } finally {
        activeScanJobs.delete(jobId);
      }
    });

    return { jobId, status: 'running', total };
  });

  // Stop scan job — signals the workers to stop between probes.
  app.post('/api/v1/scanner/stop/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = ctx.repos.scanJobs.get(jobId);

    if (!job) return reply.status(404).send({ error: 'not_found', message: `Scan job "${jobId}" not found` });
    if (job.status !== 'running') throw new AppError(409, 'not_running', 'Scan job is not running');

    const cancel = activeScanJobs.get(jobId);
    if (cancel) {
      cancel();
      return { success: true, cancelling: true };
    }

    // No live workers (e.g. process restart lost the registry): close the row.
    ctx.repos.scanJobs.finish(jobId, 'cancelled');
    ctx.bus.publish('scanner', {
      type: 'scanner:cancelled',
      jobId,
    });

    return { success: true };
  });

  // Get scan job status
  app.get('/api/v1/scanner/status/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = ctx.repos.scanJobs.get(jobId);

    if (!job) return reply.status(404).send({ error: 'not_found', message: `Scan job "${jobId}" not found` });

    return job;
  });

  // List scan jobs
  app.get('/api/v1/scanner/jobs', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit) || 20, 100);
    const jobs = ctx.repos.scanJobs.list(limit);

    return { jobs, total: jobs.length };
  });

  // ================================================================
  // TEST ENDPOINTS
  // ================================================================

  // List test endpoints
  app.get('/api/v1/test-endpoints', async () => {
    const endpoints = ctx.repos.testEndpoints.list();
    return { endpoints };
  });

  // Add test endpoint
  app.post('/api/v1/test-endpoints', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = TestEndpointInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const input = parsed.data;
    const id = `endpoint:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

    ctx.repos.testEndpoints.insert({
      id,
      name: input.name,
      url: input.url,
      expectedStatus: input.expectedStatus || 200,
      timeoutMs: input.timeoutMs || 5000,
      maxBytes: input.maxBytes || 4096,
      enabled: true,
      createdAt: Date.now(),
    });

    return reply.status(201).send({ id, ...input, enabled: true, createdAt: Date.now() });
  });

  // Delete test endpoint
  app.delete('/api/v1/test-endpoints/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = ctx.repos.testEndpoints.remove(id);

    if (!removed) return reply.status(404).send({ error: 'not_found', message: `Test endpoint "${id}" not found` });
    return { success: true };
  });

  // ================================================================
  // NODE HISTORY / STATS
  // ================================================================

  // Get node test history
  app.get('/api/v1/nodes/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string; since?: string };

    const limit = Math.min(Number(q.limit) || 100, 1000);
    const since = q.since ? Number(q.since) : Date.now() - 7 * 24 * 60 * 60 * 1000;

    const tests = ctx.repos.nodeTests.recentForNode(id, since);
    const limited = tests.slice(0, limit);

    return {
      tests: limited.map((t) => ({
        id: t.id,
        type: t.type,
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        latencyMs: t.latencyMs,
        totalMs: t.totalMs,
        tlsVersion: t.tlsVersion,
        authorized: t.authorized,
        httpStatus: t.httpStatus,
        responseSize: t.responseSize,
        error: t.error,
        family: t.family,
        probedIp: t.probedIp,
        testEndpoint: t.testEndpoint,
      })),
      total: tests.length,
    };
  });

  // Get node health stats
  app.get('/api/v1/nodes/:id/health', async (req) => {
    const { id } = req.params as { id: string };
    const health = ctx.repos.nodeHealth.get(id);

    if (!health) {
      return {
        nodeId: id,
        testCount: 0,
        successCount: 0,
        failureCount: 0,
        reliabilityPct: 0,
        medianLatencyMs: null,
        p95LatencyMs: null,
        lossPct: 0,
        latencyVariance: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        healthyForMs: null,
        computedAt: Date.now(),
      };
    }

    return health;
  });

  // ================================================================
  // RECOMMENDATIONS
  // ================================================================

  app.get('/api/v1/nodes/recommend', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const q = req.query as {
      preset?: string;
      country?: string;
      asn?: string;
      ipv4?: string;
      ipv6?: string;
      vpnActive?: string;
      directReliable?: string;
      targetService?: string;
      limit?: string;
    };

    const preset = (q.preset || 'best-for-current-network') as 'fastest' | 'most-stable' | 'lowest-loss' | 'best-for-gaming' | 'best-for-video' | 'best-for-current-network' | 'best-ipv6' | 'best-route' | 'best-recently-verified' | 'most-sources' | 'newest';
    const limit = Math.min(Number(q.limit) || 10, 50);

    const nodes = nodesService.recommendNodes({
      preset,
      country: q.country || undefined,
      asn: q.asn ? Number(q.asn) : undefined,
      ipv4: q.ipv4 === '1',
      ipv6: q.ipv6 === '1',
      vpnActive: q.vpnActive === '1',
      directReliable: q.directReliable === '1',
      targetService: q.targetService || undefined,
      limit,
    });

    return {
      preset,
      context: {
        country: q.country,
        asn: q.asn ? Number(q.asn) : undefined,
        ipv4: q.ipv4 === '1',
        ipv6: q.ipv6 === '1',
        vpnActive: q.vpnActive === '1',
        directReliable: q.directReliable === '1',
        targetService: q.targetService,
      },
      nodes,
      generatedAt: Date.now(),
    };
  });

  // ================================================================
  // STATS / COUNTS
  // ================================================================

  // Proxy-core engine availability (xray / sing-box). Cheap PATH checks; the
  // UI shows which engine proxy tests will use and links install guidance.
  app.get('/api/v1/nodes/engines', async () => {
    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';
    return proxyEngineStatus(preferred);
  });

  app.get('/api/v1/nodes/stats', async () => {
    const statusCounts = ctx.repos.publicNodes.statusCounts();
    const total = ctx.repos.publicNodes.list({ limit: 1 }).total;

    return {
      total,
      discovered: statusCounts.discovered,
      healthy: statusCounts.healthy,
      degraded: statusCounts.degraded,
      failed: statusCounts.failed,
      stale: statusCounts.stale,
      favoriteCount: ctx.repos.publicNodes.list({ favorite: true, limit: 1 }).total,
      protocolBreakdown: ctx.repos.publicNodes.list({ limit: 1000 }).rows.reduce((acc, n) => {
        acc[n.protocol] = (acc[n.protocol] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      countryBreakdown: ctx.repos.publicNodes.list({ limit: 1000 }).rows.reduce((acc, n) => {
        if (n.country) {
          acc[n.country] = (acc[n.country] || 0) + 1;
        }
        return acc;
      }, {} as Record<string, number>),
      transportBreakdown: ctx.repos.publicNodes.list({ limit: 1000 }).rows.reduce((acc, n) => {
        acc[n.transport] = (acc[n.transport] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
  });
}
