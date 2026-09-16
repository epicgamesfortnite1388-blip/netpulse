import { describe, expect, it } from 'vitest';

import {
  budgetNote,
  depthPhrase,
  failureBreakdown,
  formatLatency,
  needsMissingCore,
  reportState,
  validatedDepth,
  validatedSummary,
} from '../src/features/vpn/discoveryReport';

import type { DiscoveryOutcome, DiscoveryReport } from '@netpulse/shared';

/**
 * The honesty contract for the discovery surface. These rules decide what the
 * UI is allowed to claim, so they are tested directly rather than through the
 * component: a failed probe must never read as a validated depth, an unknown
 * latency must never render as a number, and an empty run must say so.
 */

function outcome(over: Partial<DiscoveryOutcome> = {}): DiscoveryOutcome {
  return {
    nodeId: 'n1',
    name: 'node one',
    host: '1.2.3.4',
    port: 443,
    protocol: 'vless',
    depth: 'tcp',
    latencyMs: 40,
    carrying: false,
    failure: null,
    ...over,
  };
}

function report(over: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    profile: 'balanced',
    probed: 2,
    passed: 1,
    outcomes: [outcome()],
    winner: outcome(),
    summary: 'summary text',
    tookMs: 1_200,
    ...over,
  };
}

describe('reportState', () => {
  it('distinguishes an empty pool from a run where nothing passed', () => {
    expect(reportState(report({ probed: 0, passed: 0, outcomes: [], winner: null }))).toBe('no-candidates');
    expect(reportState(report({ probed: 3, passed: 0, outcomes: [outcome({ failure: 'refused' })], winner: null }))).toBe('nothing-passed');
    expect(reportState(report())).toBe('found');
  });
});

describe('validatedDepth', () => {
  it('never lets a FAILED candidate raise the validated depth', () => {
    // The wire format records the depth a failed candidate was probed at.
    // That must not be read as evidence it reached that depth.
    const r = report({
      outcomes: [
        outcome({ nodeId: 'a', depth: 'proxy', failure: 'core exited during startup' }),
        outcome({ nodeId: 'b', depth: 'tcp', failure: null }),
      ],
      passed: 1,
      winner: outcome({ nodeId: 'b' }),
    });
    expect(validatedDepth(r)).toBe('tcp');
  });

  it('is null when nothing passed, even though failures carry a depth', () => {
    const r = report({
      probed: 2,
      passed: 0,
      winner: null,
      outcomes: [outcome({ failure: 'timeout' }), outcome({ nodeId: 'b', depth: 'tls', failure: 'reset' })],
    });
    expect(validatedDepth(r)).toBeNull();
  });

  it('reports the deepest depth that actually passed', () => {
    const r = report({
      passed: 2,
      outcomes: [outcome({ nodeId: 'a', depth: 'tls' }), outcome({ nodeId: 'b', depth: 'proxy' })],
    });
    expect(validatedDepth(r)).toBe('proxy');
  });
});

describe('validatedSummary', () => {
  it('states the proven depth when something passed', () => {
    const r = report({ probed: 3, passed: 1, outcomes: [outcome({ depth: 'tls' })] });
    expect(validatedSummary(r)).toContain('1 of 3');
    expect(validatedSummary(r)).toContain('TLS handshake');
  });

  it('does not stutter the verb into the depth phrase', () => {
    // "completed a completed TLS handshake" shipped once; this locks it out.
    const summary = validatedSummary(report({ probed: 3, passed: 2, outcomes: [outcome({ depth: 'tls' })] }));
    expect(summary).not.toContain('completed a completed');
    expect(summary).toBe('Validated: 2 of 3 candidates reached a completed TLS handshake.');
  });

  it('reads as a sentence for each depth', () => {
    expect(validatedSummary(report({ probed: 1, passed: 1, outcomes: [outcome({ depth: 'proxy' })] })))
      .toBe('Validated: 1 of 1 candidate reached a real request carried through the node.');
    expect(validatedSummary(report({ probed: 1, passed: 1, outcomes: [outcome({ depth: 'tcp' })] })))
      .toBe('Validated: 1 of 1 candidate reached an answered TCP handshake.');
  });

  it('says nothing was validated rather than reporting zero results', () => {
    const summary = validatedSummary(report({ probed: 4, passed: 0, winner: null, outcomes: [outcome({ failure: 'x' })] }));
    expect(summary).toContain('Nothing was validated');
    expect(summary).not.toMatch(/\bTLS\b|\bTCP handshake\b/);
  });

  it('describes each depth in plain terms', () => {
    expect(depthPhrase('proxy')).toBe('a real request carried through the node');
    expect(depthPhrase('tls')).toBe('a completed TLS handshake');
    expect(depthPhrase('tcp')).toBe('an answered TCP handshake');
  });
});

describe('formatLatency', () => {
  it('returns null for an unmeasured latency instead of inventing a number', () => {
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(Number.NaN)).toBeNull();
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('renders a real measurement', () => {
    expect(formatLatency(41.6)).toBe('42 ms');
    expect(formatLatency(0)).toBe('0 ms');
  });
});

describe('failureBreakdown', () => {
  it('counts reasons verbatim, most common first', () => {
    const r = report({
      passed: 0,
      winner: null,
      outcomes: [
        outcome({ nodeId: 'a', failure: 'connection refused' }),
        outcome({ nodeId: 'b', failure: 'connection refused' }),
        outcome({ nodeId: 'c', failure: 'handshake timeout' }),
      ],
    });
    expect(failureBreakdown(r)).toEqual([
      { reason: 'connection refused', count: 2 },
      { reason: 'handshake timeout', count: 1 },
    ]);
  });

  it('states the absence of a reason instead of classifying it', () => {
    const r = report({ passed: 0, winner: null, outcomes: [outcome({ failure: '' })] });
    expect(failureBreakdown(r)).toEqual([{ reason: 'failed (no reason reported)', count: 1 }]);
  });

  it('ignores passing candidates', () => {
    expect(failureBreakdown(report())).toEqual([]);
  });
});

describe('budgetNote', () => {
  it('reports a full-budget run from the profile cap', () => {
    // stealth caps at 6
    expect(budgetNote(report({ profile: 'stealth', probed: 6 }))).toContain('full 6-candidate budget');
  });

  it('explains a short run as an exhausted pool, not a truncated budget', () => {
    const note = budgetNote(report({ profile: 'stealth', probed: 3 }));
    expect(note).toContain('3 of the profile’s 6-candidate budget');
    expect(note).toContain('pool ran out');
  });

  it('says no candidate was available when nothing was probed', () => {
    expect(budgetNote(report({ probed: 0 }))).toBe('No candidate was available to probe.');
  });
});

describe('needsMissingCore', () => {
  it('flags a proxy-depth profile when no core is installed', () => {
    expect(needsMissingCore('ironclad', null)).toBe(true);
    expect(needsMissingCore('thorough', null)).toBe(true);
  });

  it('does not flag proxy-depth profiles when a core is available', () => {
    expect(needsMissingCore('ironclad', 'xray')).toBe(false);
  });

  it('does not flag shallow profiles, which validate without a core', () => {
    expect(needsMissingCore('turbo', null)).toBe(false);
    expect(needsMissingCore('balanced', null)).toBe(false);
    expect(needsMissingCore('stealth', null)).toBe(false);
  });
});
