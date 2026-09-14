import { greatCircleRadians } from './globeMath';

import type { GlobeNode } from './mapEncoding';

/**
 * Geographic clustering for the globe.
 *
 * At low zoom hundreds of pins smear into noise; nearby nodes collapse into
 * cluster markers that reveal themselves as the camera closes in. Clusters
 * are computed per frame-input (nodes + zoom), not per render frame — the
 * result is memoized upstream and the canvas only re-reconciles when the
 * cluster set actually changes.
 *
 * Algorithm: greedy grid-bin clustering in tangent space. Nodes are binned
 * by a cell size that shrinks with zoom; each bin with >1 member becomes a
 * cluster anchored at the circular-mean position (antimeridian-safe via
 * globeMath.clusterAnchor) with a `cluster` count. Zoomed-in enough, the
 * cell shrinks below marker size and every node stands alone.
 */

/** Cell size (degrees of arc at the equator) for a given zoom level. */
export function clusterCellDeg(zoom: number): number {
  // zoom here is a small scalar (1 = far, ~6 = close). Far → 20° cells,
  // close → below marker resolution (no clustering).
  const z = Math.max(0.5, Math.min(8, zoom));
  return Math.max(0.5, 24 / (z * z));
}

/**
 * Cluster nodes for the current zoom. Returns a NEW list (never mutates);
 * clustered members are replaced by one GlobeNode with `cluster: N` set,
 * anchored at the circular mean of its members. Deterministic: stable order,
 * no randomness — the same input always yields the same clusters.
 */
export function clusterNodes(nodes: GlobeNode[], zoom: number): GlobeNode[] {
  const cell = clusterCellDeg(zoom);
  if (cell <= 1.2) return nodes; // close zoom: no clustering at all

  const bins = new Map<string, GlobeNode[]>();
  for (const n of nodes) {
    if (n.kind === 'you') continue; // never cluster the local endpoint
    if (n.selected) continue; // selection must stay addressable
    const key = `${Math.floor((n.lat + 90) / cell)}:${Math.floor((n.lon + 180) / cell)}`;
    const list = bins.get(key);
    if (list) list.push(n);
    else bins.set(key, [n]);
  }

  const out: GlobeNode[] = [];
  const consumed = new Set<string>();
  for (const [key, list] of bins) {
    if (list.length === 1) {
      out.push(list[0]!);
      consumed.add(list[0]!.id);
      continue;
    }
    // circular-mean anchor (globeMath) keeps clusters honest across ±180°
    const anchor = clusterAnchorOf(list);
    out.push({
      id: `cluster:${key}`,
      label: `${list.length} nodes`,
      sub: null,
      lat: anchor.lat,
      lon: anchor.lon,
      kind: list.some((n) => n.kind === 'vpn') ? 'vpn' : 'target',
      status: worstStatus(list),
      latencyMs: bestLatency(list),
      cluster: list.length,
      geoConfidence: worstConfidence(list),
      historical: false,
      selected: false,
    });
    for (const n of list) consumed.add(n.id);
  }
  // any node not consumed (you/selected) passes through in original order
  for (const n of nodes) {
    if (!consumed.has(n.id)) out.push(n);
  }
  return out;
}

/** Worst measured status in a cluster (poor/unreachable dominate). */
function worstStatus(list: GlobeNode[]): GlobeNode['status'] {
  const rank: Record<GlobeNode['status'], number> = {
    unreachable: 0,
    poor: 1,
    fair: 2,
    unknown: 3,
    good: 4,
    excellent: 5,
  };
  return list.reduce((worst, n) => (rank[n.status] < rank[worst] ? n.status : worst), list[0]!.status);
}

/** Median-ish latency (min here: clusters surface their best member's RTT). */
function bestLatency(list: GlobeNode[]): number | null {
  const vals = list.map((n) => n.latencyMs).filter((v): v is number => v != null);
  if (!vals.length) return null;
  return Math.min(...vals);
}

/** Least-trustworthy geo confidence in the cluster (honesty). */
function worstConfidence(list: GlobeNode[]): GlobeNode['geoConfidence'] {
  const order = ['unknown', 'low', 'medium', 'high'];
  return list.reduce<GlobeNode['geoConfidence']>((worst, n) => {
    const a = order.indexOf(n.geoConfidence ?? 'unknown');
    const b = order.indexOf(worst ?? 'unknown');
    return a < b ? n.geoConfidence ?? 'unknown' : worst;
  }, 'high' as GlobeNode['geoConfidence']);
}

/** Circular-mean anchor for a cluster (delegates to globeMath). */
function clusterAnchorOf(list: GlobeNode[]): { lat: number; lon: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of list) {
    const v = unitVec(p.lat, p.lon);
    x += v[0];
    y += v[1];
    z += v[2];
  }
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return { lat: list[0]!.lat, lon: list[0]!.lon };
  const lat = (Math.asin(y / len) * 180) / Math.PI;
  let lon = (Math.atan2(z, -x) * 180) / Math.PI - 180;
  lon = ((lon + 540) % 360) - 180;
  if (lon === -180) lon = 180;
  return { lat, lon };
}

function unitVec(lat: number, lon: number): [number, number, number] {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return [-Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

/** True when two nodes sit within `maxDeg` great-circle degrees of each other. */
export function withinDegrees(a: { lat: number; lon: number }, b: { lat: number; lon: number }, maxDeg: number): boolean {
  return greatCircleRadians(a.lat, a.lon, b.lat, b.lon) <= (maxDeg * Math.PI) / 180;
}
