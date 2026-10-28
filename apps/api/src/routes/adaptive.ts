import { z } from 'zod';

import { describeContextBucket } from '@netpulse/shared';

import { toParsedConfig } from '../services/proxyTunnel';

import type { ProxyEngineId, ScanProfileId } from '@netpulse/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

/**
 * Adaptive intelligence API.
 *
 * Three things this surface is for, and one it deliberately is not:
 *
 *  - `GET /status`  what has been learned, and why each core is or is not usable
 *                   on this machine for a given node (the compatibility answer
 *                   comes from the same predicate the tunnel dials with).
 *  - `GET /plan`    a dry run: what the engine would choose for one node right
 *                   now, with the reason for every position in the order. This
 *                   is the diagnostic that makes the learning explainable.
 *  - `POST /reset`  delete everything learned, locally. No confirmation loop,
 *                   no server round trip beyond this process.
 *  - `policy/*`     install/roll back a SIGNED policy update. Unsigned or
 *                   unsigned-by-an-unknown-key input is refused with a reason.
 *
 * What it is not: a way to add a core, a node, a hostname or a credential. The
 * engine can only reorder what the machine already has and already supports.
 */

const NodeQuery = z.object({ nodeId: z.string().trim().min(1).max(64).optional() });

const InstallSchema = z.object({
  /** the signed envelope, verbatim — verified before anything is read from it */
  manifest: z.unknown(),
  channel: z.enum(['production', 'test']).optional(),
});

export function registerAdaptiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Resolve a node's real configuration, or null (the engine then has nothing to rank). */
  const configFor = (nodeId: string | undefined) => {
    if (!nodeId) return null;
    const node = ctx.repos.publicNodes.get(nodeId);
    return node ? toParsedConfig(node) : null;
  };

  app.get('/api/v1/adaptive/status', async (req) => {
    const parsed = NodeQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw parsed.error;
    const config = configFor(parsed.data.nodeId);
    const status = ctx.services.adaptive.status(undefined, config ?? undefined);
    return {
      ...status,
      // Answers "can this machine even verify an update", without disclosing the key.
      trustAnchor: {
        configured: Boolean(ctx.config.adaptivePolicyKeyId && ctx.config.adaptivePolicyPublicKey),
        keyId: ctx.config.adaptivePolicyKeyId ?? null,
      },
      /** What the engine is allowed to change, stated for the UI verbatim. */
      scope: {
        dnsThroughTunnel: ctx.services.settings.get().vpn?.dnsThroughVpn !== false,
        canChange: 'which installed, compatible core is tried first for the next attempt',
        cannotChange: 'nodes, servers, credentials, subscription, transports, or the leak-protection settings',
      },
      nodeId: parsed.data.nodeId ?? null,
    };
  });

  /**
   * Dry-run ordering for one node. Nothing is dialled; this is what the next
   * connection attempt would try first, and why.
   */
  app.get('/api/v1/adaptive/plan', async (req, reply) => {
    const parsed = NodeQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw parsed.error;
    const nodeId = parsed.data.nodeId;
    if (!nodeId) return reply.status(400).send({ error: 'invalid_request', message: 'nodeId is required' });
    const config = configFor(nodeId);
    if (!config) return reply.status(404).send({ error: 'not_found', message: 'no such node' });

    const settings = ctx.services.settings.get();
    const preferred = settings.proxyEngine?.preferred ?? 'auto';
    const baselineOrder: ProxyEngineId[] =
      preferred === 'auto'
        ? ['xray', 'hysteria', 'sing-box', 'v2ray']
        : [preferred, ...(['xray', 'hysteria', 'sing-box', 'v2ray'] as ProxyEngineId[]).filter((e) => e !== preferred)];

    const plan = ctx.services.adaptive.plan({
      config,
      baselineOrder,
      profile: (settings.vpn?.scanProfile ?? 'balanced') as ScanProfileId,
      attemptBudget: 2,
    });
    return {
      ...plan,
      nodeId,
      /** The adaptive order and the no-learning order, side by side. */
      baselineOrder,
      changedFromBaseline: plan.order.length > 0 && plan.order.join('>') !== baselineOrder.join('>'),
      contextExplanation: describeContextBucket(plan.context),
    };
  });

  /** Delete local learning data. The action the privacy section promises. */
  app.post('/api/v1/adaptive/reset', async () => {
    const before = ctx.services.adaptive.status();
    const state = ctx.services.adaptive.reset();
    return {
      ok: true,
      clearedAt: state.resetAt,
      removedObservations: before.observationsKept,
      removedRows: before.entries.length,
      message: 'Local connection learning was cleared. The engine now uses the default engine order until it observes new outcomes.',
    };
  });

  /** What the installed policy update is, if any. */
  app.get('/api/v1/adaptive/policy', async () => {
    const status = ctx.services.adaptive.status();
    return {
      installed: status.manifest.installed,
      previousVersion: status.manifest.previousVersion,
      keyId: status.manifest.keyId,
      trustAnchorConfigured: Boolean(ctx.config.adaptivePolicyKeyId && ctx.config.adaptivePolicyPublicKey),
    };
  });

  /**
   * Install a signed policy update. Signature, key id, expiry, channel,
   * compatibility and version are all checked BEFORE anything is read from the
   * payload; a refusal returns the code so the caller can say why.
   */
  app.post(
    '/api/v1/adaptive/policy',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = InstallSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const result = ctx.services.adaptive.installManifest(parsed.data.manifest, {
        acceptChannels: parsed.data.channel ? [parsed.data.channel] : ['production'],
      });
      if (!result.ok) return reply.status(400).send({ ok: false, code: result.code, reason: result.reason });
      return { ok: true, code: result.code, reason: result.reason, applied: result.applied };
    },
  );

  /** Restore the previously installed policy update. */
  app.post('/api/v1/adaptive/policy/rollback', async () => {
    const result = ctx.services.adaptive.rollbackManifest();
    if (!result.ok) return { ok: false, reason: result.reason, applied: result.applied };
    return { ok: true, reason: result.reason, applied: result.applied };
  });
}
