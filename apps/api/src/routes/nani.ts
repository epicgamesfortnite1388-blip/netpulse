/**
 * NANI API routes — exposes the adaptive network intelligence engine over REST.
 *
 * Endpoints:
 *   GET    /api/v1/nani/apis              list registered APIs + health
 *   GET    /api/v1/nani/health/shadow     buffered shadow health vs live health
 *   POST   /api/v1/nani/apis              register an API provider
 *   POST   /api/v1/nani/check             run a layered health check for one API
 *   POST   /api/v1/nani/diagnose          run Bayesian diagnosis for a target
 *   POST   /api/v1/nani/recovery/plan     plan recovery for an API
 *   POST   /api/v1/nani/recovery/step     record a recovery step outcome
 *   GET    /api/v1/nani/recovery/next     get the next runnable recovery step
 *   POST   /api/v1/nani/recovery/reset    reset learned data for an API
 *   POST   /api/v1/nani/recovery/rollback revert the plan to the last verified route
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
  healthCheck: z.enum(['http-get', 'http-post', 'tcp-only', 'tls-only', 'custom']).default('http-get'),
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
  cause: z.enum(['dns', 'gateway', 'routing', 'ipv4', 'ipv6', 'tcp', 'tls', 'udp', 'mtu', 'congestion', 'filtering', 'upstream-proxy', 'remote-endpoint', 'api-auth', 'api-rate-limit', 'application', 'server', 'unknown', 'unspecified']).optional(),
});

const NextStepQuery = z.object({ apiId: z.string().trim().min(1), now: z.coerce.number().optional() });

export function registerNaniRoutes(app: FastifyInstance, ctx: AppContext): void {
  const nani = ctx.services.nani;

  // Compact status for the cockpit/reports pages. `lastDiagnosis` is null
  // until a diagnosis has actually run; the UI must not be shown a fabricated
  // health percentage or cause.
  app.get('/api/v1/nani/status', async () => {
    const apis = nani.listApis();
    return {
      enabled: true,
      intelligenceLevel: apis.length > 0 ? 'active' : 'idle',
      lastDiagnosis: null,
    };
  });

  app.get('/api/v1/nani/apis', async () => {
    return { apis: nani.listApis(), count: nani.listApis().length };
  });

  // Read-only comparison for the UI. Serves the last advisory shadow pass from
  // memory; it never probes, writes registry health, or publishes events.
  // `ageMs` makes stale shadow comparisons visible without mutating anything.
  app.get('/api/v1/nani/health/shadow', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const now = Date.now();
    const live = nani.listApis();
    const assessments = nani.shadowSnapshot().map((assessment) => {
      const current = live.find((entry) => entry.entry.id === assessment.apiId);
      return {
        apiId: assessment.apiId,
        at: assessment.at,
        ageMs: Math.max(0, now - assessment.at),
        shadow: assessment.classification,
        live: current
          ? {
              health: current.health,
              failures: current.failures,
              successes: current.successes,
            }
          : null,
      };
    });
    return { assessments, count: assessments.length };
  });

  app.post('/api/v1/nani/apis', async (req, reply) => {
    const parsed = RegisterApiBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      nani.registerApi(parsed.data);
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
      const result = nani.diagnoseTarget(parsed.data.target, parsed.data.observations);
      return { ok: true, ...result };
    } catch (err) {
      return replyApiError(reply, 500, 'diagnose_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/v1/nani/recovery/plan', async (req, reply) => {
    const parsed = PlanRecoveryBody.safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = nani.planRecovery(parsed.data.apiId, parsed.data.routes, parsed.data.knownGoodRouteId ?? null);
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
      });
      return { ok: true, ...result };
    } catch (err) {
      return replyApiError(reply, 500, 'step_failed', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/v1/nani/recovery/next', async (req, reply) => {
    const parsed = NextStepQuery.safeParse(req.query);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      // knownGoodRouteId travels with every step poll: the UI needs it to offer
      // the rollback action and to plan the rollback step. Destructuring it away
      // here silently disabled both.
      const { step, snapshot, knownGoodRouteId } = nani.nextRecoveryStep(
        parsed.data.apiId,
        parsed.data.now ?? Date.now(),
      );
      return { ok: true, step, snapshot, knownGoodRouteId };
    } catch (err) {
      return replyApiError(reply, 500, 'next_step_failed', err instanceof Error ? err.message : String(err));
    }
  });

  // Roll back to the last route this engine verified. A state change, so it is
  // an explicit operator request; the service refuses when no route has been
  // verified rather than inventing a target.
  app.post('/api/v1/nani/recovery/rollback', async (req, reply) => {
    const parsed = z.object({ apiId: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = nani.rollbackToKnownGood(parsed.data.apiId);
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('unknown api')) {
        return replyApiError(reply, 404, 'unknown_api', message);
      }
      if (message.startsWith('no known-good route')) {
        return replyApiError(reply, 409, 'no_known_good_route', message, {
          hint: 'Verify a route first: a route recorded as a verified success becomes the rollback target.',
        });
      }
      return replyApiError(reply, 500, 'rollback_failed', message);
    }
  });

  app.post('/api/v1/nani/recovery/reset', async (req, reply) => {
    const parsed = z.object({ apiId: z.string() }).safeParse(req.body);
    if (!parsed.success) return replyApiError(reply, 400, 'invalid_request', parsed.error.message);
    try {
      const result = nani.resetRecovery(parsed.data.apiId);
      return {
        ok: true,
        ...result,
        message: result.cleared
          ? `cleared recovery ${result.previousRecoveryId}`
          : 'no active recovery state to clear',
      };
    } catch (err) {
      return replyApiError(reply, 500, 'reset_failed', err instanceof Error ? err.message : String(err));
    }
  });
}

