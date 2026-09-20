import { buildShareLink, linkSourceFromRow } from './nodeLinkExport';
import type { LinkExport, LinkSourceRow } from './nodeLinkExport';

/**
 * Node export serialization — stored rows to config files the user can paste
 * into another client. Pure string building over the row plus the vaulted
 * credential; no repository access (the caller fetches rows and secrets).
 *
 * Every format follows one rule: a node whose credential is missing yields an
 * explicit `#` comment line, never a config that looks valid but cannot
 * connect (a `<uuid>` placeholder is worse than an honest skip). Secrets come
 * only from the vault the caller supplies — never invented here.
 */
/**
 * The stored-row fields any export format may read. A superset of the share
 * link's input, because the JSON document also carries the node's measurement
 * summary (never the credential).
 */
export type ExportRow = LinkSourceRow & {
  id: string;
  sourceCount: number;
  country: string | null;
  city: string | null;
  asn: number | null;
  isp: string | null;
  score: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs: number | null;
  medianTlsMs: number | null;
  recentLossPct: number;
  lastValidated: number | null;
  freshness: string;
};

export type ExportFormat = 'uri' | 'plaintext' | 'base64' | 'json' | 'clash' | 'singbox';

export function isExportFormat(format: string): format is ExportFormat {
  return ['uri', 'plaintext', 'base64', 'json', 'clash', 'singbox'].includes(format);
}

/** One node as a usable share link, or the reason it cannot be rebuilt. */
export function nodeLink(row: ExportRow, secret: string | null): LinkExport {
  return buildShareLink(linkSourceFromRow(row), secret);
}

/** One node as a URI line; unexportable nodes become `#` comment lines. */
export function toUri(row: ExportRow, secret: string | null): string {
  const result = nodeLink(row, secret);
  return result.ok ? result.link : `# ${row.host}:${row.port} not exported — ${result.reason}`;
}

export function toExportJSON(node: ExportRow): Record<string, unknown> {
  // A config that can be imported by a client. Secrets are NOT included.
  return {
    id: node.id,
    host: node.host,
    port: node.port,
    protocol: node.protocol,
    transport: node.transport,
    security: node.security,
    sni: node.sni,
    alpn: node.alpn,
    path: node.path,
    hostHeader: node.hostHeader,
    serviceName: node.serviceName,
    flow: node.flow,
    allowInsecure: node.allowInsecure,
    remark: node.remark,
    sourceCount: node.sourceCount,
    country: node.country,
    city: node.city,
    asn: node.asn,
    isp: node.isp,
    score: node.score,
    reliabilityPct: node.reliabilityPct,
    medianProxyMs: node.medianProxyMs,
    medianTcpMs: node.medianTcpMs,
    medianTlsMs: node.medianTlsMs,
    recentLossPct: node.recentLossPct,
    lastValidated: node.lastValidated,
    freshness: node.freshness,
  };
}

export function toClashConfig(
  rows: Array<{
    id: string;
    /** raw stored protocol; matched by name below */
    protocol: string;
    host: string;
    port: number;
    security: string;
    transport: string;
    sni: string | null;
    path: string | null;
    remark: string | null;
    alterId: number | null;
    encryption: string | null;
    flow: string | null;
    alpn: string[] | null;
  }>,
  secretFor: (id: string) => string | null,
): string {
  const proxies = rows.map((n) => {
    const secret = secretFor(n.id);
    if (!secret?.trim()) return `  # ${n.remark || n.host}:${n.port} not exported — no credential is stored for this node`;
    switch (n.protocol) {
      case 'vless':
        return `  - name: ${n.remark || n.host}\n    type: vless\n    server: ${n.host}\n    port: ${n.port}\n    uuid: ${secret}\n    tls: ${n.security === 'tls' || n.security === 'reality'}\n    ${n.sni ? `sni: ${n.sni}` : ''}\n    ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}`;
      case 'vmess':
        return `  - name: ${n.remark || n.host}\n    type: vmess\n    server: ${n.host}\n    port: ${n.port}\n    uuid: ${secret}\n    alterId: ${n.alterId ?? 0}\n    tls: ${n.security === 'tls'}\n    ${n.sni ? `sni: ${n.sni}` : ''}\n    ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}`;
      case 'trojan':
        return `  - name: ${n.remark || n.host}\n    type: trojan\n    server: ${n.host}\n    port: ${n.port}\n    password: "${secret}"\n    tls: true\n    ${n.sni ? `sni: ${n.sni}` : ''}`;
      case 'shadowsocks':
        return `  - name: ${n.remark || n.host}\n    type: shadowsocks\n    server: ${n.host}\n    port: ${n.port}\n    password: "${secret}"\n    cipher: ${n.encryption || 'aes-256-gcm'}`;
      default:
        return `  - name: ${n.remark || n.host}\n    type: ${n.protocol}\n    server: ${n.host}\n    port: ${n.port}`;
    }
  });

  return `proxies:\n${proxies.join('\n')}\n`;
}

