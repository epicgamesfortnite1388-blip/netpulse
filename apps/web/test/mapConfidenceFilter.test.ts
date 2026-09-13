import { describe, expect, it } from 'vitest';

import { CONFIDENCE_RING, confidenceMeetsThreshold } from '../src/features/map/MapCanvas';

import type { GeoConfidenceLevel } from '@netpulse/shared';

/**
 * The confidence filter hides pins whose PLACE is not trusted enough.
 * Semantics under test:
 *   - 'show all' passes everything (filter off)
 *   - thresholds are strict: pin confidence must be >= threshold
 *   - a pin with NO confidence is never hidden — the filter hides shaky
 *     places, not honest Unknowns (those already carry no coordinates)
 */
describe('confidenceMeetsThreshold', () => {
  it("'show all' passes every pin", () => {
    for (const c of ['high', 'medium', 'low', 'unknown', undefined] as const) {
      expect(confidenceMeetsThreshold(c, 'show all')).toBe(true);
    }
  });

  it("'high' keeps only measured pins", () => {
    expect(confidenceMeetsThreshold('high', 'high')).toBe(true);
    expect(confidenceMeetsThreshold('medium', 'high')).toBe(false);
    expect(confidenceMeetsThreshold('low', 'high')).toBe(false);
    expect(confidenceMeetsThreshold('unknown', 'high')).toBe(false);
  });

  it("'medium' keeps measured + estimate, drops guesses", () => {
    expect(confidenceMeetsThreshold('high', 'medium')).toBe(true);
    expect(confidenceMeetsThreshold('medium', 'medium')).toBe(true);
    expect(confidenceMeetsThreshold('low', 'medium')).toBe(false);
    expect(confidenceMeetsThreshold('unknown', 'medium')).toBe(false);
  });

  it("'low' keeps everything with a confidence verdict", () => {
    expect(confidenceMeetsThreshold('high', 'low')).toBe(true);
    expect(confidenceMeetsThreshold('low', 'low')).toBe(true);
    expect(confidenceMeetsThreshold('unknown', 'low')).toBe(false);
  });

  it('pins without confidence are never hidden', () => {
    expect(confidenceMeetsThreshold(undefined, 'show all')).toBe(true);
    expect(confidenceMeetsThreshold(undefined, 'high')).toBe(true);
    expect(confidenceMeetsThreshold(undefined, 'medium')).toBe(true);
    expect(confidenceMeetsThreshold(undefined, 'low')).toBe(true);
  });

  it('thresholds cover the whole level set', () => {
    const levels: GeoConfidenceLevel[] = ['high', 'medium', 'low', 'unknown'];
    for (const l of levels) expect(CONFIDENCE_RING[l]).toBeDefined();
  });
});
