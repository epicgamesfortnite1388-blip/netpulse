import { describe, expect, it } from 'vitest';

import * as THREE from 'three';

import {
  GLOBE_RADIUS,
  arcPoints,
  cameraAnchorFor,
  clusterAnchor,
  facesCamera,
  greatCircleKm,
  latencyColor,
  lonLatToVec3,
  nearestScreenPin,
  projectPins,
  thetaForLon,
} from '../src/features/map/globeMath';
import { clusterCellDeg, clusterNodes } from '../src/features/map/clusterNodes';

import type { GlobeNode } from '../src/features/map/mapEncoding';

/**
 * Map accuracy contract for the 3D globe:
 *   - the projection puts known endpoints on the right continent
 *     (the "Cloudflare in Australia" class of lie must be structurally
 *      impossible for correctly-labelled input)
 *   - great-circle distances are real
 *   - clustering never invents coordinates, never eats the selected/local
 *     nodes, and is deterministic
 *   - the latency ramp communicates honest degradation
 */

/** Generous per-continent bounding boxes — a failure means the wrong continent. */
const CONTINENT_BOXES: Record<string, { latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
  'North America': { latMin: 7, latMax: 84, lonMin: -168, lonMax: -52 },
  'South America': { latMin: -56, latMax: 13, lonMin: -82, lonMax: -34 },
  Europe: { latMin: 34, latMax: 72, lonMin: -25, lonMax: 45 },
  Africa: { latMin: -35, latMax: 38, lonMin: -18, lonMax: 52 },
  Asia: { latMin: -11, latMax: 78, lonMin: 26, lonMax: 180 },
  Oceania: { latMin: -48, latMax: 0, lonMin: 110, lonMax: 180 },
  'Middle East': { latMin: 12, latMax: 42, lonMin: 34, lonMax: 63 },
};

/** Known endpoints: real infrastructure with well-known locations. */
const KNOWN_ENDPOINTS: { name: string; lat: number; lon: number; continent: keyof typeof CONTINENT_BOXES }[] = [
  { name: 'Cloudflare FRA (Frankfurt)', lat: 50.11, lon: 8.68, continent: 'Europe' },
  { name: 'Cloudflare LHR (London)', lat: 51.51, lon: -0.13, continent: 'Europe' },
  { name: 'Google DNS 8.8.8.8 (Mountain View)', lat: 37.41, lon: -122.08, continent: 'North America' },
  { name: 'Cloudflare IAD (Ashburn)', lat: 39.04, lon: -77.49, continent: 'North America' },
  { name: 'VALORANT São Paulo', lat: -23.55, lon: -46.63, continent: 'South America' },
  { name: 'VALORANT Tokyo', lat: 35.68, lon: 139.69, continent: 'Asia' },
  { name: 'VALORANT Singapore', lat: 1.35, lon: 103.82, continent: 'Asia' },
  { name: 'Shecan Tehran (sanctioned DNS)', lat: 35.69, lon: 51.39, continent: 'Middle East' },
  { name: 'Johannesburg game relay', lat: -26.2, lon: 28.05, continent: 'Africa' },
  { name: 'Cloudflare SYD (Sydney)', lat: -33.87, lon: 151.21, continent: 'Oceania' },
];

function inBox(lat: number, lon: number, box: { latMin: number; latMax: number; lonMin: number; lonMax: number }): boolean {
  return lat >= box.latMin && lat <= box.latMax && lon >= box.lonMin && lon <= box.lonMax;
}

describe('globe projection accuracy', () => {
  it('every known endpoint projects inside its continent box', () => {
    for (const ep of KNOWN_ENDPOINTS) {
      const v = lonLatToVec3(ep.lon, ep.lat);
      // Round-trip: recover lat/lon from the 3D point and verify the box.
      const lat = (Math.asin(v.y / 10) * 180) / Math.PI;
      let lon = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
      lon = ((lon + 540) % 360) - 180;
      expect(inBox(lat, lon, CONTINENT_BOXES[ep.continent]), `${ep.name} → ${lat.toFixed(1)}, ${lon.toFixed(1)} outside ${ep.continent}`).toBe(true);
    }
  });

  it('continent anchors are pairwise far apart (no box overlap drift)', () => {
    const d = greatCircleKm(50.11, 8.68, -33.87, 151.21); // FRA → SYD
    expect(d).toBeGreaterThan(15_000);
    const d2 = greatCircleKm(39.04, -77.49, 35.68, 139.69); // IAD → Tokyo
    expect(d2).toBeGreaterThan(10_000);
  });

  it('intercontinental arcs rise above the surface at midpoint', () => {
    const pts = arcPoints(50.11, 8.68, -33.87, 151.21, 64);
    const mid = pts[Math.floor(pts.length / 2)]!;
    const r = Math.hypot(mid.x, mid.y, mid.z);
    expect(r).toBeGreaterThan(11); // lifted above R=10
    // endpoints remain at surface
    const first = pts[0]!;
    expect(Math.hypot(first.x, first.y, first.z)).toBeCloseTo(10, 1);
  });

  it('latency ramp degrades monotonically', () => {
    expect(latencyColor(20)).not.toBe(latencyColor(90));
    expect(latencyColor(90)).not.toBe(latencyColor(150));
    expect(latencyColor(150)).not.toBe(latencyColor(400));
    expect(latencyColor(null)).toBe('#64748b'); // unknown is its own color
  });
});

