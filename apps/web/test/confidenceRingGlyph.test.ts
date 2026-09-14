import { describe, expect, it } from 'vitest';

import { CONFIDENCE_LEGEND, CONFIDENCE_RING, ConfidenceLegendBody, ConfidenceRingGlyph, ringGlyphStyle } from '../src/features/map/mapEncoding';

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

describe('CONFIDENCE_LEGEND copy contract', () => {
  it('has a legend entry for every ring style in the drawing table', () => {
    expect(Object.keys(CONFIDENCE_LEGEND).sort()).toEqual(Object.keys(CONFIDENCE_RING).sort());
  });

  it('every entry explains the ring shape and carries a meaning', () => {
    for (const level of Object.keys(CONFIDENCE_LEGEND) as (keyof typeof CONFIDENCE_LEGEND)[]) {
      const entry = CONFIDENCE_LEGEND[level];
      expect(entry.ring.length, level).toBeGreaterThan(0);
      expect(entry.meaning.length, level).toBeGreaterThan(0);
      // 'solid' must only ever describe the fact ring — estimates are dashed.
      if (level === 'high') expect(entry.ring).toContain('solid');
      else expect(entry.ring).not.toContain('solid');
    }
  });

  it('tooltip body renders one row per ring style plus the position disclaimer', () => {
    const body = ConfidenceLegendBody();
    // body = root div whose children are [header, one row per level, disclaimer].
    const children = body.props.children as [
      { props: { children: string } },
      { key?: string | null; props: { children: unknown } }[],
      { props: { children: string[] } },
    ];
    expect(children.length).toBe(3);
    expect(children[1].length).toBe(Object.keys(CONFIDENCE_LEGEND).length);
    for (const level of Object.keys(CONFIDENCE_LEGEND)) {
      expect(children[1].map((row) => row.key)).toContain(level);
    }
    const disclaimer = children[2];
    const disclaimerText = typeof disclaimer.props.children === 'string'
      ? disclaimer.props.children
      : String(disclaimer.props.children);
    expect(disclaimerText).toContain('never exact router locations');
    expect(disclaimerText).toContain('GeoIP estimates');
    // Header states the encoding rule the rows then enumerate.
    expect(children[0].props.children).toContain('how well the location is known');
  });
});
