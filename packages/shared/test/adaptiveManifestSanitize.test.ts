import { describe, expect, it } from 'vitest';

import { ADAPTIVE_MANIFEST_LIMITS, sanitizeAppliedManifest } from '../src/adaptive/manifest';
import { DEFAULT_ADAPTIVE_POLICY } from '../src/adaptive/types';

/** A stored record shaped like the one the engine writes after a verified install. */
const stored = (overrides: Record<string, unknown> = {}) => ({
  version: 7,
  channel: 'production',
  options: { ...DEFAULT_ADAPTIVE_POLICY },
  enabledStrategyIds: ['xray'],
  disabledStrategyIds: [],
  revocation: [{ strategyId: 'v2ray', reason: 'broken here', at: 1 }],
  applied: ['minSamples=4'],
  refused: [],
  ...overrides,
});

describe('a persisted policy manifest is re-validated, not trusted', () => {
  it('keeps a valid record intact', () => {
    const out = sanitizeAppliedManifest(stored())!;
    expect(out).not.toBeNull();
    expect(out.version).toBe(7);
    expect(out.channel).toBe('production');
    expect(out.enabledStrategyIds).toEqual(['xray']);
    expect(out.revocation.map((r) => r.strategyId)).toEqual(['v2ray']);
    expect(out.options).toEqual(DEFAULT_ADAPTIVE_POLICY);
  });

  it('clamps every field the signed patch is allowed to change', () => {
    const out = sanitizeAppliedManifest(
      stored({
        options: {
          ...DEFAULT_ADAPTIVE_POLICY,
          explorationShare: 0.99,
          costWeight: 9,
          minSamples: 0,
          halfLifeMs: 1,
          flopThreshold: 0,
        },
      }),
    )!;
    expect(out.options.explorationShare).toBe(ADAPTIVE_MANIFEST_LIMITS.maxExplorationShare);
    expect(out.options.costWeight).toBe(ADAPTIVE_MANIFEST_LIMITS.maxCostWeight);
    expect(out.options.minSamples).toBe(ADAPTIVE_MANIFEST_LIMITS.minMinSamples);
    expect(out.options.halfLifeMs).toBe(ADAPTIVE_MANIFEST_LIMITS.minHalfLifeMs);
    expect(out.options.flopThreshold).toBe(1);
  });

  it('forces fields the signed patch may never change back to build defaults', () => {
    const out = sanitizeAppliedManifest(
      stored({
        options: {
          ...DEFAULT_ADAPTIVE_POLICY,
          uncertaintyZ: 0,
          maxObservations: 1e9,
          maxContexts: 1e9,
          maxStrategiesPerContext: 1e9,
          costReferenceMs: 1,
        },
      }),
    )!;
    // `uncertaintyZ` is the guard against thin evidence winning; a stored byte
    // must not be able to switch it off.
    expect(out.options.uncertaintyZ).toBe(DEFAULT_ADAPTIVE_POLICY.uncertaintyZ);
    expect(out.options.maxObservations).toBe(DEFAULT_ADAPTIVE_POLICY.maxObservations);
    expect(out.options.maxContexts).toBe(DEFAULT_ADAPTIVE_POLICY.maxContexts);
    expect(out.options.maxStrategiesPerContext).toBe(DEFAULT_ADAPTIVE_POLICY.maxStrategiesPerContext);
    expect(out.options.costReferenceMs).toBe(DEFAULT_ADAPTIVE_POLICY.costReferenceMs);
  });

  it('drops malformed strategy ids and revocations instead of accepting them', () => {
    const out = sanitizeAppliedManifest(
      stored({
        enabledStrategyIds: ['xray', 'not a strategy', 42, ''],
        revocation: [{ strategyId: 'xray', reason: 'ok' }, { reason: 'no id' }, null],
      }),
    )!;
    expect(out.enabledStrategyIds).toEqual(['xray']);
    expect(out.revocation.map((r) => r.strategyId)).toEqual(['xray']);
  });

  it('returns null for a record that is not a usable manifest', () => {
    expect(sanitizeAppliedManifest(null)).toBeNull();
    expect(sanitizeAppliedManifest('manifest')).toBeNull();
    expect(sanitizeAppliedManifest([])).toBeNull();
    expect(sanitizeAppliedManifest({ version: 1 })).toBeNull();
    expect(sanitizeAppliedManifest({ version: 0, channel: 'production' })).toBeNull();
    expect(sanitizeAppliedManifest({ version: 1, channel: 'staging' })).toBeNull();
  });
});
