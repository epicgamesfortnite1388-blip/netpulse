import { describe, expect, it } from 'vitest';

import { calibrationDisplay, formatNats, formatShift, toRows } from './hypothesisView';

describe('toRows', () => {
  it('orders by posterior and keeps each prior paired with its hypothesis', () => {
    const rows = toRows([
      { label: 'dns', prior: 0.25, posterior: 0.1 },
      { label: 'tcp', prior: 0.25, posterior: 0.7 },
      { label: 'tls', prior: 0.5, posterior: 0.2 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['tcp', 'tls', 'dns']);
    expect(rows.map((r) => r.prior)).toEqual([0.25, 0.5, 0.25]);
  });

  it('reports the move away from the prior', () => {
    const [row] = toRows([{ label: 'dns', prior: 0.25, posterior: 0.6 }]);
    expect(row!.shift).toBeCloseTo(0.35, 10);
    expect(row!.posteriorPct).toBeCloseTo(60, 10);
    expect(row!.priorPct).toBeCloseTo(25, 10);
  });

  it('clamps out-of-range and non-finite probabilities for rendering', () => {
    const [row] = toRows([{ label: 'x', prior: Number.NaN, posterior: 1.4 }]);
    expect(row!.posteriorPct).toBe(100);
    expect(row!.priorPct).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [
      { label: 'a', prior: 0.5, posterior: 0.2 },
      { label: 'b', prior: 0.5, posterior: 0.8 },
    ];
    toRows(input);
    expect(input[0]!.label).toBe('a');
  });
});

describe('calibrationDisplay', () => {
  const map = { label: 'dns', prior: 0.1, posterior: 0.62 };

  it('never presents a self-derived map as calibrated confidence', () => {
    const display = calibrationDisplay({
      map_label: 'dns',
      hypotheses: [map],
      map_confidence_calibrated: 0.41,
      calibration_samples: 42,
    });
    expect(display!.calibrated).toBe(false);
    expect(display!.confidence).toBeCloseTo(0.62, 10);
    expect(display!.note).toContain('not externally calibrated');
    expect(display!.note).not.toContain('calibrated on');
  });

  it("falls back to the MAP's own posterior when no map is fitted", () => {
    const display = calibrationDisplay({
      map_label: 'dns',
      hypotheses: [map],
      map_confidence_calibrated: null,
      calibration_samples: 5,
    });
    expect(display!.calibrated).toBe(false);
    expect(display!.confidence).toBeCloseTo(0.62, 10);
    expect(display!.note).toContain('5 internal consistency checks');
  });

  it('renders nothing without a MAP hypothesis', () => {
    expect(
      calibrationDisplay({
        map_label: null,
        hypotheses: [],
        map_confidence_calibrated: null,
        calibration_samples: 0,
      }),
    ).toBeNull();
  });
});

describe('formatters', () => {
  it('formats information gain in nats', () => {
    expect(formatNats(0.4321)).toBe('0.432 nats');
    expect(formatNats(0)).toBe('0.000 nats');
    expect(formatNats(Number.POSITIVE_INFINITY)).toBe('unavailable');
  });

  it('signs the prior-to-posterior shift in percentage points', () => {
    expect(formatShift(0.124)).toBe('+12.4 pp');
    expect(formatShift(-0.05)).toBe('-5.0 pp');
    expect(formatShift(0)).toBe('+0.0 pp');
  });
});
