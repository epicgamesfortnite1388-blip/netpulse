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
  AL: [19.3, 21.1, 39.6, 42.7],
  AM: [43.4, 46.7, 38.8, 41.3],
  AT: [9.5, 17.2, 46.4, 49.0],
  AU: [112.9, 154.0, -39.2, -10.1],
  AZ: [44.8, 50.4, 38.4, 41.9],
  BE: [2.5, 6.4, 49.4, 51.6],
  BH: [50.2, 50.8, 25.5, 26.5],
  BG: [22.3, 28.7, 41.2, 44.3],
  BR: [-74.1, -32.5, -33.9, 5.4],
  BY: [23.1, 32.8, 51.2, 56.3],
  CA: [-141.1, -52.3, 41.6, 70.2],
  CH: [5.9, 10.6, 45.8, 48.0],
  CL: [-75.7, -66.4, -56.0, -17.4],
  CN: [73.5, 135.1, 18.1, 53.6],
  CZ: [12.1, 18.9, 48.5, 51.1],
  DE: [5.9, 15.1, 47.2, 55.1],
  DK: [8.1, 15.3, 54.5, 58.0],
  EE: [21.8, 28.2, 57.5, 59.7],
  EG: [24.7, 37.0, 21.8, 31.8],
  ES: [-9.4, 4.4, 35.9, 43.9],
  FI: [20.5, 31.6, 59.7, 70.2],
  FR: [-5.2, 9.6, 42.3, 51.2],
  GB: [-8.2, 2.0, 49.9, 59.5],
  GR: [19.3, 28.3, 34.8, 41.8],
  HK: [113.8, 114.5, 22.1, 22.6],
  HU: [16.1, 22.9, 45.7, 48.6],
  ID: [95.0, 141.0, -11.0, 6.1],
  IE: [-10.6, -5.9, 51.2, 55.5],
  IL: [34.2, 35.9, 29.4, 33.3],
  IN: [68.1, 97.5, 6.7, 35.6],
  IR: [44.0, 63.4, 24.8, 39.8],
  IT: [6.6, 18.6, 36.6, 47.1],
  JP: [122.9, 146.0, 24.2, 45.6],
  KR: [124.6, 131.0, 33.1, 38.7],
  KW: [46.5, 48.8, 28.5, 30.2],
  KZ: [46.4, 87.4, 40.5, 55.5],
  LT: [20.7, 26.9, 53.9, 56.4],
  LU: [5.7, 6.6, 49.4, 50.2],
  LV: [20.9, 28.2, 55.7, 58.1],
  MD: [26.6, 30.2, 45.4, 48.5],
  MX: [-117.2, -86.7, 14.5, 32.7],
  MY: [99.6, 104.5, 1.3, 7.4],
  NL: [3.3, 7.3, 50.7, 53.6],
  NO: [4.5, 31.2, 57.9, 71.3],
  OM: [51.8, 60.1, 16.6, 26.6],
  PH: [116.0, 126.6, 4.4, 19.0],
  PK: [60.9, 77.9, 23.7, 37.2],
  PL: [14.1, 24.2, 49.0, 54.9],
  PT: [-9.6, -6.2, 36.8, 42.2],
  QA: [50.7, 52.5, 24.5, 26.2],
  RO: [20.2, 29.8, 43.6, 48.3],
  RU: [19.6, 180.0, 41.2, 82.0],
  SA: [34.5, 56.0, 16.3, 32.2],
  SE: [11.0, 24.2, 55.3, 69.1],
  SG: [103.6, 104.1, 1.1, 1.5],
  SK: [16.8, 22.6, 47.7, 49.6],
  TH: [97.3, 105.6, 5.6, 20.5],
  TR: [25.6, 45.0, 35.8, 42.2],
  TW: [119.9, 122.1, 21.8, 25.4],
  UA: [22.1, 40.2, 44.3, 52.4],
  US: [-125.0, -66.9, 24.5, 49.5],
  UZ: [55.9, 73.2, 37.1, 45.7],
  VN: [102.1, 109.5, 8.2, 23.4],
  ZA: [16.4, 32.9, -34.9, -22.1],
};

