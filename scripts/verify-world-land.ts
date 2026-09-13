/** Verify decoded land rings line up with real-world geography.
 *  Australia must appear near lon 113..153E, lat -39..-10S. Run: npx tsx scripts/verify-world-land.ts */
import { LAND_RINGS } from '../packages/shared/src/geo/worldLand';
import { worldLandRings } from '../packages/shared/src/geo/worldLandDecode';

const rings = worldLandRings();
console.log('ring count:', rings.length);

// Decode first point of every ring to absolute lon/lat and find overall bounds.
let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
for (const ring of rings) {
  for (const [lon, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
}
console.log('bounds: lat', minLat.toFixed(1), '..', maxLat.toFixed(1), ' lon', minLon.toFixed(1), '..', maxLon.toFixed(1));

// Locate a landmass in the Australian window (lon 113..154, lat -39..-10).
const auRings = rings.filter((ring) =>
  ring.some(([lon, lat]) => lon > 113 && lon < 154 && lat > -39 && lat < -10),
);
console.log('rings intersecting Australia window:', auRings.length);
if (auRings.length === 0) {
  // Where did Australia's data actually end up? Sample a broad sweep.
  console.log('FAIL: no land found in Australia window');
  // Print where southern-hemisphere land (lat < -10) actually is.
  const south = rings.filter((ring) => ring.some(([, lat]) => lat < -10));
  for (const ring of south.slice(0, 5)) {
    const lats = ring.map(([, lat]) => lat);
    const lons = ring.map(([lon]) => lon);
    console.log('  south ring: lat', Math.min(...lats).toFixed(1), '..', Math.max(...lats).toFixed(1),
      'lon', Math.min(...lons).toFixed(1), '..', Math.max(...lons).toFixed(1));
  }
} else {
  console.log('PASS: Australia landmass present in correct window');
}

// Sanity anchors
const anchors: Array<[string, number, number, number]> = [
  ['Frankfurt', 8.68, 50.11, 3],
  ['Tehran', 51.39, 35.69, 3],
  ['New York', -74.0, 40.71, 3],
];
for (const [name, lon, lat, tolDeg] of anchors) {
  const near = rings.some((ring) => ring.some(([lo, la]) => Math.abs(lo - lon) < tolDeg * 2 && Math.abs(la - lat) < tolDeg));
  console.log(`${name}: land within ~${tolDeg}deg?`, near ? 'yes' : 'NO (ocean?)');
}
