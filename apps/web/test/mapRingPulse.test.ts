import { describe, expect, it } from 'vitest';

import { ringPulse } from '../src/features/map/MapCanvas';

/**
 * Selected-pin ripple geometry: the ring must expand out of the confidence
 * ring while fading, wrap cleanly at the cycle boundary, and never exceed
 * its alpha budget (emphasis, not glare).
 */
describe('ringPulse', () => {
  it('expands outward from the base confidence ring', () => {
    expect(ringPulse(1.9, 0).radiusFactor).toBeCloseTo(1.9);
    expect(ringPulse(1.9, 0.5).radiusFactor).toBeGreaterThan(ringPulse(1.9, 0.25).radiusFactor);
    expect(ringPulse(1.9, 0.5).radiusFactor).toBeGreaterThan(ringPulse(1.9, 0).radiusFactor);
  });

  it('fades monotonically to zero across the cycle', () => {
    let prev = ringPulse(1.9, 0).alpha;
    for (let t = 0.1; t < 1; t += 0.1) {
      const a = ringPulse(1.9, t).alpha;
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
    expect(ringPulse(1.9, 0.999).alpha).toBeLessThan(0.02);
  });

  it('respects the alpha budget (max 0.5, emphasis not glare)', () => {
    for (let t = 0; t < 1; t += 0.05) {
      expect(ringPulse(2.3, t).alpha).toBeLessThanOrEqual(0.5);
    }
  });

  it('wraps cleanly: phase 1 behaves like phase 0', () => {
    expect(ringPulse(1.9, 1).radiusFactor).toBeCloseTo(ringPulse(1.9, 0).radiusFactor);
    expect(ringPulse(1.9, 1).alpha).toBeCloseTo(ringPulse(1.9, 0).alpha);
    expect(ringPulse(1.9, 2.3).radiusFactor).toBeCloseTo(ringPulse(1.9, 0.3).radiusFactor);
  });

  it('scales with the pin size (r drives absolute radius)', () => {
    // The caller multiplies by r; the factor itself must stay in a sane
    // band so a high-zoom pulse never swallows the neighborhood.
    for (let t = 0; t < 1; t += 0.1) {
      const f = ringPulse(1.9, t).radiusFactor;
      expect(f).toBeGreaterThan(1.5);
      expect(f).toBeLessThan(3.2);
    }
  });
});
