import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

/**
 * The discovery agent's permission surface.
 *
 * This route exists so the answer to "what can it do to my machine?" is a
 * response the user can read, instead of a paragraph in a report. It deliberately
 * exposes capability and budget, and nothing that would let a caller widen them:
 *
 *  - `GET /permissions`  the full catalogue with current grants, usage and the
 *                        last decisions (including denials), plus the exact list
 *                        of enforcement points.
 *  - `POST /autonomy`    pause or resume UNATTENDED work. Manual actions keep
 *                        working, because a pause is not a lockout.
 *
 * There is no endpoint to grant a forbidden capability, raise a budget above the
 * schema maximum, or add a capability. Those are code, not configuration.
 */

const AutonomySchema = z.object({
  paused: z.boolean(),
});

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/agent/permissions', async () => {
    const settings = ctx.services.settings.get();
    const snapshot = ctx.services.agent.snapshot();
    // What the model has learned, and whether its probabilities are any good.
    // A count of successes proves nothing about calibration, so the Brier score
    // and its skill over a 0.5 baseline are reported next to it — or reported as
    // absent when no attempt has carried a prediction yet.
    let training: {
      observationsKept: number;
      calibration: { samples: number; brier: number; baselineBrier: number; skill: number; meanPredicted: number; observedRate: number } | null;
      note: string;
    };
    try {
      const status = ctx.services.adaptive.status();
      training = {
        observationsKept: status.observationsKept,
        calibration: status.calibration,
        note: status.calibration
          ? `Brier ${status.calibration.brier} over ${status.calibration.samples} scored attempt(s); a 0.5 baseline scores ${status.calibration.baselineBrier}.`
          : 'No attempt has carried a prediction yet, so calibration is unmeasured rather than good.',
      };
    } catch (err) {
      training = {
        observationsKept: 0,
        calibration: null,
        note: `Adaptive state could not be read (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    return {
      ...snapshot,
      training,
      /** Where the gate is actually wired, so this is auditable rather than claimed. */
      enforcement: [
        {
          action: 'scheduled TCP probe batch',
          capability: 'network:probe-endpoint',
          where: 'services/nodeTestScheduler.ts',
          onDenial: 'the batch is skipped, the reason is logged, and no endpoint is dialled',
        },
        {
          action: 'scheduled feed refresh',
          capability: 'network:fetch-source',
          where: 'app.ts (SourceRefreshScheduler callback)',
          onDenial: 'the refresh is skipped and logged; the source keeps its last data',
        },
        {
          action: 'Smart Connect verification',
          capability: 'network:verify-traffic',
          where: 'routes/vpn.ts',
          onDenial: 'HTTP 429 with the allowance that is left, before any candidate is dialled',
        },
      ],
      limits: {
        fetchPerHour: settings.automation?.agent?.fetchPerHour ?? null,
        probesPerHour: settings.automation?.agent?.probesPerHour ?? null,
        verifyPerHour: settings.automation?.agent?.verifyPerHour ?? null,
      },
      /**
       * The part a user most needs to be able to check. Each line is backed by the
       * capability list above, and by the absence of a code path for `exec:shell`,
       * `exec:elevated`, `read:credential`, `write:settings` and `install:core`.
       */
      cannot: [
        'run a shell command or any other program',
        'elevate privileges or approve its own elevation',
        'read configuration secrets, subscription tokens or the node vault',
        'change settings, including these limits',
        'install or replace an engine binary',
        'connect to a third-party node without an explicit user action',
        'probe anything that is not already a stored node from a registered public source',
      ],
    };
  });

  app.post('/api/v1/agent/autonomy', async (req) => {
    const parsed = AutonomySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw parsed.error;
    ctx.services.settings.update({ automation: { agent: { paused: parsed.data.paused } } });
    ctx.services.events.record(
      'info',
      'vpn',
      parsed.data.paused
        ? 'Unattended discovery paused by the user'
        : 'Unattended discovery resumed by the user',
    );
    return { ok: true, ...ctx.services.agent.snapshot() };
  });
}
