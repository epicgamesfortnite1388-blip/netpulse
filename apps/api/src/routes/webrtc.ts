import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

/**
 * WebRTC leak test — browser side.
 *
 * The backend DNS leak test can only see the configured system resolvers.
 * WebRTC leaks are a browser-level phenomenon (RTCPeerConnection ICE
 * candidates), so they can only be observed inside the browser itself. The
 * page collects candidates via a real RTCPeerConnection with STUN, sends the
 * IPs here, and we compare them against the public addresses measured by the
 * IP intelligence service. Nothing is claimed beyond what was actually
 * observed on both sides.
 */
const WebrtcReportSchema = z.object({
  candidates: z.array(z.string()).max(100).default([]),
});

export function registerWebrtcRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/webrtc-report',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = WebrtcReportSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;

      const testId = crypto.randomUUID();
      const candidates = parsed.data.candidates
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      ctx.repos.tests.create(testId, 'webrtc', { candidates });

      // Public addresses as measured by the IP intelligence service — these
      // are what the browser should be using when no leak is present.
      const [publicV4, publicV6] = await Promise.all([
        ctx.services.ipInfo.lookup(4).catch(() => null),
        ctx.services.ipInfo.lookup(6).catch(() => null),
      ]);
      const publicIps = new Set<string>();
      if (publicV4?.ip) publicIps.add(publicV4.ip);
      if (publicV6?.ip) publicIps.add(publicV6.ip);

      // mDNS obfuscated candidates (e.g. *.local) and port-only strings are
      // not evidence of anything — they are how browsers mask local IPs.
      const leaked = candidates.filter((ip) => {
        if (ip.includes('.')) {
          // hostname-style candidates: *.local means mDNS masking
          if (ip.toLowerCase().endsWith('.local')) return false;
        }
        return !publicIps.has(ip);
      });

      const result = {
        testId,
        checkedAt: Date.now(),
        candidateCount: candidates.length,
        publicIps: [...publicIps],
        leaked,
        leakedCount: leaked.length,
        status: leaked.length === 0 ? 'no-leak' : 'leak',
        note:
          candidates.length === 0
            ? 'No ICE candidates were produced — the browser may have blocked STUN, or this network has no NAT traversal candidates to expose.'
            : publicIps.size === 0
              ? 'Public IP lookup failed, so the candidates could not be compared.'
              : 'Candidates observed in this browser were compared against the public addresses measured by the IP intelligence service.',
      };

      ctx.repos.tests.finish(testId, {
        status: 'done',
        summary: {
          status: result.status,
          candidateCount: candidates.length,
          leakedCount: leaked.length,
          leaked,
          publicIps: [...publicIps],
        },
        result,
      });

      ctx.services.events.record(
        result.status === 'leak' ? 'warn' : 'info',
        'network',
        result.status === 'leak'
          ? `WebRTC leak check: ${leaked.length} candidate address(es) not matching public IPs`
          : `WebRTC leak check: no mismatch (${candidates.length} candidate(s) observed)`,
        { testId },
      );

      reply.status(201);
      return { result };
    },
  );
}
