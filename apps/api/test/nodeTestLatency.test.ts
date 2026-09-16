import { describe, expect, it } from 'vitest';

import { tenthsOfMs } from '../src/services/nodesService';

/**
 * TCP/TLS test latency arithmetic.
 *
 * The expression this replaces was `Math.round(elapsed / 100) / 10` — a divide
 * by 1000 — so a 45 ms handshake was stored and displayed as `0 ms` and a
 * 1.2 s one as `1.2 ms`. It was caught live: a scan reported a remote TLS
 * handshake at "0 ms" as the winning candidate's measured latency. The app
 * presents these numbers as measurements, so the scale has to be right.
 */
describe('tenthsOfMs', () => {
  it('reports whole milliseconds when a whole number of them elapsed', () => {
    expect(tenthsOfMs(45)).toBe(45);
    expect(tenthsOfMs(123)).toBe(123);
    expect(tenthsOfMs(1234)).toBe(1234);
    expect(tenthsOfMs(2600)).toBe(2600);
  });

  it('keeps a tenth of a millisecond of resolution and no more', () => {
    expect(tenthsOfMs(45.27)).toBe(45.3);
    expect(tenthsOfMs(0.04)).toBe(0);
    expect(tenthsOfMs(0)).toBe(0);
  });

  it('never collapses a realistic connect time to zero', () => {
    // The exact symptom observed: a sub-50 ms handshake shown as 0 ms.
    for (const elapsed of [1, 12, 45, 49]) {
      expect(tenthsOfMs(elapsed)).toBeGreaterThan(0);
    }
  });

  it('reports the elapsed time itself, which the old expression did not', () => {
    const previous = (elapsed: number) => Math.round(elapsed / 100) / 10;
    for (const elapsed of [45, 123, 450, 1234]) {
      expect(tenthsOfMs(elapsed)).toBeCloseTo(elapsed, 1);
      // the old expression reported elapsed/1000
      expect(previous(elapsed)).toBeLessThan(elapsed / 100);
    }
  });
});
