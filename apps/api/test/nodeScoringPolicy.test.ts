import { describe, expect, it } from 'vitest';

import {
  applyTestOutcome,
  calculateScore,
  distributionOf,
  freshnessOf,
  statusAfterTest,
  tenthsOfMs,
  updateMedian,
} from '../src/services/nodeScoring';

import type { NodeAggregate } from '../src/services/nodeScoring';

/**
 * The scoring/measurement policy is pure and now lives in one module, so every
 * rule about how a probe outcome moves a node's aggregate is pinned here rather
 * than through a service that also owns repositories.
 */

const NOW = 1_700_000_000_000;

function aggregate(over: Partial<NodeAggregate> = {}): NodeAggregate {
  return {
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    testCount: 0,
    medianProxyMs: null,
    medianTcpMs: null,
    medianTlsMs: null,
    lastProxyMs: null,
    lastEngine: null,
    lastTcpMs: null,
    lastTlsMs: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastValidated: null,
    status: 'discovered',
    confidence: 'low',
    ...over,
  };
}

describe('tenthsOfMs', () => {
  it('keeps a tenth of a millisecond, never collapsing a real time to zero', () => {
    expect(tenthsOfMs(45.27)).toBe(45.3);
    expect(tenthsOfMs(45)).toBe(45);
    for (const elapsed of [1, 12, 45, 49]) expect(tenthsOfMs(elapsed)).toBeGreaterThan(0);
  });
});

describe('updateMedian', () => {
  it('leaves the median alone when the test failed (failures carry no latency)', () => {
    expect(updateMedian(120, 9_999, 5, 6, false)).toBe(120);
  });

  it('seeds the median with the first successful measurement', () => {
    expect(updateMedian(null, 88, 0, 1, true)).toBe(88);
  });

  it('weights toward the new value as successes accumulate', () => {
    // 5 prior successes: weight 5/6 → 120*(5/6) + 60*(1/6) = 110
    expect(updateMedian(120, 60, 5, 6, true)).toBeCloseTo(110, 5);
  });
});

describe('freshnessOf', () => {
  it('reports stale for a node that was never validated', () => {
    expect(freshnessOf(NOW, null)).toBe('stale');
  });

  it('buckets by age', () => {
    expect(freshnessOf(NOW, NOW - 60_000)).toBe('fresh');
    expect(freshnessOf(NOW, NOW - 3 * 3_600_000)).toBe('recent');
    expect(freshnessOf(NOW, NOW - 12 * 3_600_000)).toBe('aging');
    expect(freshnessOf(NOW, NOW - 48 * 3_600_000)).toBe('stale');
  });
});

describe('statusAfterTest', () => {
  const previous = { status: 'discovered', confidence: 'low' };

  it('goes healthy on any success', () => {
    expect(statusAfterTest(true, 0, previous)).toEqual({ status: 'healthy', confidence: 'high' });
  });

  it('escalates degradation with the failure streak', () => {
    expect(statusAfterTest(false, 1, previous)).toEqual({ status: 'degraded', confidence: 'low' });
    expect(statusAfterTest(false, 3, previous)).toEqual({ status: 'degraded', confidence: 'medium' });
    expect(statusAfterTest(false, 5, previous)).toEqual({ status: 'failed', confidence: 'high' });
  });

  it('keeps the previous state when a failure does not change the streak', () => {
    expect(statusAfterTest(false, 0, previous)).toEqual(previous);
  });
});

describe('calculateScore', () => {
  it('scores an unmeasured node zero rather than a fabricated middle value', () => {
    expect(
      calculateScore({
        medianProxyMs: null,
        medianTcpMs: null,
        medianTlsMs: null,
        reliabilityPct: 0,
        recentLossPct: 0,
        recentTestCount: 0,
        consecutiveFailures: 0,
      }),
    ).toBe(0);
  });

  it('ranks a fast reliable node above a slow lossy one', () => {
    const fast = calculateScore({
      medianProxyMs: 40,
      medianTcpMs: 30,
      medianTlsMs: null,
      reliabilityPct: 100,
      recentLossPct: 0,
      recentTestCount: 50,
      consecutiveFailures: 0,
    });
    const slow = calculateScore({
      medianProxyMs: 600,
      medianTcpMs: 500,
      medianTlsMs: null,
      reliabilityPct: 40,
      recentLossPct: 60,
      recentTestCount: 50,
      consecutiveFailures: 4,
    });
    expect(fast).toBeGreaterThan(slow);
  });
});

describe('distributionOf', () => {
  it('reports no spread for an empty sample instead of zeroes that read like measurements', () => {
    expect(distributionOf([])).toEqual({ median: null, p95: null });
  });

  it('computes the real median and p95 of the sample', () => {
    expect(distributionOf([10, 20, 30, 40])).toEqual({ median: 25, p95: 40 });
    expect(distributionOf([10, 20, 30])).toEqual({ median: 20, p95: 30 });
  });
});

describe('applyTestOutcome', () => {
  it('counts a success, stamps the measurement for its own type only, and marks the node healthy', () => {
    const { patch, counters } = applyTestOutcome(
      aggregate({ medianTcpMs: 100, successCount: 2, testCount: 2, lastEngine: 'sing-box' }),
      'tcp',
      { status: 'done', latencyMs: 40, engine: null },
      NOW,
    );

    expect(patch.status).toBe('healthy');
    expect(patch.confidence).toBe('high');
    expect(patch.lastTcpMs).toBe(40);
    expect(patch.testCount).toBe(3);
    expect(patch.successCount).toBe(3);
    expect(patch.lastValidated).toBe(NOW);
    expect(patch.lastSuccessAt).toBe(NOW);
    // A tcp test must not blank the proxy engine or a proxy measurement.
    expect(patch.lastEngine).toBe('sing-box');
    expect(patch.lastProxyMs).toBeNull();
    expect(counters).toEqual({
      testCount: 3,
      successCount: 3,
      failureCount: 0,
      reliabilityPct: 100,
      lossPct: 0,
      consecutiveFailures: 0,
    });
  });

  it('records the engine only for proxy tests and sanitizes an unknown core', () => {
    const xray = applyTestOutcome(aggregate(), 'proxy', { status: 'done', latencyMs: 80, engine: 'xray' }, NOW);
    expect(xray.patch.lastEngine).toBe('xray');
    expect(xray.patch.lastProxyMs).toBe(80);

    const bogus = applyTestOutcome(aggregate(), 'proxy', { status: 'done', latencyMs: 80, engine: 'nonsense' }, NOW);
    expect(bogus.patch.lastEngine).toBeNull();
  });

  it('counts a failure as loss and degradation without inventing a latency', () => {
    const { patch, counters } = applyTestOutcome(
      aggregate({ successCount: 1, failureCount: 1, testCount: 2 }),
      'proxy',
      { status: 'failed', latencyMs: null, engine: null },
      NOW,
    );

    expect(patch.medianProxyMs).toBeNull();
    expect(patch.lastFailureAt).toBe(NOW);
    expect(counters.consecutiveFailures).toBe(1);
    expect(counters.lossPct).toBeCloseTo((2 / 3) * 100, 6);
    expect(patch.status).toBe('degraded');
  });
});
