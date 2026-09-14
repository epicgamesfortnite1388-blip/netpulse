import { describe, expect, it } from 'vitest';

import { CONFIDENCE_RING } from '../src/features/map/mapEncoding';

import type { GeoConfidenceLevel } from '@netpulse/shared';

/**
 * The map pin's confidence ring is the visual contract: a solid ring means
 * the location is a measured fact (known endpoint), a dashed ring means a
 * GeoIP estimate, and fainter/sparser dashes mean progressively rougher
 * guesses. The styles must be visually distinct and strictly ordered —
 * higher confidence = more solid/more visible ring.
 */
describe('CONFIDENCE_RING visual encoding', () => {
  it('defines a style for every confidence level', () => {
    for (const level of ['high', 'medium', 'low', 'unknown'] as const) {
      const style = CONFIDENCE_RING[level];
      expect(style.radiusFactor, level).toBeGreaterThan(1);
      expect(style.alpha, level).toBeGreaterThan(0);
      expect(style.alpha, level).toBeLessThanOrEqual(1);
    }
  });

  it('high confidence is a solid, fully visible ring', () => {
    const high = CONFIDENCE_RING.high;
    expect(high.dash).toEqual([]); // solid
    expect(high.alpha).toBeGreaterThanOrEqual(0.8);
  });

  it('rings get fainter as confidence drops (high > medium > low > unknown)', () => {
    const { high, medium, low, unknown } = CONFIDENCE_RING;
    expect(high.alpha).toBeGreaterThan(medium.alpha);
    expect(medium.alpha).toBeGreaterThan(low.alpha);
    expect(low.alpha).toBeGreaterThan(unknown.alpha);
  });

  it('estimates are dashed while facts are solid', () => {
    expect(CONFIDENCE_RING.high.dash.length).toBe(0);
    expect(CONFIDENCE_RING.medium.dash.length).toBeGreaterThan(0);
    expect(CONFIDENCE_RING.low.dash.length).toBeGreaterThan(0);
    // lower confidence = sparser dashes (larger gap share per period)
    const gapShare = (dash: number[]) => dash[1]! / (dash[0]! + dash[1]!);
    expect(gapShare(CONFIDENCE_RING.low.dash)).toBeGreaterThan(gapShare(CONFIDENCE_RING.medium.dash));
  });

  it('unknown locations get the faintest ghost ring', () => {
    expect(CONFIDENCE_RING.unknown.alpha).toBeLessThanOrEqual(0.35);
    expect(CONFIDENCE_RING.unknown.dash[0]).toBeLessThanOrEqual(CONFIDENCE_RING.low.dash[0]!);
  });

  it('every level maps from the shared GeoConfidenceLevel union', () => {
    const levels: GeoConfidenceLevel[] = ['high', 'medium', 'low', 'unknown'];
    for (const level of levels) expect(CONFIDENCE_RING[level]).toBeDefined();
  });
});
