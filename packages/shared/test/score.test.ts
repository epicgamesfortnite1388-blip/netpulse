import { describe, expect, it } from 'vitest';

import { DEFAULT_WEIGHTS } from '../src/score/engine';
import {
  dnsStatusForLatency,
  hopScore,
  jitterScore,
  labelFor,
  latencyScore,
  lossScore,
  scoreEndpoint,
  scoreRoute,
  throughputScore,
  weightedScore,
} from '../src/score/engine';

describe('component scores', () => {
  it('latency curve', () => {
    expect(latencyScore(5)).toBe(100);
    expect(latencyScore(18)).toBe(90);
    expect(latencyScore(40)).toBe(75);
    expect(latencyScore(80)).toBe(55);
    expect(latencyScore(120)).toBe(40);
    expect(latencyScore(200)).toBe(25);
    expect(latencyScore(1000)).toBe(10);
  });

  it('packet loss curve', () => {
    expect(lossScore(0)).toBe(100);
    expect(lossScore(0.4)).toBe(90);
    expect(lossScore(1)).toBe(75);
    expect(lossScore(2)).toBe(55);
    expect(lossScore(5)).toBe(30);
    expect(lossScore(10)).toBe(5);
  });

  it('jitter curve', () => {
    expect(jitterScore(0.5)).toBe(100);
    expect(jitterScore(2.4)).toBe(85);
    expect(jitterScore(8)).toBe(50);
    expect(jitterScore(50)).toBe(10);
  });

  it('throughput curve', () => {
    expect(throughputScore(600)).toBe(100);
    expect(throughputScore(487)).toBe(85);
    expect(throughputScore(300)).toBe(85);
    expect(throughputScore(120)).toBe(70);
    expect(throughputScore(60)).toBe(50);
    expect(throughputScore(5)).toBe(10);
  });

  it('hop score rewards direct paths', () => {
    expect(hopScore(4)).toBe(100);
    expect(hopScore(8)).toBe(90);
    expect(hopScore(40)).toBe(25);
  });
});

describe('weightedScore', () => {
  it('uses all components when measured', () => {
    const r = weightedScore(
      { latency: 100, packetLoss: 100, jitter: 100, throughput: 100, routeQuality: 100, load: 100 },
      DEFAULT_WEIGHTS,
    );
    expect(r.score).toBe(100);
    expect(r.measured.length).toBe(6);
  });

  it('renormalizes over measured components only', () => {
    // latency=90 (w30), packetLoss=100 (w20): (90*30 + 100*20) / 50 = 94
    const r = weightedScore({ latency: 90, packetLoss: 100 }, DEFAULT_WEIGHTS);
    expect(r.score).toBe(94);
    expect(r.measured).toEqual(['latency', 'packetLoss']);
  });

  it('returns 0 when nothing was measured', () => {
    const r = weightedScore({}, DEFAULT_WEIGHTS);
    expect(r.score).toBe(0);
    expect(r.measured.length).toBe(0);
  });
});

describe('labelFor', () => {
  it('maps thresholds', () => {
    expect(labelFor(95)).toBe('Excellent');
    expect(labelFor(85)).toBe('Excellent');
    expect(labelFor(84)).toBe('Good');
    expect(labelFor(70)).toBe('Good');
    expect(labelFor(50)).toBe('Fair');
    expect(labelFor(10)).toBe('Poor');
  });
});

describe('scoreRoute', () => {
  it('produces spec-style reasons for a healthy route', () => {
    const r = scoreRoute(
      { latencyMs: 18, jitterMs: 2.1, packetLossPct: 0, hops: 6, stability: 0.98 },
      DEFAULT_WEIGHTS,
    );
    expect(r.label).toBe('Excellent');
    expect(r.reasons).toContain('Excellent latency');
    expect(r.reasons).toContain('Zero packet loss');
    expect(r.reasons).toContain('Low jitter');
    expect(r.reasons).toContain('Direct path');
    expect(r.reasons).toContain('Stable route');
  });

  it('flags unhealthy routes', () => {
    const r = scoreRoute({ latencyMs: 200, packetLossPct: 6 }, DEFAULT_WEIGHTS);
    expect(r.score).toBeLessThan(50);
    expect(r.label).toBe('Poor');
  });

  it('returns null when nothing measured', () => {
    const r = scoreRoute({}, DEFAULT_WEIGHTS);
    expect(r.score).toBeNull();
    expect(r.label).toBeNull();
    expect(r.reasons).toEqual([]);
  });
});

describe('scoreEndpoint', () => {
  it('ranks a fast endpoint highly', () => {
    const r = scoreEndpoint({ connectMs: 12, httpMs: 25, packetLossPct: 0 }, DEFAULT_WEIGHTS);
    expect(r.label).toBe('Excellent');
  });
  it('returns null without measurements', () => {
    expect(scoreEndpoint({}, DEFAULT_WEIGHTS).score).toBeNull();
  });
});

describe('dnsStatusForLatency', () => {
  it('maps latency bands', () => {
    expect(dnsStatusForLatency(11, true)).toBe('excellent');
    expect(dnsStatusForLatency(22, true)).toBe('good');
    expect(dnsStatusForLatency(50, true)).toBe('fair');
    expect(dnsStatusForLatency(90, true)).toBe('poor');
    expect(dnsStatusForLatency(null, false)).toBe('unreachable');
  });
});
