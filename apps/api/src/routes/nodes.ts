import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import { AppError } from '../util/appError';
import { replyApiError, replyValidationError } from '../util/apiError';
import { scrubberFromRows } from '../services/endpointScrub';
import { isPrivateIp } from '../util/targetGuard';
import { maskSourceUrl } from '../util/redact';
import { MAX_LIST_LIMIT } from '../db/repositories';

import type { AppContext } from './context';
import type { NodesService } from '../services/nodesService';
import { getKnownSources, createSourceFromInput, isValidSourceUrl } from '../services/nodeSourceRegistry';
import { recheckNodeGeo } from '../services/nodeGeoService';
import type { NodeProtocol, NodeSecurity, NodeSort, NodeStatus, PublicSource } from '@netpulse/shared';
import { EngineInstallRequestSchema } from '@netpulse/shared';
import { proxyEngineStatus } from '../services/proxyEngineRunner';
import { checkLatestReleases, installEngine, installedEngineVersions } from '../services/engineManager';

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

// --- Path-parameter schemas (MEDIUM-01 fix) ---
// Validate all route path parameters with strict allowlists before use.
// Prevents injection into log paths, SQL identifiers, and cache keys.

const IdSchema = z.string().min(1).max(128).regex(/^[a-z0-9:._-]+$/i, 'id must be alphanumeric, colon, dot, underscore, or hyphen');
const IpSchema = z.union([z.ipv4(), z.ipv6()]);
const AsnSchema = z.number().int().positive().max(4_294_967_295);
const HostSchema = z.string().min(1).max(253).regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/, 'invalid hostname');
const SourceIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9:._-]+$/i, 'source id must be alphanumeric, colon, dot, underscore, or hyphen');
const JobIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9:._-]+$/i, 'job id must be alphanumeric, colon, dot, underscore, or hyphen');

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
      engine?: string;
      sortField?: string;
      sortDir?: string;
    };

    // Honour the caller's page size up to the repository's ceiling instead of
    // clamping at 500 in silence — the map asks for 1,500 and used to receive
    // 500 without ever being told.
    const limit = Math.min(Number(q.limit) || 100, MAX_LIST_LIMIT);
    const offset = Math.max(0, Number(q.offset) || 0);

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
      engine: q.engine || undefined,
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

    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const node = nodesService.getNode(id);
    // 404 status, not a 200 body: api.get on the frontend throws on non-2xx,
    // so detail pages show their not-found/error state instead of rendering
    // the error object as a node (which crashed on node.ipv4[0]).
    if (!node) return replyApiError(reply, 404, 'not_found', `Node "${id}" not found`);

    return node;
  });

  /**
   * RETIRED — was `GET /api/v1/nodes/:id/link`.
   *
   * This handed the caller a complete, credential-bearing share link
   * (`vless://<uuid>@host:port?…`). Hiding the button that called it was never a
   * fix: the webview console can call any route, so the capability had to leave
   * the API entirely. Nodes are now chosen by place and ping on the globe and
   * dialled by `POST /vpn/profiles/from-node`, which rebuilds the link
   * server-side and never returns it.
   *
   * 410 Gone rather than a 404: this endpoint existed and answered, so "not
   * found" would read to an older client as a typo or a bug. Gone says the
   * capability was withdrawn deliberately, and that is the truth. It is a
   * tombstone, not a re-gate — no caller, and no entitlement, gets a link back.
   */
  app.get('/api/v1/nodes/:id/link', async (_req, reply) =>
    replyApiError(reply, 410, 'share_link_retired', 'Share links are no longer served. Pick a node by location and ping on the map, or add it to an engine, and the app dials it without ever handing the configuration out.'),
  );

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

    const raw = (req.params as { ip: string }).ip;
    const parsed = IpSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'invalid_ip', parsed.error.message);
    const ip = parsed.data;
    const nodes = nodesService.getNodesByIp(ip);

    return { nodes };
  });

  // Get nodes by ASN
  app.get('/api/v1/nodes/by-asn/:asn', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const raw = (req.params as { asn: string }).asn;
    const asnNum = Number(raw);
    const parsed = AsnSchema.safeParse(asnNum);
    if (!parsed.success) throw new AppError(400, 'invalid_asn', parsed.error.message);

    const nodes = nodesService.getNodesByAsn(asnNum);

    return { nodes };
  });

  // Get nodes by hostname
  app.get('/api/v1/nodes/by-host/:host', async (req) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const raw = (req.params as { host: string }).host;
    const parsed = HostSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'invalid_host', parsed.error.message);
    const host = parsed.data;
    const nodes = nodesService.getNodesByHostname(host);

    return { nodes };
  });

  // Test a node
  app.post('/api/v1/nodes/:id/test', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const body = NodeTestBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      return replyValidationError(reply, 'validation_error', body.error);
    }
    const type = body.data.type ?? 'tcp';

    // Route-level SSRF guard: a caller-supplied IP override pointing at
    // loopback/private/link-local space is rejected BEFORE the node lookup —
    // no node-existence oracle, no socket. (resolveTarget re-validates inside
    // the service as defense in depth.)
    if (body.data.ip && isPrivateIp(body.data.ip)) {
      throw new AppError(400, 'private_target_not_allowed', 'Private or link-local targets are not allowed');
    }

    // The raw row (not the DTO): probe failures quote what they tried to
    // reach — DNS refusals embed the hostname, socket errors the IP:port — so
    // error text is masked against this node's own addresses before it leaves.
    const rawRow = ctx.repos.publicNodes.get(id) ?? null;
    const scrub = rawRow ? scrubberFromRows([rawRow]) : null;
    const maskMsg = (text: string): string => (scrub && scrub.size > 0 ? scrub.mask(text) : text);
    // Check rate limit
    const node = nodesService.getNode(id);
    if (!node) return replyApiError(reply, 404, 'not_found', `Node "${id}" not found`);

    const nodeTests = ctx.repos.nodeTests;
    const recentCount = nodeTests.recentForNode(id, Date.now() - 60_000);
    if (recentCount.length >= 60) {
      return replyApiError(reply, 429, 'rate_limited', 'Too many tests in the last minute');
    }

    try {
      const result = await nodesService.testNode(id, type, body.data.ip || undefined);
      // `probedIp` IS the address that was dialled (the node's own, unless the
      // caller supplied the override it already knows), and the error string
      // can quote it — both stay server-side. Absent key, not null: the field
      // is withheld, not unknown.
      const response = { ...result };
      delete response.probedIp;
      if (response.error) response.error = maskMsg(response.error);
      return response;
    } catch (err) {
      // AppError (e.g. private_target_not_allowed from the SSRF guard) is
      // rethrown so the global error handler renders it with the standard
      // nested error shape and the AppError's own 4xx status. Its message is
      // masked first: `"<host>" did not resolve` would otherwise hand the
      // endpoint back through the failure path.
      if (err instanceof AppError) {
        throw scrub && scrub.size > 0 ? new AppError(err.status, err.code, scrub.mask(err.message), err.hint) : err;
      }
      const message = err instanceof Error ? err.message : String(err);
      return replyApiError(reply, 500, 'test_failed', maskMsg(message));
    }
  });

  // Test multiple nodes (batch)
  app.post('/api/v1/nodes/test-batch', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const parsed = NodeTestBatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyValidationError(reply, 'validation_error', parsed.error);
    }
    const nodeIds = parsed.data.nodeIds;
    const type = parsed.data.type ?? 'tcp';

    const results: Record<string, { success: boolean; latencyMs?: number; error?: string }> = {};

    // Testing goes through the service's bulk path: `proxy` runs several nodes
    // through ONE shared core instead of one process per node, tcp/tls/icmp
    // keep bounded concurrency (they spawn nothing). The response shape and
    // the masking rules are unchanged.
    const outcomes = await nodesService.testNodes(nodeIds, type);
    const mask = (nodeId: string, text: string): string => {
      // Same rule as the single-test route: a probe error may quote the
      // node's address, so it is masked against that node's row.
      const row = ctx.repos.publicNodes.get(nodeId);
      const s = row ? scrubberFromRows([row]) : null;
      return s && s.size > 0 ? s.mask(text) : text;
    };

    outcomes.forEach((outcome, i) => {
      const nodeId = nodeIds[i] ?? '';
      if (!outcome) return;
      if (!outcome.result) {
        results[nodeId] = { success: false, error: mask(nodeId, outcome.error ?? 'test failed') };
        return;
      }
      const error = outcome.result.error || undefined;
      results[nodeId] = {
        success: outcome.result.status === 'done',
        latencyMs: outcome.result.latencyMs || undefined,
        error: error ? mask(nodeId, error) : undefined,
      };
    });

    return { results };
  });

  // Set favorite
  // Force an immediate geolocation re-check for one node — bypasses the IP
  // cache and the background scheduler's spacing. The response explains the
  // outcome (resolved / refused by anycast-edge guard / failed) so the UI can
  // show exactly why the location looks the way it does now.
  app.post('/api/v1/nodes/:id/geo-recheck', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');
    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const row = ctx.repos.publicNodes.get(id);
    if (!row) return replyApiError(reply, 404, 'not_found', `Node "${id}" not found`);
    const result = await recheckNodeGeo(ctx.repos.publicNodes, row, ctx.log);
    const fresh = nodesService.getNode(id);
    return { result, node: fresh };
  });

  app.post('/api/v1/nodes/:id/favorite', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const body = FavoriteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return replyValidationError(reply, 'validation_error', body.error);
    }

    try {
      nodesService.setFavorite(id, body.data.favorite, body.data.tags);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return replyApiError(reply, 404, 'not_found', message);
    }
  });

  // Set tags
  app.post('/api/v1/nodes/:id/tags', async (req, reply) => {
    if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const body = TagsSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return replyValidationError(reply, 'validation_error', body.error);
    }

    try {
      nodesService.setTags(id, body.data.tags);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return replyApiError(reply, 404, 'not_found', message);
    }
  });

  // Export nodes
  /**
   * Add configs the user supplied (a share link they found, or one copied out
   * of another client) straight into the node pool.
   *
   * Imported rows go through the same parser and dedup path as a fetched
   * source, and a manual node carries NO source attribution — it did not come
   * from a feed. The response separates imported / duplicates / invalid so the
   * UI can say what really happened.
   */
  app.post(
    '/api/v1/nodes/import',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!nodesService) throw new AppError(503, 'service_unavailable', 'Node service not configured in this environment');

      const parsed = z
        .object({ configs: z.array(z.string().min(4).max(4096)).min(1).max(200) })
        .safeParse(req.body);
      if (!parsed.success) throw parsed.error;

      const result = await nodesService.importManualConfigs(parsed.data.configs);

      reply.status(201);
      return result;
    },
  );

  /**
   * RETIRED — was `GET /api/v1/nodes/export`.
   *
   * Bulk export in six formats (uri/plaintext/base64/json/clash/sing-box). Up
   * to 1000 nodes per request, each rebuilt from the vault with its real
   * credential — so this was not a metadata export under a friendly name. It is
   * withdrawn for the same reason as `/nodes/:id/link`, and with it goes the
   * "Passwords, keys and UUIDs are never rendered here" claim that sat above
   * the UI panel calling it: that notice described an export that never existed.
   *
   * 410 Gone, deliberately — see `/nodes/:id/link` above.
   */
  app.get('/api/v1/nodes/export', async (_req, reply) =>
    replyApiError(reply, 410, 'node_export_retired', 'Configuration export is no longer served. No entitlement unlocks it; pick a node by location and ping instead.'),
  );

  // ================================================================
  // SOURCES
  // ================================================================

  // List all known sources
  app.get('/api/v1/sources', async () => {
    // DB is the single source of truth (built-ins are seeded at boot; custom
    // sources live here too). Falls back to constants if the DB is empty.
    //
    // `urls` is masked on the way out. A subscription URL is the configuration —
    // whoever holds it can fetch every node outside the app — so this response
    // carries only enough to recognise a source, on any plan. The full URLs are
    // still stored and still fetched with; they just do not cross to a client.
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
        urls: s.urls.map(maskSourceUrl),
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
    const raw = (req.params as { id: string }).id;
    const parsed = SourceIdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const row = ctx.repos.publicSources.get(id);
    const source = row ?? getKnownSources().find((s) => s.id === id);
    if (!source) return replyApiError(reply, 404, 'not_found', `Source "${id}" not found`);

    // Masked for the same reason as the list route. Nothing in the app reads a
    // source URL back over HTTP — the fetcher works from the DB row — so there
    // was never a reason for this endpoint to carry one.
    return { ...source, urls: source.urls.map(maskSourceUrl) };
  });

  // Toggle a source enabled/disabled (sources UI).
  app.patch('/api/v1/sources/:id', async (req, reply) => {
    const raw = (req.params as { id: string }).id;
    const parsed = SourceIdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {});
    if (!body.success) {
      return replyValidationError(reply, 'validation_error', body.error);
    }
    if (!ctx.repos.publicSources.get(id)) {
      return replyApiError(reply, 404, 'not_found', `Source "${id}" not found`);
    }
    ctx.repos.publicSources.update(id, { enabled: body.data.enabled });
    return { ok: true, id, enabled: body.data.enabled };
  });

  // Delete a custom source (sources UI).
  app.delete('/api/v1/sources/:id', async (req, reply) => {
    const raw = (req.params as { id: string }).id;
    const parsed = SourceIdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    if (!ctx.repos.publicSources.get(id)) {
      return replyApiError(reply, 404, 'not_found', `Source "${id}" not found`);
    }
    const removed = ctx.repos.publicSources.remove(id);
    return { ok: removed };
  });

  // Create custom source
  app.post('/api/v1/sources', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = SourceInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyValidationError(reply, 'validation_error', parsed.error);
    }

    const input = parsed.data;

    // Validate URLs
    for (const url of input.urls) {
      const validation = isValidSourceUrl(url);
      if (!validation.ok) {
        return replyApiError(reply, 400, 'invalid_url', validation.error ?? 'Invalid source URL', { hint: maskSourceUrl(url) });
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

    // The created source is echoed so the UI can show what was added — masked like
    // every other read of a source URL, so "no response body carries a raw
    // subscription URL" holds for the create path too, not just the reads.
    return reply.status(201).send({ ...source, urls: source.urls.map(maskSourceUrl) });
  });

  // Fetch source manually
  // Trigger a real fetch+parse+import of a source through the nodes service.
  app.post('/api/v1/sources/:id/fetch', async (req, reply) => {
    const raw = (req.params as { id: string }).id;
    const parsed = SourceIdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;

    if (!nodesService) return replyApiError(reply, 503, 'service_unavailable', 'Node service not configured in this environment');

    const source = ctx.repos.publicSources.get(id) ?? getKnownSources().find((s) => s.id === id);
    if (!source) return replyApiError(reply, 404, 'not_found', 'Source not found');

    try {
      const result = await nodesService.discoverFromSource(id);
      // The pipeline reports its own verdict. A feed that 404'd or yielded no
      // parseable configs must not be reported as a completed fetch just because
      // the HTTP request finished.
      if (result.status === 'failed') {
        const error = result.error ?? 'source fetch failed';
        ctx.bus.publish('sources', {
          type: 'source:fetch:failed',
          sourceId: id,
          sourceName: source.name,
          error,
        });
        return replyApiError(reply, 502, 'fetch_failed', error);
      }
      ctx.bus.publish('sources', {
        type: 'source:fetch:completed',
        sourceId: id,
        sourceName: source.name,
        imported: result.imported,
        duplicates: result.duplicates,
        invalid: result.invalid,
      });
      return { ...result };
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
      return replyApiError(reply, 502, 'fetch_failed', error);
    }
  });

  // ================================================================
  // SCANNER
  // ================================================================

  // Start scan job
  app.post('/api/v1/scanner/start', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = ScannerStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyValidationError(reply, 'validation_error', parsed.error);
    }

    if (!nodesService) return replyApiError(reply, 503, 'service_unavailable', 'Node service not configured in this environment');

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
      return replyApiError(reply, 400, 'no_targets', 'Provide nodeIds or a filter that matches at least one node.');
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
        // `deep-test` (proxy) is where batching matters: testNodes puts several
        // nodes in one core, so a scan does not pay a full start per node. The
        // other kinds are cheap socket probes and keep the worker pool. Both
        // honour cancellation and report progress per settled node.
        await nodesService.testNodes(targets, testType, {
          concurrency,
          shouldStop: () => cancelled,
          onResult: (outcome) => {
            tested++;
            const status = outcome.result?.status;
            if (status === 'done') {
              healthy++;
            } else if (outcome.error || status === 'error' || status === 'failed') {
              failed++;
            } else {
              degraded++;
            }
            if (tested % Math.max(1, Math.floor(total / 20)) === 0 || tested === total) publishProgress();
          },
        });

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
    const raw = (req.params as { jobId: string }).jobId;
    const parsed = JobIdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const jobId = parsed.data;
    const job = ctx.repos.scanJobs.get(jobId);

    if (!job) return replyApiError(reply, 404, 'not_found', `Scan job "${jobId}" not found`);
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
    const raw = (req.params as { jobId: string }).jobId;
    const parsed = JobIdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const jobId = parsed.data;
    const job = ctx.repos.scanJobs.get(jobId);

    if (!job) return replyApiError(reply, 404, 'not_found', `Scan job "${jobId}" not found`);

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
      return replyValidationError(reply, 'validation_error', parsed.error);
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
    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) return replyValidationError(reply, 'invalid_id', parsed.error);
    const id = parsed.data;
    const removed = ctx.repos.testEndpoints.remove(id);

    if (!removed) return replyApiError(reply, 404, 'not_found', `Test endpoint "${id}" not found`);
    return { success: true };
  });

  // ================================================================
  // NODE HISTORY / STATS
  // ================================================================

  // Get node test history
  app.get('/api/v1/nodes/:id/history', async (req) => {
    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'invalid_id', parsed.error.message);
    const id = parsed.data;
    const q = req.query as { limit?: string; since?: string };

    const limit = Math.min(Number(q.limit) || 100, 1000);
    const since = q.since ? Number(q.since) : Date.now() - 7 * 24 * 60 * 60 * 1000;

    const tests = ctx.repos.nodeTests.recentForNode(id, since);
    const limited = tests.slice(0, limit);
    // Stored probe rows carry the dialled address twice — as `probedIp` and as
    // the `testEndpoint` they were written with — and can quote it in `error`.
    // The row keeps all of it for the server's own bookkeeping; the response
    // gets masked errors and neither raw key — withheld, so they read as
    // absent rather than blank.
    const rawRow = ctx.repos.publicNodes.get(id) ?? null;
    const scrub = rawRow ? scrubberFromRows([rawRow]) : null;

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
        error: t.error != null && scrub && scrub.size > 0 ? scrub.mask(t.error) : t.error,
        family: t.family,
        engine: t.engine,
      })),
      total: tests.length,
    };
  });

  // Get node health stats
  app.get('/api/v1/nodes/:id/health', async (req) => {
    const raw = (req.params as { id: string }).id;
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'invalid_id', parsed.error.message);
    const id = parsed.data;
    const health = ctx.repos.nodeHealth.get(id);

    if (!health) {
      // No health row means no probe has ever run against this node, so the
      // rates are NOT zero — they were never measured. The latencies and
      // timestamps below already say `null`; reliability and loss must say the
      // same thing, because a client that reads `lossPct: 0` as "this node
      // drops nothing" is being told a node is perfect on the strength of a
      // probe that never happened. `testCount: 0` is a real measurement and
      // stays 0: "no probes recorded" is true.
      return {
        nodeId: id,
        testCount: 0,
        successCount: 0,
        failureCount: 0,
        reliabilityPct: null,
        medianLatencyMs: null,
        p95LatencyMs: null,
        lossPct: null,
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

  // Proxy-core engine availability (xray / sing-box / v2ray) with the
  // installed version of each. Availability is a cheap PATH check; versions
  // come from the engine manager's short-lived cache (each is a bounded
  // `<core> version` spawn). The UI shows which engine proxy tests will use.
  app.get('/api/v1/nodes/engines', async () => {
    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';
    const status = proxyEngineStatus(preferred);
    const versions = await installedEngineVersions();
    return {
      ...status,
      engines: status.engines.map((e) => ({ ...e, version: versions[e.id] ?? null })),
    };
  });

  // Latest OFFICIAL release per core (the engine manager page's "update
  // available" check). Cached server-side; each engine reports its own lookup
  // failure instead of a stale tag being shown as current.
  app.get('/api/v1/nodes/engines/releases', async (req) => {
    const q = req.query as { force?: string };
    return checkLatestReleases({ force: q.force === '1' || q.force === 'true' });
  });

  // Install or update a proxy core from its official release. The request
  // body is validated by schema; everything else (host allowlist, checksum,
  // binary self-check) is enforced inside the engine manager.
  app.post('/api/v1/nodes/engines/install', { config: { rateLimit: { max: 4, timeWindow: '5 minutes' } } }, async (req) => {
    const parsed = EngineInstallRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'invalid_request', 'engine install request failed validation');
    }
    return installEngine(parsed.data.engine, parsed.data.version);
  });

  app.get('/api/v1/nodes/stats', async () => {
    // Every number here is a COUNT over the stored rows, taken in SQL. The total
    // used to be the length of a capped list window, so a database with tens of
    // thousands of nodes reported "2000", and the breakdowns described only the
    // first thousand rows.
    const statusCounts = ctx.repos.publicNodes.statusCounts();
    const summary = ctx.repos.publicNodes.summary();

    return {
      total: summary.total,
      discovered: statusCounts.discovered,
      healthy: statusCounts.healthy,
      degraded: statusCounts.degraded,
      failed: statusCounts.failed,
      stale: statusCounts.stale,
      favoriteCount: summary.favoriteCount,
      protocolBreakdown: summary.protocolBreakdown,
      countryBreakdown: summary.countryBreakdown,
      transportBreakdown: summary.transportBreakdown,
    };
  });
}
