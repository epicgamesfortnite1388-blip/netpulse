import { canonicalizeIpv6, parseNodeUri } from './nodeParsers';

/**
 * Node → share link (the reverse of the parsers).
 *
 * Why this exists: a node is stored as parsed fields plus a credential in the
 * encrypted vault, so nothing in the app could turn it back into a config. The
 * export path emitted literal templates (`vless://<password>@…`) — a link that
 * looks copyable but is unusable — and "add this node to an engine" was
 * therefore impossible without the original source text. This module rebuilds a
 * real link from the stored row and the vaulted secret.
 *
 * Every link is ROUND-TRIPPED through the same parser the app uses before it is
 * returned: if the emitted text does not parse back to the same protocol, host
 * and port, the export fails with a reason instead of handing the user a config
 * that only looks valid.
 *
 * The credential is never logged; it travels only in the returned link.
 */

export interface LinkSourceNode {
  protocol: string;
  host: string;
  port: number;
  transport: string;
  security: string;
  sni: string | null;
  alpn: string[];
  path: string | null;
  hostHeader: string | null;
  serviceName: string | null;
  flow: string | null;
  alterId: number | null;
  allowInsecure: boolean;
  realityPublicKey: string | null;
  realityShortId: string | null;
  realityServerName: string | null;
  encryption: string | null;
  remark: string | null;
}

export type LinkExport = { ok: true; link: string; protocol: string } | { ok: false; reason: string };

/** The stored-row fields the builder needs (a subset of PublicNodeRow). */
export interface LinkSourceRow extends Omit<LinkSourceNode, 'alpn'> {
  alpn: string[] | null;
}

/** Map a stored node row onto the builder's input. */
export function linkSourceFromRow(row: LinkSourceRow): LinkSourceNode {
  return { ...row, alpn: row.alpn ?? [] };
}

/** Protocols that can be written back into a share link at all. */
const EXPORTABLE = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic']);

export function isExportableProtocol(protocol: string): boolean {
  return EXPORTABLE.has(protocol);
}

/** `host:port`, with IPv6 bracketed (bare colons would corrupt the authority). */
function authority(host: string, port: number): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Host equality that understands IPv6 canonicalization. */
function sameHost(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  if (!a.includes(':') || !b.includes(':')) return false;
  try {
    return canonicalizeIpv6(a) === canonicalizeIpv6(b);
  } catch {
    return false;
  }
}

/** Fragment text: the node's name, or its address when it has none. */
function remarkOf(node: LinkSourceNode): string {
  const remark = node.remark?.trim();
  return remark && remark.length > 0 ? remark : `${node.host}:${node.port}`;
}

function buildVless(node: LinkSourceNode, secret: string): string {
  const params = new URLSearchParams();
  params.set('type', node.transport);
  params.set('security', node.security === 'none' ? 'none' : node.security);
  if (node.security !== 'none' && node.sni) params.set('sni', node.sni);
  if (node.security === 'reality') {
    if (node.realityPublicKey) params.set('pbk', node.realityPublicKey);
    if (node.realityShortId) params.set('sid', node.realityShortId);
  }
  if (node.flow) params.set('flow', node.flow);
  if (node.transport === 'ws' || node.transport === 'http' || node.transport === 'httpupgrade' || node.transport === 'xhttp') {
    params.set('path', node.path ?? '/');
    if (node.hostHeader) params.set('host', node.hostHeader);
  }
  if (node.transport === 'grpc' && node.serviceName) params.set('serviceName', node.serviceName);
  if (node.alpn.length > 0) params.set('alpn', node.alpn.join(','));
  if (node.allowInsecure) params.set('allowInsecure', '1');
  if (node.encryption) params.set('encryption', node.encryption);
  return `vless://${secret}@${authority(node.host, node.port)}?${params.toString()}#${enc(remarkOf(node))}`;
}

