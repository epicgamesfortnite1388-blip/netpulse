import type { GlobeNode } from './mapEncoding';

import type { PublicNode } from '@netpulse/shared';

/**
 * Map verified node-DB records to honest globe pins.
 *
 * Only nodes with pipeline-verified coordinates become pins — the geo pipeline
 * (anycast/edge-fabric guard, country bounding-box refusal) already refused
 * implausible coordinates, so `lat != null && lon != null` means trustworthy.
 * Nodes without coordinates are skipped here (the UI shows them with their
 * honest Unknown-reason explainer elsewhere; the globe never invents places).
 *
 * `id` carries the `node:` prefix that GlobeCanvas click handlers route to the
 * node detail page — DB pins are entities, not map targets.
 */
export function nodePinsFromDb(nodes: PublicNode[]): GlobeNode[] {
  const out: GlobeNode[] = [];
  for (const n of nodes) {
    if (n.lat == null || n.lon == null) continue;
    // Same honesty rule as the map destination panel: only city-level known
    // geo pins. Anycast/edge-fabric/lookup-failed/pending have no single true
    // location — a pin anywhere would be fabrication.
    if (n.geoStatusReason !== 'known') continue;
    const where = [n.city, n.country].filter(Boolean).join(', ');
    out.push({
      id: `node:${n.id}`,
      label: n.remark ?? n.host,
      sub: where || `${n.host}:${n.port}`,
      lat: n.lat,
      lon: n.lon,
      kind: n.status === 'healthy' || n.status === 'proxy-tested' ? 'vpn' : 'target',
      status: pinStatus(n),
      latencyMs: n.lastProxyMs ?? n.lastTcpMs,
      geoConfidence: n.confidence,
    });
  }
  return out;
}

/** Map a node's lifecycle status to the globe's honest status palette. */
function pinStatus(n: PublicNode): GlobeNode['status'] {
  if (n.status === 'healthy') return 'good';
  if (n.status === 'degraded') return 'fair';
  if (n.status === 'failed' || n.status === 'removed') return 'unreachable';
  if (n.status === 'stale') return 'unknown';
  return 'unknown';
}
