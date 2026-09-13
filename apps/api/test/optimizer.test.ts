import { describe, expect, it } from 'vitest';

import { DEFAULT_WEIGHTS } from '@netpulse/shared';

import { RealtimeBus } from '../src/realtime/bus';
import { OptimizerService } from '../src/services/optimizerService';

import type { IcmpPingOptions, PlatformNetworkController } from '../src/providers/platform/types';
import type { OptimizationRunResult, OptimizationCandidateResult } from '../src/services/optimizerService';
import type { PingResult, TcpProbeResult } from '@netpulse/shared';
import type { WsMessage } from '../src/realtime/bus';

/* Real entry point under test: POST /api/v1/optimizer/run → OptimizerService.run().
 * The UI renders the final payload from EITHER the WS `test:done` message or the
 * persisted test record (poll fallback) — both must carry the same complete
 * OptimizationRunResult, including `weights`. */

type FinishCall = { id: string; patch: { status: string; summary?: Record<string, unknown>; result?: unknown; error?: string } };

function makeController(latencyMs: number, failAll = false): PlatformNetworkController {
  return {
    id: 'fake-optimizer',
    async icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult> {
      if (failAll) throw new Error('network down');
      const lats = Array.from({ length: opts.count }, (_, i) => latencyMs + (i % 2));
      return {
        method: 'icmp',
        target: ip,
        resolvedIp: ip,
        family: opts.family ?? 4,
        samples: lats.map((ms, i) => ({ seq: i + 1, ok: true, ms })),
        sent: opts.count,
        received: opts.count,
        lossPct: 0,
        min: Math.min(...lats),
        avg: lats.reduce((a, b) => a + b, 0) / lats.length,
        max: Math.max(...lats),
        median: latencyMs,
        jitterMs: 1,
        durationMs: 5,
        parseQuality: 'full',
      };
    },
    async tcpProbe(): Promise<TcpProbeResult> {
      if (failAll) throw new Error('network down');
      return { ok: true, ms: latencyMs };
    },
    async systemDnsServers() {
      return ['1.1.1.1'];
    },
    async mtuProbe() {
      throw new Error('not needed');
    },
    async detectVpnBinaries() {
      return { wireguard: false, openvpn: false, singbox: false };
    },
  } as PlatformNetworkController;
}

interface Harness {
  svc: OptimizerService;
  bus: RealtimeBus;
  messages: WsMessage[];
  finishes: FinishCall[];
  created: number;
}

function makeHarness(opts: { failAll?: boolean; eventsThrow?: boolean } = {}): Harness {
  const bus = new RealtimeBus();
  const messages: WsMessage[] = [];
  const finishes: FinishCall[] = [];
  let created = 0;
  const svc = new OptimizerService({
    controller: makeController(12, opts.failAll),
    tests: {
      create: () => {
        created += 1;
      },
      finish: (id: string, patch: FinishCall['patch']) => {
        finishes.push({ id, patch });
      },
    } as never,
    events: {
      record: () => {
        if (opts.eventsThrow) throw new Error('events db is broken');
      },
    } as never,
    settings: {
      get: () => ({
        optimization: { weights: DEFAULT_WEIGHTS, preferredRegions: [], preferredProtocols: [] },
      }),
    } as never,
    bus,
    log: { info() {}, warn() {}, error() {} } as never,
  });
  return { svc, bus, messages, finishes, get created() { return created; } };
}

const TWO = [
  { id: 'a', name: 'Fast', host: '1.1.1.1', port: 443 },
  { id: 'b', name: 'Slow', host: '8.8.8.8', port: 443 },
];

describe('OptimizerService (route: POST /optimizer/run)', () => {
  it('delivers the complete payload — including weights — on the WS test:done path', async () => {
    const h = makeHarness();
    h.bus.subscribe('t-ws', (m) => h.messages.push(m));
    await h.svc.run({ candidates: TWO }, 't-ws');

    const done = h.messages.find((m) => m.type === 'test:done') as { result: OptimizationRunResult } | undefined;
    expect(done).toBeTruthy();
    expect(done!.result.weights).toEqual(DEFAULT_WEIGHTS);
    expect(done!.result.results).toHaveLength(2);
    expect(done!.result.best?.candidate.id).toBe('a');
  });

  it('persists the same complete payload (poll fallback / history detail path)', async () => {
    const h = makeHarness();
    await h.svc.run({ candidates: TWO }, 't-db');

    expect(h.finishes).toHaveLength(1);
    const patch = h.finishes[0]!.patch;
    expect(patch.status).toBe('done');
    const persisted = patch.result as OptimizationRunResult;
    expect(persisted.weights).toEqual(DEFAULT_WEIGHTS);
    expect(persisted.results).toHaveLength(2);
    expect(persisted.best?.score).toBeGreaterThanOrEqual(0);
  });

  it('ranks unresponsive candidates last with honest nulls — no NaN, always a done event', async () => {
    const h = makeHarness({ failAll: true });
    h.bus.subscribe('t-dead', (m) => h.messages.push(m));
    const result = await h.svc.run({ candidates: TWO }, 't-dead');

    expect(result.results).toHaveLength(2);
    for (const r of result.results as OptimizationCandidateResult[]) {
      expect(r.score).toBeNull();
      expect(r.metrics.pingAvgMs).toBeNull();
      expect(Number.isNaN(r.rank)).toBe(false);
    }
    expect(result.results.map((r) => r.rank)).toEqual([1, 2]);
    expect(h.messages.some((m) => m.type === 'test:done')).toBe(true);
    expect(h.finishes[0]!.patch.status).toBe('done');
  });

  it('never marks the test row created when validation fails (no_candidates)', async () => {
    const h = makeHarness();
    await expect(h.svc.run({}, 't-empty')).rejects.toMatchObject({ code: 'no_candidates' });
    expect(h.created).toBe(0);
    expect(h.finishes).toHaveLength(0);
  });

  it('a post-completion escape propagates for route-level logging; the finished row is never rewritten to error', async () => {
    const h = makeHarness({ eventsThrow: true });
    await expect(h.svc.run({ candidates: TWO }, 't-escape')).rejects.toThrow('events db is broken');

    // the row was finalized as done (with the full payload) and stays that way
    const statuses = h.finishes.map((f) => f.patch.status);
    expect(statuses).toEqual(['done']);
    expect((h.finishes[0]!.patch.result as OptimizationRunResult).weights).toEqual(DEFAULT_WEIGHTS);
  });
});
