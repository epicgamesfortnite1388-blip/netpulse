import * as THREE from 'three';

/**
 * Pure globe math: the lon/lat → 3D convention, great-circle arcs, and
 * camera anchors. Shared by the canvas and the tests so the projection has
 * exactly one definition.
 *
 * Convention (matches three.js SphereGeometry UV mapping for an equirectangular
 * Earth, so land rings and any texture agree):
 *   lon 0 / lat 0      → +X (Gulf of Guinea faces the default camera)
 *   lon +90°E / lat 0  → −Z
 *   lat +90°N          → +Y
 */

export const GLOBE_RADIUS = 10;

/**
 * Camera theta (azimuth) that puts `lon` at the center of the view.
 *
 * Facing condition, from the two conventions above (camera at
 * `(d sinφ cosθ, d cosφ, d sinφ sinθ)`, surface point at
 * `(−r sinφ cos(θg), r cosφ, r sinφ sin(θg))` with θg = lon+180°):
 * the sub-camera point satisfies `cosθ = −cos θg` and `sinθ = sin θg`,
 * i.e. `θ = π − θg = −lon`. (An earlier `-（lon+180°)` version aimed the
 * camera at the antipode — pins appeared ~180° away from center.)
 */
export function thetaForLon(lon: number): number {
  return -THREE.MathUtils.degToRad(lon);
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Geographic coordinate (degrees) → unit-ish sphere position. */
export function lonLatToVec3(lon: number, lat: number, radius: number = GLOBE_RADIUS): Vec3 {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

/** Ground distance (radians of arc) between two geographic points. */
export function greatCircleRadians(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = THREE.MathUtils.degToRad(aLat);
  const φ2 = THREE.MathUtils.degToRad(bLat);
  const Δφ = φ2 - φ1;
  const Δλ = THREE.MathUtils.degToRad(bLon - aLon);
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance in km (mean Earth radius 6371 km). */
export function greatCircleKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return greatCircleRadians(aLat, aLon, bLat, bLon) * 6371;
}

/**
 * Points along a great-circle arc from A to B, interpolated with slerp and
 * lifted off the surface in proportion to the arc length — the classic
 * "flight path" curve. Short arcs hug the surface; intercontinental arcs
 * rise high enough to read as routes, not tunnels.
 */
export function arcPoints(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
  segments = 48,
): Vec3[] {
  const start = lonLatToVec3(aLon, aLat);
  const end = lonLatToVec3(bLon, bLat);
  const omega = greatCircleRadians(aLat, aLon, bLat, bLon);
  if (omega < 1e-6) return [start, end];

  const sinOmega = Math.sin(omega);
  const alt = GLOBE_RADIUS * (1 + Math.min(0.45, 0.12 + omega * 0.18));
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const A = Math.sin((1 - t) * omega) / sinOmega;
    const B = Math.sin(t * omega) / sinOmega;
    const x = A * start.x + B * end.x;
    const y = A * start.y + B * end.y;
    const z = A * start.z + B * end.z;
    const len = Math.hypot(x, y, z) || 1;
    const lift = 1 + (alt / GLOBE_RADIUS - 1) * Math.sin(Math.PI * t);
    out.push({ x: (x / len) * GLOBE_RADIUS * lift, y: (y / len) * GLOBE_RADIUS * lift, z: (z / len) * GLOBE_RADIUS * lift });
  }
  return out;
}

/** Camera anchor for a geographic point (the position a globe looks FROM). */
export function cameraAnchorFor(lon: number, lat: number, distance: number = GLOBE_RADIUS * 2.6): Vec3 {
  const p = lonLatToVec3(lon, lat, distance);
  return p;
}

/** Screen-space size ratio for distance-based marker scaling. */
export function distanceScale(cameraDistance: number, pointDistance: number): number {
  return Math.max(0.35, Math.min(1.6, cameraDistance / Math.max(0.001, pointDistance)));
}

/**
 * Anchor point for a cluster of geographic positions: circular mean of the
 * unit vectors (correct across the antimeridian and at the poles — an
 * arithmetic mean of lon/lat is wrong at both).
 */
export function clusterAnchor(points: { lat: number; lon: number }[]): { lat: number; lon: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const v = lonLatToVec3(p.lon, p.lat, 1);
    x += v.x;
    y += v.y;
    z += v.z;
  }
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return points[0]!;
  const lat = THREE.MathUtils.radToDeg(Math.asin(y / len));
  const lon = THREE.MathUtils.radToDeg(Math.atan2(z, -x)) - 180;
  // atan2 range wrap: normalize back to (-180, 180]
  const norm = ((lon + 540) % 360) - 180;
  return { lat, lon: norm === -180 ? 180 : norm };
}

/** Perceptual color ramp for measured latency (ms) — the arc/marker palette. */
export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return '#64748b'; // unknown
  if (ms < 60) return '#34d399'; // excellent
  if (ms < 120) return '#22d3ee'; // good
  if (ms < 220) return '#fbbf24'; // fair
  return '#f87171'; // poor
}
