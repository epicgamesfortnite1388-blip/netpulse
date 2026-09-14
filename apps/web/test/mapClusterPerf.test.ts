import { describe, expect, it } from 'vitest';

import { clusterNodes } from '../src/features/map/clusterNodes';

import type { GlobeNode } from '../src/features/map/mapEncoding';

/**
 * Performance envelope for the clustering pipeline: 5,000+ nodes must
 * cluster fast enough to run inside a user interaction budget (the page
 * memoizes this; the canvas reconciles only on change).
 */
function makeNodes(count: number): GlobeNode[] {
  const out: GlobeNode[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `n${i}`,
      label: `Node ${i}`,
      lat: (i * 37 % 180) - 90,
      lon: (i * 173 % 360) - 180,
      kind: 'target',
      status: 'good',
      latencyMs: 30 + (i % 90),
      geoConfidence: 'medium',
    });
  }
  return out;
}

describe('clustering performance', () => {
  it('clusters 5,000 nodes in under 100ms at far zoom', () => {
    const nodes = makeNodes(5000);
    const t0 = performance.now();
    const out = clusterNodes(nodes, 1.2);
    const dt = performance.now() - t0;
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(5000);
    expect(dt).toBeLessThan(100);
  });

  it('clusters 1,000 nodes in under 25ms at mid zoom', () => {
    const nodes = makeNodes(1000);
    const t0 = performance.now();
    clusterNodes(nodes, 2.5);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(25);
  });

  it('close zoom is effectively free even at 5,000 nodes', () => {
    const nodes = makeNodes(5000);
    const t0 = performance.now();
    const out = clusterNodes(nodes, 6);
    const dt = performance.now() - t0;
    expect(out.length).toBe(5000); // passthrough
    expect(dt).toBeLessThan(10);
  });
});
