import { describe, expect, it } from 'vitest';

import { worldLandBounds, worldLandRings } from '../src/geo/worldLandDecode';

describe('world land data', () => {
  it('decodes a non-trivial number of rings (real continents, not a stub)', () => {
    const rings = worldLandRings();
    expect(rings.length).toBeGreaterThan(50);
    expect(rings.length).toBeLessThan(300);
  });

  it('every ring is a closed polygon with at least 4 points', () => {
    for (const ring of worldLandRings()) {
      expect(ring.length).toBeGreaterThanOrEqual(4);
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      expect(Math.abs(first[0] - last[0])).toBeLessThan(1.5);
      expect(Math.abs(first[1] - last[1])).toBeLessThan(1.5);
    }
  });

  it('all coordinates are within valid lon/lat ranges (no float drift)', () => {
    for (const ring of worldLandRings()) {
      for (const [lon, lat] of ring) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
    }
  });

  it('covers the world: bounds span all major continents', () => {
    const b = worldLandBounds();
    expect(b.minLon).toBeLessThan(-100); // Americas
    expect(b.maxLon).toBeGreaterThan(120); // Asia / Australia
    expect(b.minLat).toBeLessThan(-30); // southern land
    expect(b.maxLat).toBeGreaterThan(60); // northern land
  });

  it('contains coastal points on each major continent (sanity anchors)', () => {
    const rings = worldLandRings();
    const has = (lon: number, lat: number) =>
      rings.some((ring) => ring.some(([x, y]) => Math.abs(x - lon) < 4 && Math.abs(y - lat) < 4));
    expect(has(-80, 25)).toBe(true); // Florida coast
    expect(has(0, 51)).toBe(true); // English channel
    expect(has(122, 31)).toBe(true); // Shanghai coast
    expect(has(18, -34)).toBe(true); // Cape of Good Hope
    expect(has(151, -34)).toBe(true); // Sydney
    expect(has(-45, -23)).toBe(true); // Rio coast
  });

  it('decoded data is shared by reference (single decode)', () => {
    expect(worldLandRings()).toBe(worldLandRings());
  });
});