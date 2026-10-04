/**
 * Combining two traceroute runs must never invent a measurement.
 *
 * `mergeTraces` folds a second run into the first so a hop that answered on
 * only one leg stops looking like it dropped nothing. It gets that wrong the
 * moment an absent value is averaged in as zero: one run measured 10% loss,
 * the other never reached the hop, and the old code reported 5% — a figure
 * neither run produced, which the route page then renders as "5% probes timed
 * out". A hop measured on one leg only reported as 0% when it did not answer
 * at all, and 0% is the one value the UI renders as "no loss warning".
 *
 * The arithmetic is pinned directly rather than through a simulated network:
 * the rule is the whole content of the merge, and driving it through a real
 * second traceroute would test the socket stack, not this.
 */
import { describe, expect, it } from 'vitest';

import { mergeMeasurement, mergeTraces } from '../src/services/routeService';

import type { RouteHop, TraceResult } from '@netpulse/shared';

/** A hop as the traceroute produces it; `packetLoss: null` = never measured. */
function hop(over: Partial<RouteHop> = {}): RouteHop {
  return {
    hop: 1,
    ip: '10.0.0.1',
    hostname: null,
    latencyMs: 12,
    packetLoss: null,
    asn: null,
    org: null,
    country: null,
    status: 'ok',
    ...over,
  };
}

function trace(hops: RouteHop[]): TraceResult {
  return { target: 'example.com', resolvedIp: '93.184.216.34', family: 4, hops, totalHops: hops.length, totalLatencyMs: 12 };
}

describe('merging a hop observed on only one leg of a two-run trace', () => {
  it('reports the measured value, not half of it', () => {
    // The defect in one line: 10% was measured, the other leg was silent, and
    // `?? 0` would have produced 5%.
    expect(mergeMeasurement(10, null)).toBe(10);
    expect(mergeMeasurement(null, 10)).toBe(10);
    expect(mergeMeasurement(33.3, null)).toBe(33.3);
  });

  it('keeps an unmeasured hop unmeasured instead of collapsing it to 0', () => {
    // Zero here would be indistinguishable from "probes ran and none were
    // lost", which is the opposite claim.
    expect(mergeMeasurement(null, null)).toBeNull();
  });

  it('averages only when both legs actually measured', () => {
    expect(mergeMeasurement(10, 20)).toBe(15);
    expect(mergeMeasurement(0, 4)).toBe(2);
    expect(mergeMeasurement(0, 0)).toBe(0);
  });

  it('rounds the combined value to the one decimal the hop model uses', () => {
    expect(mergeMeasurement(1, 2)).toBe(1.5);
    expect(mergeMeasurement(1.11, 2.22)).toBe(1.7);
    // Single decimals pass through untouched, since no averaging happened.
    expect(mergeMeasurement(33.3, null)).toBe(33.3);
  });

  it('treats a real zero as a measurement, because it is one', () => {
    // Two legs that both answered and dropped nothing really did measure 0%.
    // Collapsing this into null would hide a genuine clean result.
    expect(mergeMeasurement(0, null)).toBe(0);
  });
});

describe('the merge itself uses that rule', () => {
  // The arithmetic test above can pass while mergeTraces stops calling it, so
  // the call site is pinned too: this is what reverts if someone reintroduces
  // `?? 0` at the point of use.
  it('reports the one leg\'s measured loss, not half of it', () => {
    const merged = mergeTraces(trace([hop({ packetLoss: 10 })]), trace([hop({ packetLoss: null })]));
    expect(merged.hops[0]!.packetLoss).toBe(10);
  });

  it('leaves a hop neither leg measured unmeasured', () => {
    const merged = mergeTraces(trace([hop({ packetLoss: null })]), trace([hop({ packetLoss: null })]));
    expect(merged.hops[0]!.packetLoss).toBeNull();
  });

  it('combines two measured legs', () => {
    const merged = mergeTraces(trace([hop({ packetLoss: 10 })]), trace([hop({ packetLoss: 20 })]));
    expect(merged.hops[0]!.packetLoss).toBe(15);
  });

  it('keeps a measured zero as a measured zero', () => {
    const merged = mergeTraces(trace([hop({ packetLoss: 0 })]), trace([hop({ packetLoss: null })]));
    expect(merged.hops[0]!.packetLoss).toBe(0);
  });

  it('applies the same rule to latency, so the two fields cannot disagree', () => {
    const merged = mergeTraces(trace([hop({ latencyMs: 88, packetLoss: 10 })]), trace([hop({ latencyMs: null, packetLoss: null })]));
    expect(merged.hops[0]!.latencyMs).toBe(88);
    expect(merged.hops[0]!.packetLoss).toBe(10);
  });
});

describe('latency and packet loss follow one rule', () => {
  it('never averages an absent leg in, for either kind of measurement', () => {
    // `mergeTraces` calls this for both fields. A hop answered on one leg only
    // must report that leg's figure for both, and a hop answered on neither
    // must stay absent for both — the rule is shared, not merely similar.
    expect(mergeMeasurement(null, 12.3)).toBe(12.3); // latency, one leg
    expect(mergeMeasurement(null, 0)).toBe(0); // loss, one leg, really zero
    expect(mergeMeasurement(null, null)).toBeNull(); // neither leg
    expect(mergeMeasurement(88, null)).toBe(88); // latency, other side
    expect(mergeMeasurement(0.4, null)).toBe(0.4); // loss, other side
  });
});