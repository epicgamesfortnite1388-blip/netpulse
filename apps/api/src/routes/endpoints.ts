import net from 'node:net';

import { z } from 'zod';

import { badRequest } from '../util/appError';
import * as targetGuard from '../util/targetGuard';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const TargetSchema = z.string().trim().min(1).max(253);

const EndpointTestSchema = z.object({
  target: TargetSchema,
  port: z.number().int().min(1).max(65535).optional(),
  sni: z.string().trim().max(253).optional(),
  timeoutMs: z.number().int().min(300).max(10_000).optional(),
  icmp: z.boolean().optional(),
});

const ScanSchema = z.object({
  cidrs: z.array(z.string().trim().min(1).max(60)).min(1).max(16),
  ports: z.array(z.number().int().min(1).max(65535)).min(1).max(4),
  concurrency: z.number().int().min(1).max(256).default(64),
  timeoutMs: z.number().int().min(300).max(5_000).default(1_200),
  maxCandidates: z.number().int().min(16).max(2048).default(512),
});

/**
 * SSRF bound for the scanner: users may scan their own infrastructure and
 * the documented Cloudflare endpoint ranges, but never private/loopback/
 * link-local space (which would also be unreachable from a remote host
 * anyway — this closes the metadata-service probing window, e.g. 169.254.169.254).
 */
function assertScannableCidrs(cidrs: string[]): void {
  for (const cidr of cidrs) {
    const base = cidr.split('/')[0]?.trim() ?? '';
    if (net.isIP(base) === 0) continue; // hostname targets resolve through resolveTarget in the service
    const { isPrivateIp } = targetGuard;
    if (isPrivateIp(base)) {
      throw badRequest('private_target_not_allowed', `"${cidr}" is a private or reserved range and cannot be scanned`);
    }
  }
}

const ListQuerySchema = z.object({
  scanId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const ValidateSchema = z.object({
  candidateIds: z.array(z.number().int().positive()).max(50).optional(),
  tries: z.number().int().min(2).max(5).optional(),
  downloadBytes: z.number().int().min(1_000_000).max(50_000_000).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
});

export function registerEndpointRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/endpoint-test', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const parsed = EndpointTestSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    return ctx.services.endpoint.testEndpoint(parsed.data);
  });

  app.post('/api/v1/cloudflare/scan', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) => {
    const parsed = ScanSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    assertScannableCidrs(parsed.data.cidrs);
    return ctx.services.endpoint.startScan(parsed.data);
  });

  app.get('/api/v1/cloudflare/scans', async (req) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) throw parsed.error;
    return { scans: ctx.services.endpoint.listScans().slice(0, parsed.data.limit) };
  });

  app.get('/api/v1/cloudflare/scans/:id', async (req) => {
    const { id } = req.params as { id: string };
    const detail = ctx.services.endpoint.scanDetail(id);
    if (!detail.scan) throw Object.assign(new Error(`Scan "${id}" not found`), { statusCode: 404, code: 'not_found' });
    return detail;
  });

  app.post('/api/v1/cloudflare/scans/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    ctx.services.endpoint.cancelScan(id);
    return { ok: true, scanId: id };
  });

  // SenPaiScanner-style post-stop validation: multi-try latency + stability
  // hold + a real download through each shortlist edge.
  app.post('/api/v1/cloudflare/scans/:id/validate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ValidateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw parsed.error;
    return ctx.services.endpoint.validateScan(id, parsed.data);
  });

  app.post('/api/v1/cloudflare/scans/:id/validate/cancel', async (req) => {
    const { id } = req.params as { id: string };
    ctx.services.endpoint.cancelValidation(id);
    return { ok: true, scanId: id };
  });

  app.get('/api/v1/cloudflare/edge', async () => ctx.services.endpoint.localEdge());

  app.post('/api/v1/cloudflare/candidates/:id/favorite', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { favorite?: boolean };
    ctx.services.endpoint.setFavorite(Number(id), body.favorite !== false);
    return { ok: true };
  });
}
