/**
 * Per-country bounding boxes for map-plausibility checks.
 *
 * A pin's coordinates must fall inside its claimed country's box — a
 * "Cloudflare IP in Australia" style artifact (registry HQ, wrong continent,
 * swapped lat/lon) fails this check. Boxes are generous (country extents
 * plus margin) so a failure means genuinely implausible data, not a
 * borderline GeoIP drift.
 *
 * Boxes: [minLon, maxLon, minLat, maxLat] in degrees. The check applies a
 * default 1.5° margin on top to cover offshore islands and small nations'
 * centroids placed in neighboring seas.
 */
export const COUNTRY_BBOX: Record<string, [number, number, number, number]> = {
  AE: [51.5, 56.5, 22.5, 26.5],
  AT: [9.5, 17.2, 46.4, 49.0],
  AU: [112.9, 154.0, -39.2, -10.1],
  BE: [2.5, 6.4, 49.4, 51.6],
  BG: [22.3, 28.7, 41.2, 44.3],
  BR: [-74.1, -32.5, -33.9, 5.4],
  BY: [23.1, 32.8, 51.2, 56.3],
  CA: [-141.1, -52.3, 41.6, 70.2],
  CH: [5.9, 10.6, 45.8, 48.0],
  CN: [73.5, 135.1, 18.1, 53.6],
  CZ: [12.1, 18.9, 48.5, 51.1],
  DE: [5.9, 15.1, 47.2, 55.1],
  DK: [8.1, 15.3, 54.5, 58.0],
  EG: [24.7, 37.0, 21.8, 31.8],
  ES: [-9.4, 4.4, 35.9, 43.9],
  FI: [20.5, 31.6, 59.7, 70.2],
  FR: [-5.2, 9.6, 42.3, 51.2],
  GB: [-8.2, 2.0, 49.9, 59.5],
  GR: [19.3, 28.3, 34.8, 41.8],
  HK: [113.8, 114.5, 22.1, 22.6],
  HU: [16.1, 22.9, 45.7, 48.6],
  IL: [34.2, 35.9, 29.4, 33.3],
  IN: [68.1, 97.5, 6.7, 35.6],
  IR: [44.0, 63.4, 24.8, 39.8],
  IT: [6.6, 18.6, 36.6, 47.1],
  JP: [122.9, 146.0, 24.2, 45.6],
  KR: [124.6, 131.0, 33.1, 38.7],
  KW: [46.5, 48.8, 28.5, 30.2],
  KZ: [46.4, 87.4, 40.5, 55.5],
  LU: [5.7, 6.6, 49.4, 50.2],
  NL: [3.3, 7.3, 50.7, 53.6],
  NO: [4.5, 31.2, 57.9, 71.3],
  OM: [51.8, 60.1, 16.6, 26.6],
  PK: [60.9, 77.9, 23.7, 37.2],
  PL: [14.1, 24.2, 49.0, 54.9],
  QA: [50.7, 52.5, 24.5, 26.2],
  RO: [20.2, 29.8, 43.6, 48.3],
  RU: [19.6, 180.0, 41.2, 82.0],
  SA: [34.5, 56.0, 16.3, 32.2],
  SE: [11.0, 24.2, 55.3, 69.1],
  SG: [103.6, 104.1, 1.1, 1.5],
  SK: [16.8, 22.6, 47.7, 49.6],
  TR: [25.6, 45.0, 35.8, 42.2],
  TW: [119.9, 122.1, 21.8, 25.4],
  UA: [22.1, 40.2, 44.3, 52.4],
  US: [-125.0, -66.9, 24.5, 49.5],
  UZ: [55.9, 73.2, 37.1, 45.7],
  ZA: [16.4, 32.9, -34.9, -22.1],
};

export const COUNTRY_BBOX_MARGIN_DEG = 1.5;

/**
 * True when (lat, lon) plausibly lies in `country`'s bounding box (with the
 * standard margin). Unknown countries return true — no box, no claim.
 */
export function inCountryBox(country: string | null, lat: number | null, lon: number | null, marginDeg = COUNTRY_BBOX_MARGIN_DEG): boolean {
  if (country == null || lat == null || lon == null) return true;
  const box = COUNTRY_BBOX[country.toUpperCase()];
  if (!box) return true;
  const [minLon, maxLon, minLat, maxLat] = box;
  return lon >= minLon - marginDeg && lon <= maxLon + marginDeg && lat >= minLat - marginDeg && lat <= maxLat + marginDeg;
}