export const COUNTRY_BBOX_MARGIN_DEG = 1.5;

/**
 * Every country value present in a real node database (2026-09-13, ~3,000
 * nodes — public sources + imports). Exported as an exact snapshot so tests
 * FAIL when live data introduces a country this table cannot judge: add the
 * missing box (or extend the override file) instead of silently degrading.
 */
export const LIVE_COUNTRIES: readonly string[] = [
  'AE', 'AL', 'AM', 'AT', 'AU', 'AZ', 'BE', 'BH', 'BG', 'BR', 'BY', 'CA',
  'CH', 'CL', 'CN', 'CZ', 'DE', 'DK', 'EE', 'EG', 'ES', 'FI', 'FR', 'GB',
  'GR', 'HK', 'HU', 'ID', 'IE', 'IL', 'IN', 'IR', 'IT', 'JP', 'KR', 'KW',
  'KZ', 'LT', 'LU', 'LV', 'MD', 'MX', 'MY', 'NL', 'NO', 'OM', 'PH', 'PK',
  'PL', 'PT', 'QA', 'RO', 'RU', 'SA', 'SE', 'SG', 'SK', 'TH', 'TR', 'TW',
  'UA', 'US', 'UZ', 'VN', 'ZA',
] as const;

/**
 * Sub-national boxes for territory that legitimately falls outside its
 * country's mainland box: US GeoIP answers in Alaska/Hawaii, and Russia's
 * far east across the antimeridian, are real places — not artifacts.
 */
const REGION_BOXES: Partial<Record<string, Array<[number, number, number, number]>>> = {
  US: [
    [-179.0, -129.9, 51.0, 71.6], // Alaska
    [-178.5, -154.5, 18.2, 28.6], // Hawaii
  ],
  MY: [[109.6, 119.3, 0.9, 7.9]], // Malaysia — Borneo (Sabah/Sarawak)
  PT: [
    [-31.6, -24.8, 36.8, 39.8], // Azores
    [-17.4, -16.1, 32.3, 33.3], // Madeira
  ],
  RU: [[-180.0, -169.0, 62.0, 71.5]], // Chukotka, west of the antimeridian
};

function insideBox(box: [number, number, number, number], lat: number, lon: number, marginDeg: number): boolean {
  const [minLon, maxLon, minLat, maxLat] = box;
  return lon >= minLon - marginDeg && lon <= maxLon + marginDeg && lat >= minLat - marginDeg && lat <= maxLat + marginDeg;
}

/**
 * True when the table carries any box (main or region) for `country`.
 * A false return means the runtime gate cannot judge verdicts for this
 * country — enrichment logs a coverage warning so gaps surface from live
 * data instead of silently degrading to "no box, no claim".
 */
export function hasCountryBox(country: string | null): boolean {
  if (country == null) return false;
  const cc = country.toUpperCase();
  return cc in COUNTRY_BBOX || cc in REGION_BOXES;
}

/**
 * True when (lat, lon) plausibly lies in `country`'s bounding box (with the
 * standard margin, plus sub-national region boxes where they exist).
 * Unknown countries return true — no box, no claim.
 */
export function inCountryBox(country: string | null, lat: number | null, lon: number | null, marginDeg = COUNTRY_BBOX_MARGIN_DEG): boolean {
  if (country == null || lat == null || lon == null) return true;
  const cc = country.toUpperCase();
  const box = COUNTRY_BBOX[cc];
  if (!box) return true;
  if (insideBox(box, lat, lon, marginDeg)) return true;
  for (const rb of REGION_BOXES[cc] ?? []) {
    if (insideBox(rb, lat, lon, marginDeg)) return true;
  }
  return false;
}
