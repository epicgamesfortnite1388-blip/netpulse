import { fmtPct } from '@/lib/format';

import type { MetricItem, MetricTone } from '@/components/ui/Surface';

/** Aggregated health record returned by GET /nodes/:id/health */
export interface NodeHealthSummary {
  testCount: number;
  successCount: number;
  failureCount: number;
  /** null until a probe has actually run — 0 would mean "every probe failed" */
  reliabilityPct: number | null;
  medianLatencyMs: number | null;
  /** null until a probe has actually run — 0 would read as "drops nothing" */
  lossPct: number | null;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

/** The columns a node's stored row carries regardless of whether it was probed. */
interface StoredRates {
  testCount: number;
  reliabilityPct: number;
  recentLossPct: number;
}

export interface NodeRates {
  probesRecorded: number;
  reliabilityPct: number | null;
  lossPct: number | null;
  recentLossPct: number | null;
  reliabilityTone: MetricTone;
  lossTone: MetricTone;
}

/**
 * A node that has never been probed has no rates to report.
 *
 * The stored row seeds reliability and loss at 0, and 0% loss is the healthiest
 * thing this page can say, so the probe count decides whether they are reported
 * at all. A measured 0 — probes ran, nothing dropped — still shows as 0, because
 * that one is real.
 *
 * Derived once, here, so no row on the page can disagree with another about
 * whether a number was measured.
 */
export function nodeRates(health: NodeHealthSummary | null, node: StoredRates): NodeRates {
  const probesRecorded = health?.testCount ?? node.testCount;
  const measured = probesRecorded > 0;
  const reliabilityPct = measured ? (health?.reliabilityPct ?? node.reliabilityPct) : null;
  const lossPct = measured ? (health?.lossPct ?? null) : null;
  const recentLossPct = measured ? node.recentLossPct : null;
  const lossTone = (loss: number | null): MetricTone =>
    loss == null ? 'faint' : loss <= 1 ? 'ok' : loss <= 5 ? 'warn' : 'danger';
  return {
    probesRecorded,
    reliabilityPct,
    lossPct,
    recentLossPct,
    reliabilityTone: reliabilityPct == null
      ? 'faint'
      : reliabilityPct >= 95
        ? 'ok'
        : reliabilityPct >= 80
          ? 'warn'
          : 'danger',
    lossTone: lossTone(lossPct),
  };
}

/** The Health tab's strip. Exported so the rendered output can be asserted. */
export function healthMetricItems(
  rates: NodeRates,
  medianLatencyMs: number | null,
): MetricItem[] {
  return [
    { label: 'Probes', value: rates.probesRecorded, hint: 'successes + failures', mono: true },
    {
      label: 'Reliability',
      value: fmtPct(rates.reliabilityPct),
      tone: rates.reliabilityTone,
    },
    {
      label: 'Median latency',
      value: medianLatencyMs != null ? `${medianLatencyMs} ms` : '—',
      hint: 'across successful probes',
      mono: true,
    },
    { label: 'Packet loss', value: fmtPct(rates.lossPct), tone: rates.lossTone },
  ];
}