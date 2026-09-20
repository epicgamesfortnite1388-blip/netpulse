import type { NodeProtocol } from '@netpulse/shared';

import { PROTOCOL_LABELS, TRANSPORT_LABELS, SECURITY_LABELS } from './nodeParsers';
import { geoStatusReasonFor } from './nodeGeoService';

/**
 * Node view layer — the one place a stored row becomes what the frontend sees:
 * labels attached, enums coerced, the runtime column sanitized, geo status
 * derived.
 *
 * Filtering and sorting are deliberately NOT here. The explorer's bulk
 * querying, paging, filtering and ordering run in SQL over every stored node
 * (owned by the repository), so an in-memory copy of that policy would be a
 * second, drifting authority over the same behavior.
 */
export interface NodeWebDTO {
  id: string;
  canonicalFingerprint: string;
  protocol: NodeProtocol;
  protocolLabel: string;
  host: string;
  ipv4: string[];
  ipv6: string[];
  port: number;
  transport: string;
  transportLabel: string;
  security: string;
  securityLabel: string;
  sni: string | null;
  alpn: string[];
  fingerprint: string | null;
  flow: string | null;
  alterId: number | null;
  path: string | null;
  hostHeader: string | null;
  serviceName: string | null;
  allowInsecure: boolean;
  realityPublicKey: string | null;
  realityShortId: string | null;
  realityServerName: string | null;
  encryption: string | null;
  ssrProtocol: string | null;
  remark: string | null;
  sourceCount: number;
  sourceIds: string[];
  sourceUrls: string[];
  country: string | null;
  city: string | null;
  asn: number | null;
  isp: string | null;
  organization: string | null;
  lat: number | null;
  lon: number | null;
  geoSourceCount: number;
  /** why the node has (or lacks) a location — surfaced on the detail page */
  geoStatusReason: 'known' | 'anycast' | 'edge_fabric' | 'lookup_failed' | 'pending';
  userNotes: string | null;
  score: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs: number | null;
  medianTlsMs: number | null;
  recentLossPct: number;
  lastValidated: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  freshness: string;
  status: string;
  confidence: string;
  tags: string[];
  favorite: boolean;
  lastProxyMs: number | null;
  lastEngine: 'xray' | 'sing-box' | 'v2ray' | null;
  lastTcpMs: number | null;
  lastTlsMs: number | null;
  testCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  recentTestCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  firstSeen: number;
  lastSeen: number;
  createdAt: number;
  updatedAt: number;
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
    host: node.host,
    ipv4: node.ipv4,
    ipv6: node.ipv6,
    port: node.port,
    transport: node.transport,
    transportLabel: TRANSPORT_LABELS[node.transport as keyof typeof TRANSPORT_LABELS] || node.transport,
    security: node.security,
    securityLabel: SECURITY_LABELS[node.security as keyof typeof SECURITY_LABELS] || node.security,
    sni: node.sni,
    alpn: node.alpn,
    flow: node.flow,
    alterId: node.alterId,
    path: node.path,
    hostHeader: node.hostHeader,
    serviceName: node.serviceName,
    allowInsecure: node.allowInsecure,
    realityPublicKey: node.realityPublicKey,
    realityShortId: node.realityShortId,
    realityServerName: node.realityServerName,
    encryption: node.encryption,
    ssrProtocol: node.ssrProtocol,
    remark: node.remark,
    sourceIds: node.sourceIds,
    sourceUrls: node.sourceUrls,
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

