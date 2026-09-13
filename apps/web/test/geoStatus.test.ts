import { describe, expect, it } from 'vitest';

import { GEO_STATUS_COPY, geoReasonOf } from '../src/lib/geoStatus';

/**
 * The geo-honesty explainer must render the same copy on every surface
 * (node detail card, explorer list rows, map destination panel), and derive
 * the reason when a caller's data predates the geoStatusReason field.
 */
describe('geoReasonOf', () => {
  it('keeps an explicit reason', () => {
    expect(geoReasonOf('anycast', false)).toBe('anycast');
    expect(geoReasonOf('edge_fabric', false)).toBe('edge_fabric');
    expect(geoReasonOf('lookup_failed', false)).toBe('lookup_failed');
    expect(geoReasonOf('pending', false)).toBe('pending');
    expect(geoReasonOf('known', true)).toBe('known');
  });

  it('derives known from coordinates when the field is absent (older DTOs)', () => {
    expect(geoReasonOf(null, true)).toBe('known');
    expect(geoReasonOf(undefined, true)).toBe('known');
  });

  it('derives pending when there is no field and no coordinates', () => {
    expect(geoReasonOf(null, false)).toBe('pending');
    expect(geoReasonOf(undefined, false)).toBe('pending');
  });
});

describe('GEO_STATUS_COPY', () => {
  it('covers every reason with all three copy fields', () => {
    for (const reason of ['known', 'anycast', 'edge_fabric', 'lookup_failed', 'pending'] as const) {
      const copy = GEO_STATUS_COPY[reason];
      expect(copy.short, reason).toBeTruthy();
      expect(copy.title, reason).toBeTruthy();
      expect(copy.detail, reason).toBeTruthy();
    }
  });

  it('explains anycast and edge fabric as refusals, not missing data', () => {
    expect(GEO_STATUS_COPY.anycast.title).toMatch(/no single location/i);
    expect(GEO_STATUS_COPY.edge_fabric.title).toMatch(/edge network/i);
    // The honesty contract: these say Unknown is deliberate.
    expect(GEO_STATUS_COPY.anycast.detail).toMatch(/confident lie/);
  });
});
