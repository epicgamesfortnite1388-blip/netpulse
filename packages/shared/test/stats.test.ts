import { describe, expect, it } from 'vitest';

import { jitterMs, lossPct, median, mean, round } from '../src/net/stats';

describe('mean', () => {
  it('returns null for empty input', () => {
    expect(mean([])).toBeNull();
  });
  it('computes the arithmetic mean', () => {
    expect(mean([10, 20, 30])).toBe(20);
  });
});

describe('median', () => {
  it('returns null for empty input', () => {
    expect(median([])).toBeNull();
  });
  it('returns the middle value for odd counts', () => {
    expect(median([30, 10, 20])).toBe(20);
  });
  it('returns the average of the two middle values for even counts', () => {
    expect(median([10, 40, 20, 30])).toBe(25);
  });
  it('handles a single sample', () => {
    expect(median([42])).toBe(42);
  });
});

describe('jitterMs', () => {
  it('returns null when fewer than 2 samples', () => {
    expect(jitterMs([])).toBeNull();
    expect(jitterMs([10])).toBeNull();
  });
  it('returns 0 for identical samples', () => {
    expect(jitterMs([10, 10, 10])).toBe(0);
  });
  it('computes mean absolute successive difference', () => {
    // diffs: |12-10|=2, |9-12|=3, |11-9|=2 -> (2+3+2)/3
    expect(round(jitterMs([10, 12, 9, 11]) as number, 3)).toBe(2.333);
  });
});

describe('lossPct', () => {
  it('computes zero loss', () => {
    expect(lossPct(4, 4)).toBe(0);
  });
  it('computes partial loss', () => {
    expect(lossPct(4, 3)).toBe(25);
  });
  it('computes total loss', () => {
    expect(lossPct(4, 0)).toBe(100);
  });
  it('guards against divide-by-zero', () => {
    expect(lossPct(0, 0)).toBe(0);
  });
  it('clamps to 0-100', () => {
    expect(lossPct(4, 5)).toBe(0);
  });
});
