#!/usr/bin/env node
/**
 * One-shot generator: Natural Earth 110m land GeoJSON -> compact bundled TS.
 *
 * - Douglas-Peucker simplification per ring (tolerance in degrees)
 * - quantize to 0.1 degrees and delta-encode as integers
 * - split antimeridian-crossing rings at +/-180
 * - output: packages/shared/src/geo/worldLand.ts
 *
 * Source data is public domain (Natural Earth). The generated file carries
 * the same license; the source URL is recorded in the header comment.
 */
import fs from 'node:fs';

const SRC = process.argv[2] ?? '/tmp/ne_110m_land.geojson';
const OUT = 'packages/shared/src/geo/worldLand.ts';
const TOL = 0.55; // degrees — 110m-scale detail; smaller = more points

function dpSimplify(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const [x1, y1] = pts[lo];
    const [x2, y2] = pts[hi];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = -1, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const [x, y] = pts[i];
      const d = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function splitAntimeridian(ring) {
  const out = [];
  let cur = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [x] = ring[i];
    const [px] = ring[i - 1];
    if (Math.abs(x - px) > 180) {
      // crossing: cut the segment at +/-180 on both sides
      const dir = x > px ? 1 : -1;
      const edge = dir > 0 ? 180 : -180;
      const backEdge = dir > 0 ? -180 : 180;
      const [lx, ly] = ring[i - 1];
      const [rx, ry] = ring[i];
      // param over the unwrapped span (the short way around)
      let span = rx - lx;
      if (span > 180) span -= 360;
      if (span < -180) span += 360;
      const tt = (edge - lx) / span;
      const yAt = ly + (ry - ly) * tt;
      cur.push([edge, yAt]);
      out.push(cur);
      cur = [[backEdge, yAt], ring[i]];
    } else {
      cur.push(ring[i]);
    }
  }
  out.push(cur);
  return out;
}

// ---- load + flatten GeoJSON polygons ----
const gj = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const rawRings = [];
const pushRing = (ring) => {
  const pts = ring.map(([lon, lat]) => [lon, lat]);
  // GeoJSON rings repeat the first point at the end — strip it so DP sees an
  // open polyline (a closed chord of zero length collapses every ring).
  if (pts.length >= 4) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) pts.pop();
    if (pts.length >= 4) rawRings.push(pts);
  }
};
for (const f of gj.features) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'Polygon') for (const r of g.coordinates) pushRing(r);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) pushRing(r);
}

// ---- simplify + split + quantize ----
const enc = [];
let totalPts = 0;
for (const ring of rawRings) {
  const simple = dpSimplify(ring, TOL);
  for (const piece of splitAntimeridian(simple)) {
    if (piece.length < 4) continue;
    // quantize to 0.1deg, delta-encode; re-close the ring explicitly
    const q = piece.map(([lon, lat]) => [Math.round(lon * 10), Math.round(lat * 10)]);
    const flat = [q[0][0], q[0][1]];
    for (let i = 1; i < q.length; i++) {
      flat.push(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
    }
    // close the ring back to its first point
    flat.push(q[0][0] - q[q.length - 1][0], q[0][1] - q[q.length - 1][1]);
    enc.push(flat);
    totalPts += q.length + 1;
  }
}

// ---- emit ----
const header = `/**
 * Bundled world land outlines for the Live Map background.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   node scripts/gen-world-land.mjs /tmp/ne_110m_land.geojson
 *
 * Source: Natural Earth 110m land polygons — https://www.naturalearthdata.com/
 * (public domain). Simplified (Douglas-Peucker ${TOL}deg), quantized to 0.1deg,
 * delta-encoded. Rings crossing the antimeridian are split at +/-180.
 *
 * Format: LAND_RINGS[r] = flat delta-encoded [lon,lat,...] tenths-of-degree,
 * closed rings, equirectangular (lon -> x, lat -> y linear).
 */
export const LAND_RINGS: number[][] = `;
const body = JSON.stringify(enc).replace(/(\[-?\d+)(,\[-?\d+)/g, '$1,\n$2');
const tail = ';\n';
fs.mkdirSync('packages/shared/src/geo', { recursive: true });
fs.writeFileSync(OUT, header + body + tail);
console.log(`wrote ${OUT}: ${enc.length} rings, ${totalPts} points, ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
