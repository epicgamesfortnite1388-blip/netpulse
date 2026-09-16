import { describe, expect, it } from 'vitest';

import { NodeDiscoveryService } from '../src/services/nodeDiscovery';

import type { DiscoveryCandidate, DiscoveryProbeResult } from '../src/services/nodeDiscovery';
import type { ScanDepth } from '@netpulse/shared';

/**
 * Discovery contract:
 *   - the profile's candidate limit is a hard cap; a caller may ask for fewer
 *   - the summary states the depth that was ACTUALLY validated, and never
 *     implies relay was proven when only a handshake ran
 *   - a probe that throws is classified as a failed candidate, not a crash
 *   - concurrency stays inside the profile's budget
 */

function pool(n: number): DiscoveryCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    name: `node ${i}`,
    host: `10.0.0.${i}`,
    port: 443,
    protocol: 'vless',
  }));
}

function svc(opts: {
  candidates: DiscoveryCandidate[];
  probe: (id: string, depth: ScanDepth, timeoutMs: number) => Promise<DiscoveryProbeResult>;
}) {
  const calls: Array<{ id: string; depth: ScanDepth; timeoutMs: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const service = new NodeDiscoveryService({
    pickCandidates: ({ limit }) => opts.candidates.slice(0, limit),
    probe: async (id, depth, timeoutMs) => {
      calls.push({ id, depth, timeoutMs });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await opts.probe(id, depth, timeoutMs);
      } finally {
        inFlight -= 1;
      }
    },
    log: { warn: () => {} },
  });
  return { service, calls, maxInFlight: () => maxInFlight };
}

const ok = (latencyMs: number | null = 40): DiscoveryProbeResult => ({ ok: true, latencyMs, failure: null });
const bad = (failure = 'connection refused'): DiscoveryProbeResult => ({ ok: false, latencyMs: null, failure });

describe('NodeDiscoveryService', () => {
  it('never probes more candidates than the profile allows', async () => {
    const { service, calls } = svc({ candidates: pool(60), probe: async () => ok() });
    const report = await service.run({ profile: 'stealth' });
    // stealth caps at 6, whatever the pool size
    expect(calls).toHaveLength(6);
    expect(report.probed).toBe(6);
  });

  it('lets a caller narrow the search but not widen it', async () => {
    const { service, calls } = svc({ candidates: pool(60), probe: async () => ok() });
    await service.run({ profile: 'stealth', limit: 2 });
    expect(calls).toHaveLength(2);

    const wide = svc({ candidates: pool(60), probe: async () => ok() });
    await wide.service.run({ profile: 'stealth', limit: 50 });
    expect(wide.calls).toHaveLength(6); // clamped back to the profile cap
  });

  it('probes at the profile depth and with the profile timeout', async () => {
    const turbo = svc({ candidates: pool(3), probe: async () => ok() });
    await turbo.service.run({ profile: 'turbo' });
    expect(turbo.calls.every((c) => c.depth === 'tcp')).toBe(true);

    const iron = svc({ candidates: pool(3), probe: async () => ok() });
    await iron.service.run({ profile: 'ironclad' });
    expect(iron.calls.every((c) => c.depth === 'proxy')).toBe(true);
    expect(iron.calls[0]!.timeoutMs).toBe(8_000);
  });

  it('keeps concurrency within the profile budget', async () => {
    const { service, maxInFlight } = svc({
      candidates: pool(12),
      probe: async () => { await new Promise((r) => setTimeout(r, 5)); return ok(); },
    });
    await service.run({ profile: 'stealth' }); // concurrency 2
    expect(maxInFlight()).toBeLessThanOrEqual(2);

    const turbo = svc({
      candidates: pool(20),
      probe: async () => { await new Promise((r) => setTimeout(r, 5)); return ok(); },
    });
    await turbo.service.run({ profile: 'turbo' });
    expect(turbo.maxInFlight()).toBeLessThanOrEqual(12);
  });

  it('says what was proven — no relay claim from a TCP-only profile', async () => {
    const { service } = svc({ candidates: pool(4), probe: async () => ok(12) });
    const turbo = await service.run({ profile: 'turbo' });
    expect(turbo.summary).toContain('answered a TCP handshake');
    expect(turbo.summary).toContain('does not prove the node relays');
    expect(turbo.winner?.carrying).toBe(false);
  });

  it('marks carrying=true only when a real proxied request ran', async () => {
    const { service } = svc({ candidates: pool(2), probe: async () => ok(30) });
    const iron = await service.run({ profile: 'ironclad' });
    expect(iron.summary).toContain('carried a real proxied request');
    expect(iron.summary).not.toContain('does not prove');
    expect(iron.winner?.carrying).toBe(true);
  });

  it('classifies a throwing probe as a failed candidate and finishes the run', async () => {
    const { service } = svc({
      candidates: pool(3),
      probe: async (id) => {
        if (id === 'n1') throw new Error('socket exploded');
        return ok();
      },
    });
    const report = await service.run({ profile: 'balanced' });
    expect(report.probed).toBe(3);
    const failed = report.outcomes.find((o) => o.nodeId === 'n1')!;
    expect(failed.failure).toBe('socket exploded');
    expect(failed.latencyMs).toBeNull();
    expect(report.passed).toBe(2);
  });

  it('picks the lowest-latency passing candidate', async () => {
    const { service } = svc({
      candidates: pool(4),
      probe: async (id) => {
        if (id === 'n0') return bad();
        return ok(id === 'n3' ? 5 : 50);
      },
    });
    const report = await service.run({ profile: 'balanced' });
    expect(report.winner?.nodeId).toBe('n3');
    expect(report.passed).toBe(3);
  });

  it('reports the deepest that passed, and sorts an unmeasured pass last', async () => {
    const { service } = svc({
      candidates: pool(2),
      probe: async (id) => (id === 'n0' ? ok(null) : ok(20)),
    });
    const report = await service.run({ profile: 'balanced' });
    expect(report.winner?.nodeId).toBe('n1');
  });

  it('explains an empty pool instead of reporting a silent success', async () => {
    const { service } = svc({ candidates: [], probe: async () => ok() });
    const report = await service.run({ profile: 'balanced' });
    expect(report.probed).toBe(0);
    expect(report.winner).toBeNull();
    expect(report.summary).toContain('No candidates matched');
  });

  it('says nothing passed when every candidate failed', async () => {
    const { service } = svc({ candidates: pool(3), probe: async () => bad() });
    const report = await service.run({ profile: 'thorough' });
    expect(report.passed).toBe(0);
    expect(report.winner).toBeNull();
    expect(report.summary).toContain('No node passed');
  });
});