import type { NodeStatus, PublicNode } from '@netpulse/shared';

/**
 * Node measurement policy — how raw test outcomes move a node's aggregate
 * state. Pure functions: no I/O, no repository, no clock reads (the caller
 * passes `now`), so every rule here is unit-testable and the service keeps
 * only persistence.
 *
 * `tenthsOfMs` lives here because it is measurement policy: it defines the
 * resolution at which a latency is stored. It replaced an expression that
 * divided by 1000, which reported a 45 ms handshake as `0 ms` — the app
 * presents these numbers as measurements, so the scale has to be right.
 */
export function tenthsOfMs(elapsedMs: number): number {
  return Math.round(elapsedMs * 10) / 10;
}

/**
 * Incremental median approximation. Weights by SUCCESS counts, not total
 * tests — failures carry no latency, so counting them would pin the median
 * to old values after a long failure streak.
 */
export function updateMedian(
  currentMedian: number | null,
  newValue: number,
  oldCount: number,
  newCount: number,
  wasSuccess: boolean,
): number | null {
  if (!wasSuccess) return currentMedian;

  if (currentMedian == null) return newValue;

  const weight = oldCount > 0 ? oldCount / newCount : 0;
  return currentMedian * weight + newValue * (1 - weight);
}

export function freshnessOf(now: number, lastValidated: number | null): string {
  if (lastValidated == null) return 'stale';

  const age = now - lastValidated;
  const oneHour = 60 * 60 * 1000;
  const sixHours = 6 * oneHour;
  const oneDay = 24 * oneHour;

  if (age < oneHour) return 'fresh';
  if (age < sixHours) return 'recent';
  if (age < oneDay) return 'aging';
  return 'stale';
}

export function latencyToScore(proxyMs: number | null, tcpMs: number | null): number {
  const ms = proxyMs ?? tcpMs;
  if (ms == null) return 50;

  if (ms < 50) return 100;
  if (ms < 100) return 90;
  if (ms < 150) return 80;
  if (ms < 200) return 70;
  if (ms < 300) return 50;
  if (ms < 500) return 30;
  return 10;
}

export function calculateScore(
  stats: {
    medianProxyMs: number | null;
    medianTcpMs: number | null;
    medianTlsMs: number | null;
    reliabilityPct: number;
    recentLossPct: number;
    recentTestCount: number;
    consecutiveFailures: number;
  },
): number {
  if (stats.recentTestCount === 0) return 0;

  // Score components (0-100 each)
  const latencyScore = latencyToScore(stats.medianProxyMs, stats.medianTcpMs);
  const reliabilityScore = stats.reliabilityPct;
  const lossScore = Math.max(0, 100 - stats.recentLossPct * 20);
  const stabilityScore = Math.max(0, 100 - stats.consecutiveFailures * 20);
  const volumeScore = Math.min(100, (stats.recentTestCount / 100) * 100);

  // Weighted average
  const total = latencyScore * 0.35 +
                reliabilityScore * 0.30 +
                lossScore * 0.15 +
                stabilityScore * 0.10 +
                volumeScore * 0.10;

  return Math.round(total);
}

/**
 * What one more test outcome does to a node's lifecycle state. Healthy on any
 * success; degradation comes from consecutive failures, with confidence
 * rising as the streak gets long enough to be a fact rather than a fluctuation.
 */
export function statusAfterTest(
  wasSuccess: boolean,
  consecutiveFailures: number,
  previous: { status: NodeStatus | string; confidence: string },
): { status: string; confidence: string } {
  if (wasSuccess) return { status: 'healthy', confidence: 'high' };
  if (consecutiveFailures >= 5) return { status: 'failed', confidence: 'high' };
  if (consecutiveFailures >= 3) return { status: 'degraded', confidence: 'medium' };
  if (consecutiveFailures >= 1) return { status: 'degraded', confidence: 'low' };
  return { status: previous.status, confidence: previous.confidence };
}

/**
 * median/p95 of a node's recent successful latencies — the real distribution,
 * not the last single measurement stored twice (the old behavior silently
 * misreported spread).
 */
export function distributionOf(latencies: number[]): { median: number | null; p95: number | null } {
  if (latencies.length === 0) return { median: null, p95: null };
  const sorted = [...latencies].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? 0);
  const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return { median, p95: sorted[p95Idx] ?? median };
}

/**
 * The row shape `applyTestOutcome` reads. It carries the per-type measurement
 * slots and the success/failure stamps too, so the returned patch reproduces
 * the unchanged columns explicitly — a test of one type cannot silently blank
 * another type's last measurement.
 */
export type NodeAggregate = Pick<
  PublicNode,
  | 'successCount'
  | 'failureCount'
  | 'consecutiveFailures'
  | 'recentTestCount'
  | 'recentSuccessCount'
  | 'recentFailureCount'
  | 'testCount'
  | 'medianProxyMs'
  | 'medianTcpMs'
  | 'medianTlsMs'
  | 'lastProxyMs'
  | 'lastEngine'
  | 'lastTcpMs'
  | 'lastTlsMs'
  | 'lastSuccessAt'
  | 'lastFailureAt'
  | 'lastValidated'
  | 'status'
  | 'confidence'