export function toSingboxConfig(
  rows: Array<{
    id: string;
    /** raw stored protocol; matched by name below */
    protocol: string;
    host: string;
    port: number;
    security: string;
    transport: string;
    sni: string | null;
    path: string | null;
    remark: string | null;
    alterId: number | null;
    encryption: string | null;
    flow: string | null;
    alpn: string[] | null;
  }>,
  secretFor: (id: string) => string | null,
): string {
  const outbounds = rows.map((n) => {
    const secret = secretFor(n.id);
    if (!secret?.trim()) return `  # ${n.remark || n.id} (${n.host}:${n.port}) not exported — no credential is stored for this node`;
    switch (n.protocol) {
      case 'vless':
        return `  - name: ${n.remark || n.id}\n    type: vless\n    server: ${n.host}\n    port: ${n.port}\n    uuid: ${secret}\n    tls:\n      enabled: true\n      server_name: ${n.sni || n.host}\n      ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}\n      ${n.flow ? `flow: ${n.flow}` : ''}`;
      case 'vmess':
        return `  - name: ${n.remark || n.id}\n    type: vmess\n    server: ${n.host}\n    port: ${n.port}\n    uuid: ${secret}\n    alter_id: ${n.alterId ?? 0}\n    security: auto\n    tls:\n      enabled: true\n      server_name: ${n.sni || n.host}\n      ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}`;
      case 'trojan':
        return `  - name: ${n.remark || n.id}\n    type: trojan\n    server: ${n.host}\n    port: ${n.port}\n    password: "${secret}"\n    tls:\n      enabled: true\n      server_name: ${n.sni || n.host}`;
      case 'shadowsocks':
        return `  - name: ${n.remark || n.id}\n    type: shadowsocks\n    server: ${n.host}\n    port: ${n.port}\n    password: "${secret}"\n    cipher: ${n.encryption || 'aes-256-gcm'}`;
      default:
        return `  - name: ${n.remark || n.id}\n    type: ${n.protocol}\n    server: ${n.host}\n    port: ${n.port}`;
    }
  });

  return `outbounds:\n${outbounds.join('\n')}\n`;
}

/** Rows → the requested export document. */
export function serializeExport(
  rows: ExportRow[],
  format: ExportFormat,
  secretFor: (id: string) => string | null,
): string {
  switch (format) {
    case 'base64': {
      const uris = rows.map((n) => toUri(n, secretFor(n.id))).join('\n');
      return Buffer.from(uris, 'utf8').toString('base64');
    }
    case 'json':
      return JSON.stringify(rows.map(toExportJSON), null, 2);
    case 'clash':
      return toClashConfig(rows, secretFor);
    case 'singbox':
      return toSingboxConfig(rows, secretFor);
    // 'uri' | 'plaintext' (and anything unrecognized) fall back to URIs —
    // the old default did the same.
    default:
      return rows.map((n) => toUri(n, secretFor(n.id))).join('\n');
  }
}