function buildVmess(node: LinkSourceNode, secret: string): string {
  // vmess:// takes base64(JSON) in the v2rayN shape — the format every client
  // reads. Keys are the short names the parser consumes.
  const isGrpc = node.transport === 'grpc';
  const payload: Record<string, unknown> = {
    v: '2',
    ps: remarkOf(node),
    add: node.host,
    port: node.port,
    id: secret,
    aid: node.alterId ?? 0,
    scy: 'auto',
    net: node.transport === 'http' ? 'h2' : node.transport,
    type: 'none',
    host: node.transport === 'ws' ? (node.hostHeader ?? '') : '',
    path: isGrpc ? (node.serviceName ?? '') : (node.path ?? '/'),
    tls: node.security === 'tls' ? 'tls' : '',
    sni: node.sni ?? '',
  };
  return `vmess://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function buildTrojan(node: LinkSourceNode, secret: string): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  params.set('type', node.transport);
  if (node.transport === 'ws') {
    params.set('path', node.path ?? '/');
    if (node.hostHeader) params.set('host', node.hostHeader);
  }
  if (node.allowInsecure) params.set('allowInsecure', '1');
  return `trojan://${enc(secret)}@${authority(node.host, node.port)}?${params.toString()}#${enc(remarkOf(node))}`;
}

function buildShadowsocks(node: LinkSourceNode, secret: string): string {
  // SIP002: base64url(method:password)@host:port. The cipher name is required —
  // without it the link cannot be dialled, so its absence is a real failure
  // rather than something to guess.
  const method = node.encryption?.trim();
  if (!method) return '';
  const userinfo = Buffer.from(`${method}:${secret}`, 'utf8').toString('base64url');
  return `ss://${userinfo}@${authority(node.host, node.port)}#${enc(remarkOf(node))}`;
}

function buildHysteria2(node: LinkSourceNode, secret: string): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.allowInsecure) params.set('allowInsecure', '1');
  const query = params.toString();
  return `hysteria2://${enc(secret)}@${authority(node.host, node.port)}${query ? `?${query}` : ''}#${enc(remarkOf(node))}`;
}

function buildTuic(node: LinkSourceNode, secret: string): string {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.alpn.length > 0) params.set('alpn', node.alpn[0]!);
  return `tuic://${enc(secret)}@${authority(node.host, node.port)}?${params.toString()}#${enc(remarkOf(node))}`;
}

/**
 * Build a usable share link for a stored node.
 *
 * `secret` is the vaulted credential (uuid or password). When it is missing the
 * link cannot be built — a subscription with an empty credential would be
 * accepted by clients and then fail at connect time, which is worse than
 * saying so here.
 */
export function buildShareLink(node: LinkSourceNode, secret: string | null): LinkExport {
  if (!isExportableProtocol(node.protocol)) {
    if (node.protocol === 'shadowsocksr') {
      return { ok: false, reason: 'ShadowsocksR has no standard share link — export it from the client that produced it' };
    }
    if (node.protocol === 'wireguard') {
      return { ok: false, reason: 'A WireGuard node is a key pair, not a share link — import its .conf in the WireGuard engine' };
    }
    return { ok: false, reason: `Protocol "${node.protocol}" cannot be written as a share link` };
  }

  const credential = secret?.trim();
  if (!credential) {
    return {
      ok: false,
      reason: 'No credential is stored for this node (its uuid/password never reached the vault) — re-import it from a source to make it usable',
    };
  }

  let link: string;
  switch (node.protocol) {
    case 'vless':
      link = buildVless(node, credential);
      break;
    case 'vmess':
      link = buildVmess(node, credential);
      break;
    case 'trojan':
      link = buildTrojan(node, credential);
      break;
    case 'shadowsocks':
      link = buildShadowsocks(node, credential);
      if (!link) return { ok: false, reason: 'This Shadowsocks node has no cipher recorded, so its link cannot be rebuilt' };
      break;
    case 'hysteria2':
      link = buildHysteria2(node, credential);
      break;
    case 'tuic':
      link = buildTuic(node, credential);
      break;
    default:
      return { ok: false, reason: `Protocol "${node.protocol}" cannot be written as a share link` };
  }

  // Round trip: the app must be able to read back what it just wrote. A link
  // that parses to a different endpoint is worse than no link at all.
  const parsed = parseNodeUri(link);
  if (parsed.protocol !== node.protocol || !parsed.result) {
    return { ok: false, reason: `The rebuilt ${node.protocol} link did not parse back — refusing to export it` };
  }
  // Stored rows were themselves produced by this parser (which normalizes the
  // port), so the stored port is already the normalized one. Hosts are compared
  // after IPv6 canonicalization, because the parser rewrites an IPv6 literal
  // into its canonical form and a byte-wise compare would reject a link that is
  // in fact the same endpoint.
  if (!sameHost(parsed.result.config.host, node.host) || parsed.result.config.port !== node.port) {
    return { ok: false, reason: `The rebuilt ${node.protocol} link points at a different endpoint — refusing to export it` };
  }

  return { ok: true, link, protocol: node.protocol };
}