>;

/**
 * The node columns one test outcome writes. Every slot is present: a test of
 * one type carries the other types' stored measurements through unchanged, so
 * applying the patch is idempotent and never depends on the repository's
 * undefined handling.
 */
export interface TestOutcomePatch {
  lastValidated: number;
  status: string;
  confidence: string;
  lastProxyMs: number | null;
  lastEngine: string | null;
  lastTcpMs: number | null;
  lastTlsMs: number | null;
  testCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  recentTestCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs: number | null;
  medianTlsMs: number | null;
  recentLossPct: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  freshness: string;
  score: number;
  updatedAt: number;
}

/** The counters a node's health row mirrors after a test. */
export interface TestOutcomeCounters {
  testCount: number;
  successCount: number;
  failureCount: number;
  reliabilityPct: number;
  lossPct: number;
  consecutiveFailures: number;
}

/**
 * Everything one test outcome changes about a node's aggregate — counters,
 * medians, status, freshness, score, loss. The service applies the returned
 * patch; the math never touches a repository.
 */
export function applyTestOutcome(
  node: NodeAggregate,
  type: 'tcp' | 'tls' | 'proxy' | 'icmp',
  result: { status: string; latencyMs: number | null; engine?: string | null },
  now: number,
): { patch: TestOutcomePatch; counters: TestOutcomeCounters } {
  const wasSuccess = result.status === 'done';
  const prevSuccess = node.successCount;
  const prevFailure = node.failureCount;
  const prevConsecutive = node.consecutiveFailures;

  const newSuccess = wasSuccess ? prevSuccess + 1 : prevSuccess;
  const newFailure = wasSuccess ? prevFailure : prevFailure + 1;
  const newConsecutive = wasSuccess ? 0 : prevConsecutive + 1;

  // Recent counters (24h window) are simple bumps here; a rolling-window
  // recount happens in the periodic health refresh.
  const newRecentTest = node.recentTestCount + 1;
  const newRecentSuccess = wasSuccess ? node.recentSuccessCount + 1 : node.recentSuccessCount;
  const newRecentFailure = wasSuccess ? node.recentFailureCount : node.recentFailureCount + 1;

  let medianProxy = node.medianProxyMs;
  let medianTcp = node.medianTcpMs;
  let medianTls = node.medianTlsMs;
  const totalTests = node.testCount + 1;

  if (result.latencyMs != null) {
    if (type === 'proxy') {
      medianProxy = updateMedian(node.medianProxyMs, result.latencyMs, prevSuccess, newSuccess, wasSuccess);
    } else if (type === 'tcp') {
      medianTcp = updateMedian(node.medianTcpMs, result.latencyMs, prevSuccess, newSuccess, wasSuccess);
    } else if (type === 'tls') {
      medianTls = updateMedian(node.medianTlsMs, result.latencyMs, prevSuccess, newSuccess, wasSuccess);
    }
  }

  const successRate = totalTests > 0 ? (newSuccess / totalTests) * 100 : 0;
  const lossPct = totalTests > 0 ? ((totalTests - newSuccess) / totalTests) * 100 : 0;

  const lifecycle = statusAfterTest(wasSuccess, newConsecutive, node);

  const patch: TestOutcomePatch = {
    lastValidated: now,
    status: lifecycle.status,
    confidence: lifecycle.confidence,
    lastProxyMs: type === 'proxy' ? result.latencyMs : node.lastProxyMs,
    lastEngine: type === 'proxy'
      ? (['xray', 'sing-box', 'v2ray'].includes(result.engine as string) ? (result.engine as string) : null)
      : node.lastEngine,
    lastTcpMs: type === 'tcp' ? result.latencyMs : node.lastTcpMs,
    lastTlsMs: type === 'tls' ? result.latencyMs : node.lastTlsMs,
    testCount: totalTests,
    successCount: newSuccess,
    failureCount: newFailure,
    consecutiveFailures: newConsecutive,
    recentTestCount: newRecentTest,
    recentSuccessCount: newRecentSuccess,
    recentFailureCount: newRecentFailure,
    reliabilityPct: successRate,
    medianProxyMs: medianProxy,
    medianTcpMs: medianTcp,
    medianTlsMs: medianTls,
    recentLossPct: lossPct,
    lastSuccessAt: wasSuccess ? now : node.lastSuccessAt,
    lastFailureAt: !wasSuccess ? now : node.lastFailureAt,
    freshness: freshnessOf(now, node.lastValidated),
    score: calculateScore({
      medianProxyMs: medianProxy,
      medianTcpMs: medianTcp,
      medianTlsMs: medianTls,
      reliabilityPct: successRate,
      recentLossPct: lossPct,
      recentTestCount: newRecentTest,
      consecutiveFailures: newConsecutive,
    }),
    updatedAt: now,
  };

  return {
    patch,
    counters: {
      testCount: totalTests,
      successCount: newSuccess,
      failureCount: newFailure,
      reliabilityPct: successRate,
      lossPct,
      consecutiveFailures: newConsecutive,
    },
  };
}
