import type { NodeProtocol, NodeView } from '@netpulse/shared';

import { PROTOCOL_LABELS, TRANSPORT_LABELS, SECURITY_LABELS } from './nodeParsers';
import { geoStatusReasonFor } from './nodeGeoService';
import { maskSourceUrl } from '../util/redact';

/**
 * Node view layer — the one place a stored row becomes what the frontend sees:
 * labels attached, enums coerced, the runtime column sanitized, geo status
 * derived, and the endpoint withheld.
 *
 * ## The endpoint is not in this shape, on purpose
 *
 * `host`, `port`, `ipv4`, `ipv6`, `sni`, `hostHeader` and `realityServerName`
 * are the stored dialing recipe. Each one can identify where a node lives on its
 * own: `ipv4` IS the address, and `sni` / `hostHeader` are routinely the same
 * value as `host` (a CDN fronting the origin sets Host to the host it serves).
 * Dropping `host` and `port` while keeping those would have been theatre, so
 * the whole set goes together.
 *
 * `path` and `serviceName` stay: they are a route on the server, not the
 * server, and they are protocol facts a user can act on without learning where
 * anything is. `remark`, protocol, transport, security and every measurement
 * stay for the same reason — the app's premise is choosing a server by place
 * and ping.
 *
 * What replaces the address is not an empty string and not a redaction blob:
 * `label` is a stable identity derived from data that is not an address, and
 * `endpointHidden` is a literal `true` so a surface can say "hidden on purpose"
 * rather than render a missing field as a gap.
 *
 * The server keeps all of it. Probing, engine import and the file vault read
 * the row, not this DTO. The boundary is what reaches the user.
 *
 * Filtering and sorting are deliberately NOT here. The explorer's bulk
 * querying, paging, filtering and ordering run in SQL over every stored node
 * (owned by the repository), so an in-memory copy of that policy would be a
 * second, drifting authority over the same behavior.
 *
 * The wire shape itself is defined once, in `@netpulse/shared`, as `NodeView`.
 * That is deliberate: the web app codes against the same type, so a field that
 * is not on it cannot be read there even by accident — the type is the
 * boundary, not a convention. `NodeWebDTO` is the local name for it.
 */
export type NodeWebDTO = NodeView;

/**
 * A node's display name, from data that is not an address.
 *
 * Sources usually supply a `remark` ("🇺🇸 US Premium 01"), and that is exactly
 * what the old `node.remark || node.host` fallback wanted. When there is no
 * remark we do NOT reach for the host: the fallback is protocol plus the first
 * 8 hex of the canonical fingerprint, which is a digest the server already
 * exposes for dedup and which cannot be walked back to an address.
 *
 * The remark itself is filtered first. A remark is free text a provider
 * chooses, and a provider that names a node after its own endpoint ("edge
 * 198.51.100.7") would otherwise smuggle the host straight back in through the
 * name we just declined to send. Anything that reads as an address — an IP
 * literal, or the node's own host — is not used as a label.
 */
export function nodeLabel(node: {
  protocol: string;
  remark: string | null;
  host: string;
  /** absent for callers that hold only a partial node shape */
  canonicalFingerprint?: string;
  id?: string;
}): string {
  const remark = (node.remark ?? '').trim();
  if (remark && !looksLikeEndpoint(remark, node.host)) return remark;

  const proto = PROTOCOL_LABELS[node.protocol as NodeProtocol] || node.protocol;
  const fp = node.canonicalFingerprint;
  if (fp) return `${proto} · ${fp.slice(0, 8)}`;
  return node.id ? `${proto} · ${node.id}` : proto;
}

/**
 * True when free text is (or contains) something that would re-expose the
 * endpoint: the node's own host, or an IPv4/IPv6 literal.
 */
function looksLikeEndpoint(text: string, host: string): boolean {
  const lower = text.toLowerCase();
  if (host && lower.includes(host.toLowerCase())) return true;
  // dotted-quad, or a colon-bearing run (bracketed or bare IPv6)
  return /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text) || /[0-9a-f]{0,4}:[0-9a-f]{2,}:/i.test(text);
}

