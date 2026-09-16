import { describe, expect, it } from 'vitest';

import { reliabilityRow, validatedDepthOf, VpnHistoryService } from '../src/services/vpnHistory';

import type { DiscoveryOutcome, DiscoveryReport, GatewayMemoryEntry, QuickConnectResult, ScanDepth } from '@netpulse/shared';

/**
 * Dashboard honesty contract:
 *   - every number in a rollup is computed from stored runs
 *   - empty history reports zero runs and NULL rates — never zeros that read
 *     like measurements
 *   - a failed probe never raises the validated depth of a run
 *   - a gateway with no attempts reports a NULL reliability, not 0% or 100%
 */

function outcome(depth: ScanDepth, failure: string | null, latencyMs: number | null = 900): DiscoveryOutcome {
  return { nodeId: `n-${Math.random().toString(36).slice(2, 8)}`, name: null, host: 'h', port: 1, protocol: 'vless', depth, latencyMs, carrying: failure === null && depth === 'proxy', failure };
}

function report(profile: DiscoveryReport['profile'], outcomes: DiscoveryOutcome[], tookMs = 500): DiscoveryReport {
  const passed = outcomes.filter((o) => o.failure === null).length;
  const winner = outcomes.find((o) => o.failure === null) ?? null;
  return {
    profile,
    probed: outcomes.length,
    passed,
    outcomes,
    winner,
    summary: `${passed} of ${outcomes.length} candidates validated.`,
    tookMs,
  };
}

function memory(overrides: Partial<GatewayMemoryEntry> = {}): GatewayMemoryEntry {
  return {
    nodeId: 'gw1',
    name: 'Gateway One',
    host: 'gw.example',
    port: 443,
    protocol: 'vless',
    engine: 'xray',
    exitIp: '203.0.113.5',
    exitCountry: 'NL',
    verifyMs: 820,
    successStreak: 2,
    successCount: 4,
    failCount: 1,
    firstSeenAt: Date.now() - 90_000,
    lastSuccessAt: Date.now() - 5_000,
    lastAttemptAt: Date.now() - 5_000,
    ...overrides,
  };
}

class FakeEvents {
  rows: Array<{ kind: string; at: number; payload: Record<string, unknown> }> = [];
  private seq = 1;
  insert(row: { kind: string; at: number; payload: Record<string, unknown> }): void {
    this.rows.push({ ...row, at: this.seq * 1000 });
    this.seq += 1;
  }
  recent(kind: string, limit: number): Array<{ kind: string; at: number; payload: Record<string, unknown> }> {
    return this.rows.filter((r) => r.kind === kind).slice(-limit);
  }
}

function makeService(gateways: GatewayMemoryEntry[] = []) {
  const events = new FakeEvents();
  const svc = new VpnHistoryService({
    events,
    gatewayMemory: { list: () => gateways },
    log: { warn: () => {} },
  });
  return { svc, events };
}

describe('VpnHistoryService', () => {
  it('empty history reports zero runs with null rates (never fake measurements)', () => {
    const { svc } = makeService();
    const r = svc.report();
    expect(r.discovery.runs).toEqual([]);
    expect(r.discovery.rollups).toEqual([]);
    expect(r.quickConnect.totalRuns).toBe(0);
    expect(r.quickConnect.successRatePct).toBeNull();
    expect(r.gateways).toEqual([]);
  });

  it('rolls up per profile from stored runs only', () => {
    const { svc } = makeService();
    svc.recordDiscoveryRun(report('turbo', [outcome('tcp', null), outcome('tcp', 'timeout')]), 'manual', 'user');
    svc.recordDiscoveryRun(report('turbo', [outcome('tcp', null)]), 'manual', 'user');
    svc.recordDiscoveryRun(report('ironclad', [outcome('proxy', null), outcome('proxy', 'refused')]), 'manual', 'user');
    const r = svc.report();
    const turbo = r.discovery.rollups.find((x) => x.profile === 'turbo')!;
    expect(turbo.runs).toBe(2);
    expect(turbo.totalProbed).toBe(3);
    expect(turbo.totalPassed).toBe(2);
    expect(turbo.meanPassRatePct).toBeCloseTo(((1 / 2) + (1 / 1)) / 2 * 100, 5);
    const ironclad = r.discovery.rollups.find((x) => x.profile === 'ironclad')!;
    expect(ironclad.lastValidatedDepth).toBe('proxy');
    expect(r.discovery.runs[0]!.profile).toBe('ironclad'); // newest first
  });

  it('a failed probe never raises the stored validated depth', () => {
    const rep = report('balanced', [outcome('tcp', null), outcome('proxy', 'core exited')]);
    expect(validatedDepthOf(rep)).toBe('tcp');
  });

  it('labels the origin of the scan that was recorded', () => {
    const { svc } = makeService();
    svc.recordDiscoveryRun(report('balanced', []), 'quick-connect', 'quick-connect');
    const r = svc.report();
    expect(r.discovery.runs[0]!.origin).toBe('quick-connect');
    expect(r.discovery.runs[0]!.trigger).toBe('quick-connect');
  });

  it('quick-connect history keeps real attempts and derives the success rate', () => {
    const { svc } = makeService();
    const attempts = [
      { nodeId: 'a', name: null, host: 'a', port: 1, source: 'memory' as const, ok: false, error: 'down', exitIp: null, tookMs: 100 },
      { nodeId: 'b', name: null, host: 'b', port: 2, source: 'discovery' as const, ok: true, error: null, exitIp: '1.2.3.4', tookMs: 900 },
    ];
    svc.recordQuickConnectRun({ ok: true, profile: 'balanced', attempts, summary: 'connected' } as QuickConnectResult, 5_000);
    svc.recordQuickConnectRun({ ok: false, profile: 'balanced', attempts: [attempts[0]!], summary: 'failed' } as QuickConnectResult, 2_000);
    const r = svc.report();
    expect(r.quickConnect.totalRuns).toBe(2);
    expect(r.quickConnect.totalAttempts).toBe(3);
    expect(r.quickConnect.successRatePct).toBeCloseTo(50, 5);
    // Newest first: the failed run leads; the connected run carries its winner.
    expect(r.quickConnect.runs[0]!.ok).toBe(false);
    expect(r.quickConnect.runs[0]!.winningSource).toBeNull();
    expect(r.quickConnect.runs[1]!.winningSource).toBe('discovery');
  });

  it('gateway reliability is null when nothing was attempted, honest when it was', () => {
    const untouched = reliabilityRow(memory({ successCount: 0, failCount: 0, verifyMs: null }), 0);
    expect(untouched.reliabilityPct).toBeNull();
    expect(untouched.meanVerifyMs).toBeNull();

    const g = reliabilityRow(memory(), 0);
    expect(g.reliabilityPct).toBeCloseTo((4 / 5) * 100, 5);
    expect(g.meanVerifyMs).toBe(820);
  });

  it('recording failures never break the caller (history is best-effort)', () => {
    const svc = new VpnHistoryService({
      events: {
        insert: () => { throw new Error('disk full'); },
        recent: () => [],
      },
      gatewayMemory: { list: () => [] },
      log: { warn: () => {} },
    });
    expect(() => svc.recordDiscoveryRun(report('balanced', []), 'manual', 'user')).not.toThrow();
    expect(() => svc.recordQuickConnectRun({ ok: false, profile: 'balanced', attempts: [], summary: '' } as QuickConnectResult, 1)).not.toThrow();
  });
});
