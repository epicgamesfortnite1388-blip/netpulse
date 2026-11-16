import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIAGNOSIS_OPTIONS,
  DEFAULT_TESTS,
  NETWORK_HYPOTHESES,
  diagnose,
  uniformPrior,
} from '../src/nani';

describe('NANI hypothesis space', () => {
  it('exposes the complete 18-hypothesis space including unknown', () => {
    expect(NETWORK_HYPOTHESES).toHaveLength(18);
    expect(new Set(NETWORK_HYPOTHESES).size).toBe(18);
    expect(NETWORK_HYPOTHESES).toContain('unknown');
    for (const required of [
      'gateway',
      'dns',
      'dns-inconsistency',
      'routing',
      'ipv4',
      'ipv6',
      'tcp',
      'tls',
      'udp',
      'mtu',
      'congestion',
      'filtering',
      'remote-endpoint',
      'api-auth',
      'api-rate-limit',
      'application',
      'server',
    ] as const) {
      expect(NETWORK_HYPOTHESES).toContain(required);
    }
  });

  it('gives every test a normalized likelihood for every hypothesis', () => {
    for (const test of DEFAULT_TESTS) {
      for (const hypothesis of NETWORK_HYPOTHESES) {
        const row = test.likelihoods[hypothesis];
        expect(row, `${test.id}/${hypothesis}`).toBeDefined();
        const total = row.success + row.failure + row.timeout + row.skipped + row.unknown;
        expect(total).toBeCloseTo(1, 8);
        for (const value of Object.values(row)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('keeps a normalized posterior and refuses a forced diagnosis with no evidence', () => {
    const prior = uniformPrior();
    expect(Object.values(prior).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const result = diagnose([], DEFAULT_TESTS, Date.now());
    expect(Object.values(result.posterior).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(result.top).toBeNull();
    expect(result.insufficientEvidence).toBe(true);
    expect(result.confidence).toBeLessThan(DEFAULT_DIAGNOSIS_OPTIONS.minConfidence);
  });
});