export function toWebDTO(node: {
  id: string;
  canonicalFingerprint: string;
  fingerprint: string | null;
  protocol: string;
  host: string;
  ipv4: string[];
  ipv6: string[];
  port: number;
  transport: string;
  security: string;
  sni: string | null;
  alpn: string[];
  flow: string | null;
  alterId: number | null;
  encryption: string | null;
  ssrProtocol: string | null;
  path: string | null;
  hostHeader: string | null;
  serviceName: string | null;
  allowInsecure: boolean;
  realityPublicKey: string | null;
  realityShortId: string | null;
  realityServerName: string | null;
  remark: string | null;
  sourceIds: string[];
  sourceUrls: string[];
  sourceCount: number;
  firstSeen: number;
  lastSeen: number;
  lastValidated: number | null;
  status: string;
  confidence: string;
  country: string | null;
  city: string | null;
  asn: number | null;
  /** last geolocation attempt (epoch ms) — needed to derive geoStatusReason */
  geoLastAttempt: number | null;
  isp: string | null;
  organization: string | null;
  lat: number | null;
  lon: number | null;
  geoSourceCount: number;
  userNotes: string | null;
  score: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs: number | null;
  medianTlsMs: number | null;
  recentLossPct: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  freshness: string;
  tags: string[];
  favorite: boolean;
  lastProxyMs: number | null;
  /** raw DB value; coerced to the DTO union below */
  lastEngine: string | null;
  lastTcpMs: number | null;
  lastTlsMs: number | null;
  testCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  recentTestCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  createdAt: number;
  updatedAt: number;
}): NodeWebDTO {
  const proto = node.protocol as NodeProtocol;
  return {
    id: node.id,
    canonicalFingerprint: node.canonicalFingerprint,
    fingerprint: node.fingerprint,
    protocol: proto,
    protocolLabel: PROTOCOL_LABELS[proto] || proto,
    label: nodeLabel(node),
    endpointHidden: true,
    transport: node.transport,
    transportLabel: TRANSPORT_LABELS[node.transport as keyof typeof TRANSPORT_LABELS] || node.transport,
    security: node.security,
    securityLabel: SECURITY_LABELS[node.security as keyof typeof SECURITY_LABELS] || node.security,
    alpn: node.alpn,
    flow: node.flow,
    alterId: node.alterId,
    path: node.path,
    serviceName: node.serviceName,
    allowInsecure: node.allowInsecure,
    realityPublicKey: node.realityPublicKey,
    realityShortId: node.realityShortId,
    encryption: node.encryption,
    ssrProtocol: node.ssrProtocol,
    // The remark is free text a provider chose, so it can BE the address
    // ("edge-198.51.100.7"). `label` already refuses it; this stops the raw
    // field from carrying it out under another name. A remark that reads as an
    // endpoint is withheld, and the surfaces that show it fall back to `label`.
    remark: node.remark && looksLikeEndpoint(node.remark, node.host) ? null : node.remark,
    sourceIds: node.sourceIds,
    // A node's source URL IS the subscription that yields every config — the
    // same string `maskSourceUrl` protects on every /sources route. Carrying it
    // here unmaksed would have made the node DTO a roundabout way to read it.
    // Nothing in the web app renders this field; it is masked, not dropped, so
    // provenance survives for whoever needs to tell two sources apart.
    sourceUrls: node.sourceUrls.map(maskSourceUrl),
    sourceCount: node.sourceCount,
    firstSeen: node.firstSeen,
    lastSeen: node.lastSeen,
    lastValidated: node.lastValidated,
    status: node.status,
    confidence: node.confidence,
    country: node.country,
    city: node.city,
    asn: node.asn,
    isp: node.isp,
    organization: node.organization,
    lat: node.lat,
    lon: node.lon,
    geoSourceCount: node.geoSourceCount,
    geoStatusReason: geoStatusReasonFor({
      host: node.host,
      lat: node.lat,
      asn: node.asn,
      geoLastAttempt: node.geoLastAttempt,
    }),
    tags: node.tags,
    favorite: node.favorite,
    userNotes: node.userNotes,
    lastProxyMs: node.lastProxyMs,
    lastEngine: node.lastEngine === 'xray' || node.lastEngine === 'sing-box' || node.lastEngine === 'v2ray' ? node.lastEngine : null,
    lastTcpMs: node.lastTcpMs,
    lastTlsMs: node.lastTlsMs,
    testCount: node.testCount,
    successCount: node.successCount,
    failureCount: node.failureCount,
    consecutiveFailures: node.consecutiveFailures,
    recentTestCount: node.recentTestCount,
    recentSuccessCount: node.recentSuccessCount,
    recentFailureCount: node.recentFailureCount,
    score: node.score,
    reliabilityPct: node.reliabilityPct,
    medianProxyMs: node.medianProxyMs,
    medianTcpMs: node.medianTcpMs,
    medianTlsMs: node.medianTlsMs,
    recentLossPct: node.recentLossPct,
    lastSuccessAt: node.lastSuccessAt,
    lastFailureAt: node.lastFailureAt,
    freshness: node.freshness,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

