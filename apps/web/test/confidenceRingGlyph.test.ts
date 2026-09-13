import { describe, expect, it } from 'vitest';

import { CONFIDENCE_RING, ConfidenceRingGlyph, ringGlyphStyle } from '../src/features/map/MapCanvas';

/**
 * The destination panel's Location glyph must be derived from the SAME
 * confidence table as the canvas pins (via ringGlyphStyle) — never a
 * hand-rolled copy that can drift from what the map actually draws.
 */
describe('ConfidenceRingGlyph styling', () => {
  it('solid ring (no dash array) for high confidence, matching the pin', () => {
    const s = ringGlyphStyle('high');
    expect(s.dashArray).toBeUndefined();
    expect(s.opacity).toBe(CONFIDENCE_RING.high.alpha);
  });

  it('dashed rings for estimate levels, matching each pin dash pattern', () => {
    expect(ringGlyphStyle('medium').dashArray).toBe('3 3');
    expect(ringGlyphStyle('low').dashArray).toBe('2 4');
    expect(ringGlyphStyle('unknown').dashArray).toBe('1 5');
    for (const lvl of ['medium', 'low', 'unknown'] as const) {
      expect(ringGlyphStyle(lvl).opacity).toBe(CONFIDENCE_RING[lvl].alpha);
    }
  });

  it('glyph element renders a stroked circle with the derived style', () => {
    const g = ConfidenceRingGlyph({ level: 'medium' });
    // React element shape: svg > circle with strokeDasharray + opacity props.
    const circle = g.props.children;
    expect(circle.type).toBe('circle');
    expect(circle.props.strokeDasharray).toBe('3 3');
    expect(circle.props.opacity).toBe(CONFIDENCE_RING.medium.alpha);
    expect(circle.props.stroke).toBe('currentColor');
  });
});
