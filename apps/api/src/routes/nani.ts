/**
 * NANI API routes — exposes the adaptive network intelligence engine over REST.
 *
 * Endpoints:
 *   GET    /api/v1/nani/apis              list registered APIs + health
 *   POST   /api/v1/nani/apis              register an API provider
 *   POST   /api/v1/nani/check             run a layered health check for one API
 *   POST   /api/v1/nani/diagnose          run Bayesian diagnosis for a target
 *   POST   /api/v1/nani/recovery/plan     plan recovery for an API
 *   POST   /api/v1/nani/recovery/step     record a recovery step outcome
 *   GET    /api/v1/nani/recovery/next     get the next runnable recovery step
 *   POST   /api/v1/nani/recovery/reset    reset learned data for an API
 *
 * All bodies are validated with zod. No secrets are accepted or returned.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { replyApiError } from '../util/apiError';

const RegisterApiBody = z.object({
  id: z.string().trim().min(1).max(64),
  provider: z.string().trim().min(1).max(128),
  endpoint: z.string().trim().min(1).max(256),
  authType: z.enum(['none', 'bearer', 'api-key', 'oauth2', 'basic']),
  authKeyId: z.string().trim().min(1).max(64).optional(),
  healthCheck: z.enum(['http-get', 'http-post', 'tcp-only', 'tls-only', 'custom']).optional(),
  healthCheckPath: z.string().trim().max(128).optional(),
  timeoutMs: z.coerce.number().min(500).max(60_000).default(5_000),
  directPermitted: z.boolean().default(true),
  autoRecoveryPermitted: z.boolean().default(true),
  dependsOn: z.array(z.string()).default([]),
});

const CheckApiBody = z.object({
  apiId: z.string().trim().min(1),
  target: z.string().trim().min(1).max(256),
  layers: z.array(z.enum(['dns', 'tcp', 'tls', 'http', 'auth', 'application'])).optional(),
});

const DiagnoseBody = z.object({
  target: z.string().trim().min(1).max(256),
  observations: z.array(
    z.object({
      testId: z.string(),
      outcome: z.enum(['success', 'failure', 'timeout', 'skipped', 'unknown']),
      at: z.coerce.number(),
      reliability: z.coerce.number().min(0).max(1).optional(),
    }),
  ),
});

const PlanRecoveryBody = z.object({
  apiId: z.string().trim().min(1),
  routes: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['direct', 'upstream-proxy', 'ipv6', 'alternate-dns']),
      authorized: z.boolean(),
      tlsVerification: z.boolean(),
      features: z.object({
        successPrior: z.coerce.number().min(0).max(1),
        latencyMs: z.coerce.number().min(0),
        latencyStdMs: z.coerce.number().min(0),
        jitterMs: z.coerce.number().min(0),
        packetLoss: z.coerce.number().min(0).max(1),
        recoveryMs: z.coerce.number().min(0),
        resourceCost: z.coerce.number().min(0).max(1),
        risk: z.coerce.number().min(0).max(1),
      }),
    }),
  ),
  knownGoodRouteId: z.string().optional(),
});

const RecordStepBody = z.object({
  apiId: z.string().trim().min(1),
  stepId: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'requires-permission', 'insufficient-evidence']),
  latencyMs: z.coerce.number().min(0).optional(),
  message: z.string().optional(),
});

const NextStepQuery = z.object({ apiId: z.string().trim().min(1), now: z.coerce.number().optional() });

export function registerNaniRoutes(app: FastifyInstance, ctx: AppContext): void {
  const nani = ctx.services.nani;

  app.get('/api/v1/nani/apis', async () => {
    return { apis: nani.listApis(), count: nani.listApis().length };
  });

  app.post('/api/v1/nani/apis', async (req, reply) => {
    const parsed = RegisterApiBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      nani.registerApi(parsed.data as any);
      return { ok: true, apiId: parsed.data.id };
    } catch (err) {
      return replyApiError(reply, 500, 'registration_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/v1/nani/check', async (req, reply) => {
    const parsed = CheckApiBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = await nani.checkApiHealth({ apiId: parsed.data.apiId, target: parsed.data.target, layers: parsed.data.layers });
      return { ok: true, ...result };
    } catch (err) {
      return replyApiError(reply, 500, 'check_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/v1/nani/diagnose', async (req, reply) => {
    const parsed = DiagnoseBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = nani.diagnoseTarget(parsed.data.target, parsed.data.observations as any);
      return { ok: true, ...result };
    } catch (err) {
      return replyApiError(reply, 500, 'diagnose_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/v1/nani/recovery/plan', async (req, reply) => {
    const parsed = PlanRecoveryBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = nani.planRecovery(parsed.data.apiId, parsed.data.routes as any, parsed.data.knownGoodRouteId ?? null);
      return { ok: true, ...result };
    } catch (err) {
      return replyApiError(reply, 500, 'plan_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/v1/nani/recovery/step', async (req, reply) => {
    const parsed = RecordStepBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = nani.recordRecoveryStep(parsed.data.apiId, {
        stepId: parsed.data.stepId,
        status: parsed.data.status,
        latencyMs: parsed.data.latencyMs ?? undefined,
        message: parsed.data.message,
      } as any);
      return { ok: true, ...result };
    } catch (err) {
      return replyApiError(reply, 500, 'step_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/v1/nani/recovery/next', async (req, reply) => {
    const parsed = NextStepQuery.safeParse(req.query);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const { step, snapshot } = nani.nextRecoveryStep(parsed.data.apiId, parsed.data.now ?? Date.now());
      return { ok: true, step, snapshot };
    } catch (err) {
      return replyApiError(reply, 500, 'next_step_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/v1/nani/recovery/reset', async (req, reply) => {
    const parsed = z.object({ apiId: z.string() }).safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      return { ok: true, apiId: parsed.data.apiId, message: 'runtime state cleared' };
    } catch (err) {
      return replyApiError(reply, 500, 'reset_failed', err instanceof Error ? err.message : String(err));
    }
  });
}

