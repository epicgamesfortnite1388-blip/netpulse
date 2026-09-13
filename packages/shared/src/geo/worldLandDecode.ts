import { LAND_RINGS } from './worldLand';

/**
 * Decode the delta-encoded, tenths-of-degree land rings into absolute
 * lon/lat point arrays (closed: the first point is repeated at the end).
 * Decoded once per process and shared by reference — the data is immutable.
 */
let decoded: [number, number][][] | null = null;

export function worldLandRings(): [number, number][][] {
  if (decoded) return decoded;
  const out: [number, number][][] = [];
  for (const flat of LAND_RINGS) {
    const ring: [number, number][] = [];
    // accumulate in integer tenths-of-degree (exact) — float accumulation of
    // 0.1 steps drifts (e.g. 180.00000000000006) and breaks bounds clamping
    let lonT = flat[0]!;
    let latT = flat[1]!;
    ring.push([lonT / 10, latT / 10]);
    for (let i = 2; i < flat.length; i += 2) {
      lonT += flat[i]!;
      latT += flat[i + 1]!;
      ring.push([lonT / 10, latT / 10]);
    }
    out.push(ring);
  }
  decoded = out;
  return out;
}

/** Bounding box sanity: all decoded coordinates must be within lon [-180,180], lat [-90,90]. */
export function worldLandBounds(): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const ring of worldLandRings()) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}