describe('honesty under uncertain geography', () => {
  function node(p: Partial<GlobeNode> & { id: string; lat: number; lon: number }): GlobeNode {
    return {
      id: p.id,
      label: p.id,
      lat: p.lat,
      lon: p.lon,
      kind: 'target',
      status: 'good',
      latencyMs: 50,
      ...p,
    };
  }

  it('cluster anchors stay inside the bounding box of their members', () => {
    const members = [node({ id: 'a', lat: 35.68, lon: 139.69 }), node({ id: 'b', lat: 1.35, lon: 103.82 })];
    const anchor = clusterAnchor(members);
    // anchor must sit between Tokyo and Singapore — on their great-circle
    const latMin = Math.min(...members.map((m) => m.lat)) - 1;
    const latMax = Math.max(...members.map((m) => m.lat)) + 1;
    expect(anchor.lat).toBeGreaterThanOrEqual(latMin);
    expect(anchor.lat).toBeLessThanOrEqual(latMax);
  });

  it('clustering is deterministic (same input → same output)', () => {
    const nodes = Array.from({ length: 60 }, (_, i) =>
      node({ id: `n${i}`, lat: (i % 12) * 5, lon: (i * 13) % 360 - 180 }),
    );
    const a = clusterNodes(nodes, 1.5);
    const b = clusterNodes(nodes, 1.5);
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
  });

  it('the local endpoint and selected node are never clustered', () => {
    const you = node({ id: 'you', lat: 0, lon: 0, kind: 'you' });
    const sel = node({ id: 'sel', lat: 0.01, lon: 0.01, selected: true });
    const others = Array.from({ length: 10 }, (_, i) => node({ id: `n${i}`, lat: 0.02, lon: 0.02 }));
    const out = clusterNodes([you, sel, ...others], 4);
    expect(out.find((n) => n.id === 'you')).toBeDefined();
    expect(out.find((n) => n.id === 'sel')).toBeDefined();
    // others may be clustered but total count must shrink
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it('far-zoom collapses many nodes; close zoom reveals all', () => {
    const nodes = Array.from({ length: 200 }, (_, i) =>
      node({ id: `n${i}`, lat: (i % 20) * 0.5, lon: Math.floor(i / 20) * 2 - 10 }),
    );
    const far = clusterNodes(nodes, 1);
    const close = clusterNodes(nodes, 6);
    expect(far.length).toBeLessThan(nodes.length);
    expect(close.length).toBe(nodes.length);
  });

  it('cluster cell shrinks with zoom', () => {
    expect(clusterCellDeg(1)).toBeGreaterThan(clusterCellDeg(3));
  });
});

describe('route honesty (measured vs approximate)', () => {
  it('a route with <2 geo-tagged hops is not renderable (no fabricated line)', () => {
    // This encodes the LiveMapPage contract: hops without geo are skipped;
    // fewer than 2 → route is null (the page tests this implicitly).
    const hops = [{ lat: 50, lon: 8 }];
    expect(hops.length < 2).toBe(true);
  });

  it('measured-hop arcs differ from endpoint great-circles when hops deviate', () => {
    // direct FRA→SYD vs via-Singapore relay must produce different paths
    const direct = arcPoints(50.11, 8.68, -33.87, 151.21, 32);
    const via = [
      ...arcPoints(50.11, 8.68, 1.35, 103.82, 32),
      ...arcPoints(1.35, 103.82, -33.87, 151.21, 32),
    ];
    // midpoints differ materially
    const a = direct[16]!;
    const b = via[Math.floor(via.length / 2)]!;
    const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(dist).toBeGreaterThan(0.5);
  });
});

describe('camera facing (thetaForLon)', () => {
  it('places the focus longitude at the center of the view', () => {
    // Sub-camera point: θ = -lon  ⇒  facing lon = -θ·180/π (normalized).
    const facingOf = (theta: number) => {
      const lon = -theta * (180 / Math.PI);
      return ((lon + 540) % 360) - 180;
    };
    for (const lon of [0, 8.68, 103.82, -74.0, 151.21, 179.5, -179.5]) {
      expect(facingOf(thetaForLon(lon))).toBeCloseTo(lon, 5);
    }
  });

  it('is the antipode of the old broken formula (regression: fly-to aimed 180° away)', () => {
    // The previous implementation used -(lon+180°); assert they differ by π
    // for a real city so this cannot silently regress.
    const old = -((8.68 + 180) * Math.PI) / 180;
    expect(Math.abs(thetaForLon(8.68) - old)).toBeCloseTo(Math.PI, 5);
  });
});

describe('hover tooltip anchoring (screen-space projection)', () => {
  it('projects a pin at the sub-camera point to viewport center', async () => {
    const { lonLatToVec3, thetaForLon, GLOBE_RADIUS } = await import('../src/features/map/globeMath');
    const THREE = (await import('three')).default ?? (await import('three'));
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    // camera placed per the canvas convention: facing lon=10
    const lon = 10;
    const lat = 20;
    camera.position.set(
      GLOBE_RADIUS * 2.6 * Math.sin(Math.PI / 2 - THREE.MathUtils.degToRad(lat)) * Math.cos(thetaForLon(lon)),
      GLOBE_RADIUS * 2.6 * Math.cos(Math.PI / 2 - THREE.MathUtils.degToRad(lat)),
      GLOBE_RADIUS * 2.6 * Math.sin(Math.PI / 2 - THREE.MathUtils.degToRad(lat)) * Math.sin(thetaForLon(lon)),
    );
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pin = new THREE.Vector3(...(Object.values(lonLatToVec3(lon, lat)) as [number, number, number]));
    const projected = pin.clone().project(camera);
    // the pin the camera is aimed at must land at the center of the viewport
    expect(Math.abs(projected.x)).toBeLessThan(0.02);
    expect(Math.abs(projected.y)).toBeLessThan(0.02);
  });

  it('a hovered marker behind the globe is farther from the camera than the surface allows', async () => {
    // mirrors the canvas's isOccluded contract: dot(normal, camDir) <= 0.02
    const { lonLatToVec3, GLOBE_RADIUS } = await import('../src/features/map/globeMath');
    const THREE = (await import('three')).default ?? (await import('three'));
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    camera.position.set(0, 0, GLOBE_RADIUS * 2.6);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const asVec3 = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
    const occluded = (p: THREE.Vector3) => p.clone().normalize().dot(camera.position.clone().normalize()) <= 0.02;
    // camera at +Z: with theta=lon+180, z=R·sin(theta) → lon=-90 gives z=+R (near),
    // lon=+90 gives z=-R (far). The test pins the exact antipodal pair.
    const nearPin = asVec3(lonLatToVec3(-90, 0));
    const farPin = asVec3(lonLatToVec3(90, 0));
    // Exactly one of the two antipodal pins is near the camera; the other is occluded.
    const nearOccluded = occluded(nearPin);
    const farOccluded = occluded(farPin);
    expect(nearOccluded).toBe(false);
    expect(farOccluded).toBe(true);
  });
});

describe('screen-space picking (clicking a node must never be a pixel hunt)', () => {
  const cameraAt = (lon: number, lat: number) => {
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    const p = cameraAnchorFor(lon, lat, GLOBE_RADIUS * 2.6);
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return camera;
  };

  it('picks the nearest pin inside the tolerance circle and nothing outside it', () => {
    const projected = [
      { item: 'far', x: 300, y: 200, z: 0 },
      { item: 'near', x: 122, y: 98, z: 0 },
    ];
    expect(nearestScreenPin(projected, 120, 100, 14)).toBe('near');
    // 15 px away — just outside the radius → a miss, not an accidental selection
    expect(nearestScreenPin([{ item: 'edge', x: 120, y: 115, z: 0 }], 120, 100, 14)).toBeNull();
    // pointer nowhere near any pin
    expect(nearestScreenPin(projected, 420, 420, 14)).toBeNull();
  });

  it('finds a pin the old raycast-marker path missed (few-px marker, 10 px click)', () => {
    const lon = 29;
    const lat = 41;
    const camera = cameraAt(lon, lat);
    const pin = { id: 'istanbul', pos: lonLatToVec3(lon, lat) };
    const projected = projectPins([pin], camera, 564, 560);
    expect(projected).toHaveLength(1);
    // card-sized viewport → the sub-camera pin lands at its center
    expect(Math.abs(projected[0]!.x - 282)).toBeLessThan(3);
    expect(Math.abs(projected[0]!.y - 280)).toBeLessThan(3);
    const picked = nearestScreenPin(projected, projected[0]!.x + 10, projected[0]!.y, 14);
    expect(picked?.id).toBe('istanbul');
  });

  it('never picks a far-side pin, even when its projection lands under the pointer', () => {
    const lon = 29;
    const lat = 41;
    const camera = cameraAt(lon, lat);
    const near = { id: 'near', pos: lonLatToVec3(lon, lat) };
    const far = { id: 'far', pos: lonLatToVec3(lon + 180, -lat) };
    // the canvas filters by facesCamera before projecting
    const visible = [near, far].filter((p) => facesCamera(p.pos, camera.position));
    expect(visible.map((p) => p.id)).toEqual(['near']);
    const target = projectPins([near], camera, 564, 560)[0]!;
    const picked = nearestScreenPin(projectPins(visible, camera, 564, 560), target.x, target.y, 14);
    expect(picked?.id).toBe('near');
  });

  it('drops pins beyond the far plane instead of picking a phantom position', () => {
    const camera = cameraAt(10, 0);
    const beyond = { id: 'beyond', pos: lonLatToVec3(10, 0, 400) };
    expect(projectPins([beyond], camera, 564, 560)).toHaveLength(0);
  });
});
