import * as THREE from 'three';

/**
 * Pure globe math + the honest marker/tooltip encoding shared by the canvas
 * and the tests. Since the renderer moved to react-globe.gl (which owns
 * picking, orbit and fly-to), this module keeps only what remains ours:
 * great-circle geometry and the content contract of every pin and tooltip.
 *
 * Convention (matches three-globe's own lat/lng → position mapping, so any
 * raw three.js math we keep agrees with what the library renders):
 *   lat 0 / lng 0      → +X (Gulf of Guinea faces the default camera)
 *   lat 0 / lng +90°E  → −Z
 *   lat +90°N          → +Y
 */

export const GLOBE_RADIUS = 10;

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
  let lon = THREE.MathUtils.radToDeg(Math.atan2(z, -x)) - 180;
  // atan2 range wrap: normalize back to (-180, 180]
  lon = ((lon + 540) % 360) - 180;
  return { lat, lon: lon === -180 ? 180 : lon };
}

/** Perceptual color ramp for measured latency (ms) — the arc/marker palette. */
export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return '#64748b'; // unknown
  if (ms < 60) return '#34d399'; // excellent
  if (ms < 120) return '#22d3ee'; // good
  if (ms < 220) return '#fbbf24'; // fair
  return '#f87171'; // poor
}

/* --------------------------- globe.gl encoding ---------------------------- */

/** Camera altitude → the zoom proxy LiveMapPage uses for clustering. */
export function zoomProxyFromAltitude(altitude: number): number {
  // dist = R·(1 + altitude); the old canvas reported (R·3.2)/dist.
  return Math.max(0.5, Math.min(8, 3.2 / (1 + Math.max(0, altitude))));
}

/** Marker color: kind first, then measured status (never decorative). */
export function nodePointColor(node: { kind: string; status: string; cluster?: number }): string {
  if (node.kind === 'you') return '#a78bfa';
  if (node.kind === 'vpn') return '#fbbf24';
  if (node.kind === 'hop') return '#94a3b8';
  if (node.cluster != null) return '#38bdf8';
  switch (node.status) {
    case 'excellent':
      return '#34d399';
    case 'good':
      return '#22d3ee';
    case 'fair':
      return '#fbbf24';
    case 'poor':
    case 'unreachable':
      return '#f87171';
    default:
      return '#64748b';
  }
}

/** Marker radius: big enough to hover reliably (3-4 px pins made hover luck). */
export function nodePointRadius(node: { kind: string; cluster?: number }): number {
  if (node.kind === 'you') return 1.15;
  if (node.cluster != null) return 0.95;
  if (node.kind === 'hop') return 0.5;
  return 0.8;
}

/**
 * Honest tooltip for a globe pin. HTML string — globe.gl renders it in its
 * own floating tooltip, positioned by the library (the piece our hand-rolled
 * overlay kept getting wrong).
 */
export function nodeTooltipHtml(node: {
  label: string;
  sub?: string | null;
  latencyMs: number | null;
  status: string;
  geoConfidence?: string;
  cluster?: number;
}): string {
  const rows: string[] = [];
  if (node.cluster != null) {
    // Cluster pins: the label IS the count — no duplicate count line.
    rows.push(`<div style="font-weight:600;color:#38bdf8">${node.cluster} nodes</div>`);
    rows.push(`<div style="font-size:10px;color:#38bdf8">click to expand</div>`);
  } else {
    rows.push(`<div style="font-weight:600;color:#e2e8f0">${esc(node.label)}</div>`);
    if (node.sub) rows.push(`<div style="font-family:monospace;font-size:10px;color:#8ea2bd">${esc(node.sub)}</div>`);
    // sub-ms RTTs are real (tunnel/colo-local): keep the decimal so the
    // tooltip never rounds a truthful 0.4 ms to "0 ms"
    const latency =
      node.latencyMs != null
        ? `<span style="font-family:monospace">${node.latencyMs < 10 ? node.latencyMs.toFixed(1) : Math.round(node.latencyMs)} ms</span>`
        : null;
    const bits = [latency, `<span style="color:#64748b">${esc(node.status)}</span>`].filter(Boolean);
    if (bits.length) rows.push(`<div style="font-size:10px">${bits.join(' · ')}</div>`);
  }
  if (node.geoConfidence && node.geoConfidence !== 'unknown') {
    rows.push(`<div style="color:#64748b;font-size:10px">${esc(node.geoConfidence)} geo</div>`);
  }
  return `<div style="max-width:224px;line-height:1.4">${rows.join('')}</div>`;
}

/** Tooltip for an endpoint-to-endpoint arc (labelled as the approximation it is). */
export function arcTooltipHtml(arc: { kind: string; latencyMs: number | null; lossPct: number | null }): string {
  const kind =
    arc.kind === 'vpn'
      ? 'through VPN'
      : arc.kind === 'historical'
        ? 'historical snapshot'
        : 'approximate endpoint-to-endpoint path';
  const bits = [`<div style="font-weight:600;color:#e2e8f0">${kind}</div>`];
  if (arc.latencyMs != null) bits.push(`<div style="font-family:monospace;font-size:10px">latency ${Math.round(arc.latencyMs)} ms</div>`);
  if (arc.lossPct != null) bits.push(`<div style="font-family:monospace;font-size:10px">loss ${arc.lossPct.toFixed(1)}%</div>`);
  return `<div style="line-height:1.4">${bits.join('')}</div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
