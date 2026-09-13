import crypto from 'node:crypto';
import { URL } from 'node:url';

import type {
  NodeFingerprint,
  NodeProtocol,
  NodeSecurity,
  NodeTransport,
  ParsedNodeConfig,
} from '@netpulse/shared';

import {
  validateNodeHost,
  validateNodePort,
  normalizeNodePort,
} from '../util/targetGuard';

/* --------------------------------- helpers ---------------------------------- */

function base64SafeDecode(str: string): string {
  // Add padding if needed
  let s = str.trim();
  const missing = (4 - (s.length % 4)) % 4;
  s += '='.repeat(missing);
  return Buffer.from(s, 'base64').toString('utf8');
}

function canonicalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

export function canonicalizeIpv6(ip: string): string {
  // Normalize IPv6 to canonical form for fingerprint consistency
  const cleaned = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!cleaned.includes(':')) return cleaned;
  try {
    return cleaned.split('::').length <= 2
      ? cleaned
      : cleaned.replace(/::+/, '::');
  } catch {
    return cleaned;
  }
}

/* --------------------------------- fingerprint -------------------------------- */

function fingerprintFromParsed(p: ParsedNodeConfig): NodeFingerprint {
  return {
    protocol: p.protocol,
    hostLower: canonicalizeHost(p.host),
    port: p.port,
    transport: p.transport,
    security: p.security,
    sni: p.sni ? p.sni.toLowerCase() : null,
    alpn: (p.alpn ?? []).map((a) => a.toLowerCase()),
    flow: p.flow ?? null,
    alterId: p.alterId ?? null,
    path: p.path ?? null,
    hostHeader: p.hostHeader ? p.hostHeader.toLowerCase() : null,
    serviceName: p.serviceName ?? null,
    realityPublicKey: p.realityPublicKey ?? null,
    realityShortId: p.realityShortId ?? null,
    realityServerName: p.realityServerName ? p.realityServerName.toLowerCase() : null,
    encryption: p.encryption ?? null,
    ssrProtocol: p.ssrProtocol ?? null,
  };
}

export function fingerprintHash(fp: NodeFingerprint): string {
  const json = JSON.stringify(fp, (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value === undefined || value === null) return value;
    return value;
  });
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

/* --------------------------------- URI detection -------------------------------- */

export function detectUriProtocol(text: string): NodeProtocol | null {
  const t = text.trim();
  if (t.startsWith('vmess://')) return 'vmess';
  if (t.startsWith('vless://')) return 'vless';
  if (t.startsWith('trojan://')) return 'trojan';
  if (t.startsWith('ssr://')) return 'shadowsocksr';
  if (t.startsWith('ss://')) return 'shadowsocks';
  if (t.startsWith('hysteria2://') || t.startsWith('hy2://')) return 'hysteria2';
  if (t.startsWith('tuic://')) return 'tuic';
  if (t.startsWith('wireguard://')) return 'wireguard';
  return null;
}

/* -------------------------------- VLESS parser -------------------------------- */

export interface VlessParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseVlessUri(text: string): VlessParseResult | null {
  try {
    // Two wire formats exist in the wild:
    //  1. Standard SIP002-style:  vless://<uuid>@<host>:<port>?<params>#<remark>
    //     (this is what every subscription list and v2rayN/nekoray exports)
    //  2. Legacy base64-JSON:     vless://base64(json) — rare, some old tools
    // Dispatch on the presence of "@" before any "?": format 1 always has it.
    const body = text.slice('vless://'.length);
    const atIdx = body.indexOf('@');
    const qIdx = body.indexOf('?');
    if (atIdx !== -1 && (qIdx === -1 || atIdx < qIdx)) {
      return parseVlessSip002(body);
    }
    // legacy base64-JSON branch (previous behavior)
    const decoded = base64SafeDecode(body);
    const json = JSON.parse(decoded) as Record<string, unknown>;

    const host = String(json.add ?? json.server ?? json.ps ?? '');
    if (!host) return null;
    const hostClean = validateNodeHost(host);

    const port = Number(json.port ?? json.p ?? 443);
    const portValid = validateNodePort(port);

    const userId = String(json.id ?? '');
    if (!userId) return null;

    const securityRaw = String(json.security ?? 'none').toLowerCase();
    const security: NodeSecurity = securityRaw === 'reality' ? 'reality'
      : securityRaw === 'tls' ? 'tls'
      : 'none';

    const transportRaw = String(json.net ?? json.network ?? 'tcp').toLowerCase();
    const transport: NodeTransport = transportRaw === 'ws' ? 'ws'
      : transportRaw === 'grpc' ? 'grpc'
      : transportRaw === 'h2' || transportRaw === 'http' ? 'http'
      : transportRaw === 'quic' ? 'quic'
      : 'tcp';

    const sni = security !== 'none' ? String(json.sni ?? hostClean) : null;
    const path = transport === 'ws' ? String(json.path ?? '/') : null;
    const hostHeader = transport === 'ws' ? String(json.host ?? hostClean) : null;
    const serviceName = transport === 'grpc' ? String(json.serviceName ?? '') : null;
    const flow = json.flow ? String(json.flow) : null;
    const alterId = json.aid != null ? Number(json.aid) : null;
    const allowInsecure = json.allowInsecure === true || json.allowInsecure === '1';

    return {
      config: {
        protocol: 'vless',
        host: hostClean,
        port: normalizeNodePort('vless', security, portValid),
        transport,
        security,
        sni,
        alpn: transport === 'grpc' ? ['h2', 'http/1.1'] : [],
        flow,
        alterId,
        path,
        hostHeader,
        serviceName,
        allowInsecure,
        realityPublicKey: security === 'reality' ? String(json.pbk ?? '') : null,
        realityShortId: security === 'reality' ? String(json.sid ?? '') : null,
        realityServerName: security === 'reality' ? String(json.sn ?? '') : null,
        encryption: null,
        ssrProtocol: null,
        remark: json.remarks ? String(json.remarks) : null,
        extra: json,
      },
      secret: userId,
    };
  } catch {
    return null;
  }
}

/** Standard VLESS URI: vless://uuid@host:port?params#remark (the universal format). */
function parseVlessSip002(body: string): VlessParseResult | null {
  try {
    const hashIdx = body.indexOf('#');
    const main = hashIdx >= 0 ? body.slice(0, hashIdx) : body;
    const remarkRaw = hashIdx >= 0 ? body.slice(hashIdx + 1) : '';
    const remark = remarkRaw ? decodeURIComponentSafe(remarkRaw) : null;

    const qIdx = main.indexOf('?');
    const authority = qIdx >= 0 ? main.slice(0, qIdx) : main;
    const params = new URLSearchParams(qIdx >= 0 ? main.slice(qIdx + 1) : '');

    const atIdx = authority.lastIndexOf('@');
    if (atIdx === -1) return null;
    const userId = authority.slice(0, atIdx);
    let hostPort = authority.slice(atIdx + 1);
    // some exporters append a stray '/' after the port (host:443/?type=…)
    if (hostPort.endsWith('/')) hostPort = hostPort.slice(0, -1);
    if (!userId || !hostPort) return null;

    // host may be bracketed IPv6
    let host: string;
    let portRaw: string;
    if (hostPort.startsWith('[')) {
      const close = hostPort.indexOf(']');
      if (close === -1) return null;
      host = hostPort.slice(1, close);
      portRaw = hostPort.slice(close + 1).replace(/^:/, '');
    } else {
      const colon = hostPort.lastIndexOf(':');
      if (colon === -1) return null;
      host = hostPort.slice(0, colon);
      portRaw = hostPort.slice(colon + 1);
    }
    const hostClean = validateNodeHost(host);
    const portValid = validateNodePort(Number(portRaw || 443));

    const securityRaw = (params.get('security') ?? 'none').toLowerCase();
    const security: NodeSecurity = securityRaw === 'reality' ? 'reality'
      : securityRaw === 'tls' ? 'tls'
      : 'none';

    const transportRaw = (params.get('type') ?? 'tcp').toLowerCase();
    const transport: NodeTransport = transportRaw === 'ws' ? 'ws'
      : transportRaw === 'grpc' ? 'grpc'
      : transportRaw === 'h2' || transportRaw === 'http' ? 'http'
      : transportRaw === 'quic' ? 'quic'
      : 'tcp';

    const sniParam = params.get('sni');
    const sni = security !== 'none' ? (sniParam || hostClean) : null;
    const path = transport === 'ws' || transport === 'http' ? (params.get('path') ?? '/') : null;
    const hostHeader = transport === 'ws' || transport === 'http' ? (params.get('host') ?? hostClean) : null;
    const serviceName = transport === 'grpc' ? (params.get('serviceName') ?? '') : null;
    const flow = params.get('flow');
    const allowInsecure = params.get('allowInsecure') === '1' || params.get('insecure') === '1';

    const extra: Record<string, unknown> = { mode: params.get('mode') ?? null, headerType: params.get('headerType') ?? null };

    return {
      config: {
        protocol: 'vless',
        host: hostClean,
        port: normalizeNodePort('vless', security, portValid),
        transport,
        security,
        sni,
        alpn: transport === 'grpc' ? ['h2', 'http/1.1'] : [],
        flow: flow || null,
        alterId: null,
        path,
        hostHeader,
        serviceName,
        allowInsecure,
        realityPublicKey: security === 'reality' ? (params.get('pbk') ?? null) : null,
        realityShortId: security === 'reality' ? (params.get('sid') ?? null) : null,
        realityServerName: security === 'reality' ? (params.get('sni') ?? null) : null,
        encryption: params.get('encryption') ?? null,
        ssrProtocol: null,
        remark,
        extra,
      },
      secret: userId,
    };
  } catch {
    return null;
  }
}

/** decodeURIComponent that never throws (malformed % sequences stay literal). */
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* -------------------------------- VMess parser -------------------------------- */

export interface VmessParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseVmessUri(text: string): VmessParseResult | null {
  try {
    const body = text.slice('vmess://'.length);
    // Modern non-standard variant: vmess://uuid@host:port?params (SIP002-ish).
    // Detect the same way as vless: '@' before '?'.
    const atIdx = body.indexOf('@');
    const qIdx = body.indexOf('?');
    if (atIdx !== -1 && (qIdx === -1 || atIdx < qIdx)) {
      const vlessLike = parseVlessSip002(body);
      if (vlessLike) {
        return {
          config: { ...vlessLike.config, protocol: 'vmess', alterId: 0 },
          secret: vlessLike.secret,
        };
      }
      return null;
    }
    const decoded = base64SafeDecode(body);
    const json = JSON.parse(decoded) as Record<string, unknown>;

    const host = String(json.add ?? json.ps ?? json.server ?? '');
    if (!host) return null;
    const hostClean = validateNodeHost(host);

    const port = Number(json.port ?? 443);
    const portValid = validateNodePort(port);

    const userId = String(json.id ?? '');
    if (!userId) return null;

    const tlsEnabled = json.tls === true || String(json.tls).toLowerCase() === 'tls';
    const security: NodeSecurity = tlsEnabled ? 'tls' : 'none';

    const transportRaw = String(json.net ?? 'tcp').toLowerCase();
    const transport: NodeTransport = transportRaw === 'ws' ? 'ws'
      : transportRaw === 'grpc' ? 'grpc'
      : transportRaw === 'h2' ? 'http'
      : 'tcp';

    const sni = tlsEnabled ? String(json.sni ?? hostClean) : null;
    const path = transport === 'ws' ? String(json.path ?? '/') : null;
    const hostHeader = transport === 'ws' ? String(json.host ?? hostClean) : null;
    const serviceName = transport === 'grpc' ? String(json.path ?? '') : null;
    const alterId = Number(json.aid ?? 0);
    const allowInsecure = false;

    return {
      config: {
        protocol: 'vmess',
        host: hostClean,
        port: normalizeNodePort('vmess', security, portValid),
        transport,
        security,
        sni,
        alpn: [],
        alterId,
        path,
        hostHeader,
        serviceName,
        allowInsecure,
        flow: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        encryption: null,
        ssrProtocol: null,
        remark: json.remarks ? String(json.remarks) : null,
        extra: json,
      },
      secret: userId,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- Trojan parser -------------------------------- */

export interface TrojanParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseTrojanUri(text: string): TrojanParseResult | null {
  try {
    const u = new URL(text);
    if (u.protocol !== 'trojan:') return null;

    const password = decodeURIComponent(u.username);
    if (!password) return null;

    const host = validateNodeHost(u.hostname);
    const port = validateNodePort(u.port ?? 443);

    const sni = u.searchParams.has('sni') ? u.searchParams.get('sni')! : host;
    const allowInsecure = u.searchParams.get('allowInsecure') === '1';
    const transportRaw = u.searchParams.get('type') ?? 'tcp';
    const transport: NodeTransport = transportRaw === 'ws' ? 'ws'
      : transportRaw === 'grpc' ? 'grpc'
      : 'tcp';

    const path = transport === 'ws' ? u.searchParams.get('path') ?? '/' : null;
    const hostHeader = transport === 'ws' ? (u.searchParams.get('host') ?? host) : null;

    return {
      config: {
        protocol: 'trojan',
        host,
        port: normalizeNodePort('trojan', 'tls', port),
        transport,
        security: 'tls',
        sni,
        alpn: [],
        path,
        hostHeader,
        serviceName: null,
        allowInsecure,
        flow: null,
        alterId: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        encryption: null,
        ssrProtocol: null,
        remark: u.hash ? decodeURIComponent(u.hash.slice(1)) : null,
        extra: null,
      },
      secret: password,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- Shadowsocks parser -------------------------------- */

export interface SSParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseShadowsocksUri(text: string): SSParseResult | null {
  try {
    const rest = text.slice('ss://'.length);
    // query first: queries can contain '@' (e.g. ?note=@SomeChannel), which
    // would corrupt a naive lastIndexOf('@') split
    const qIdx = rest.indexOf('?');
    const noQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const hashIdx = noQuery.indexOf('#');
    const main = hashIdx >= 0 ? noQuery.slice(0, hashIdx) : noQuery;
    const remark = hashIdx >= 0 ? decodeURIComponentSafe(rest.slice(hashIdx + 1, qIdx >= 0 ? undefined : undefined)) : null;

    let method: string;
    let password: string;
    let host: string;
    let port: number;

    if (main.includes('@')) {
      // SIP002: userinfo@host:port. The server part is AFTER the LAST '@'
      // (2022 ciphers put ':'-containing secrets, and some emit an extra
      // ':'-separated ephemeral key, before the '@').
      const at = main.lastIndexOf('@');
      const userinfo = main.slice(0, at);
      const serverpart = main.slice(at + 1).split('?')[0]!;
      // userinfo may be base64(method:pass) OR plain "method:pass[:ephemeral]"
      const decodedUserinfo = base64SafeDecode(userinfo);
      let cred: string;
      if (decodedUserinfo !== userinfo && decodedUserinfo.includes(':')) {
        cred = decodedUserinfo;
      } else {
        cred = decodeURIComponentSafe(userinfo);
      }
      const sep = cred.indexOf(':');
      if (sep < 0) return null;
      method = cred.slice(0, sep);
      password = cred.slice(sep + 1);
      const h = serverpart.startsWith('[')
        ? serverpart.slice(1, serverpart.indexOf(']'))
        : serverpart.split(':').slice(0, -1).join(':');
      const p = serverpart.startsWith('[')
        ? serverpart.slice(serverpart.indexOf(']') + 1).replace(/^:/, '').split('?')[0]!
        : serverpart.split(':').pop();
      if (!h || !p) return null;
      host = validateNodeHost(h);
      port = validateNodePort(Number(p));
    } else {
      const decoded = base64SafeDecode(main);
      const at = decoded.lastIndexOf('@');
      if (at < 0) return null;
      const [cred, serverpart] = [decoded.slice(0, at), decoded.slice(at + 1)];
      const sep = cred.indexOf(':');
      if (sep < 0 || !serverpart.includes(':')) return null;
      method = cred.slice(0, sep);
      password = cred.slice(sep + 1);
      const [h, p] = serverpart.split(':');
      if (!h || !p) return null;
      host = validateNodeHost(h);
      port = validateNodePort(Number(p));
    }

    if (!method || !password || !host || !Number.isFinite(port)) return null;

    return {
      config: {
        protocol: 'shadowsocks',
        host,
        port: normalizeNodePort('shadowsocks', 'none', port),
        transport: 'tcp',
        security: 'none',
        sni: null,
        alpn: [],
        encryption: method,
        path: null,
        hostHeader: null,
        serviceName: null,
        allowInsecure: false,
        flow: null,
        alterId: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        ssrProtocol: null,
        remark,
        extra: null,
      },
      secret: password,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- SSR parser (best-effort) -------------------------------- */

export interface SSRParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseSsrUri(text: string): SSRParseResult | null {
  try {
    // ssr://base64(method+":"+password+"@"+"host:port"/proto/nobase/?params)#
    const rest = text.slice('ssr://'.length);
    const hashIdx = rest.indexOf('#');
    const main = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const remark = hashIdx >= 0 ? decodeURIComponent(rest.slice(hashIdx + 1)) : null;

    const decoded = base64SafeDecode(main);
    const slashIdx = decoded.indexOf('/');
    if (slashIdx < 0) return null;

    const addrPart = decoded.slice(0, slashIdx);
    const paramsPart = decoded.slice(slashIdx + 1);

    const atIdx = addrPart.indexOf('@');
    if (atIdx < 0) return null;

    const credPart = addrPart.slice(0, atIdx);
    const serverPart = addrPart.slice(atIdx + 1);
    const credDecoded = base64SafeDecode(credPart);
    const colonIdx = credDecoded.indexOf(':');
    if (colonIdx < 0) return null;

    const method = credDecoded.slice(0, colonIdx);
    const password = credDecoded.slice(colonIdx + 1);
    const [host, portStr] = serverPart.split(':');
    if (!host || !portStr) return null;

    const hostClean = validateNodeHost(host);
    const port = validateNodePort(Number(portStr));
    const proto = paramsPart.includes('/') ? paramsPart.split('/')[0] : 'origin';
    const params = new URLSearchParams(paramsPart.includes('/') ? paramsPart.slice(paramsPart.indexOf('/') + 1) : '');

    return {
      config: {
        protocol: 'shadowsocksr',
        host: hostClean,
        port: normalizeNodePort('shadowsocksr', 'none', port),
        transport: 'tcp',
        security: 'none',
        sni: null,
        alpn: [],
        encryption: method,
        ssrProtocol: proto,
        path: null,
        hostHeader: null,
        serviceName: null,
        allowInsecure: false,
        flow: null,
        alterId: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        remark,
        extra: Object.fromEntries(params),
      },
      secret: password,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- Hysteria2 parser -------------------------------- */

export interface Hy2ParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseHysteria2Uri(text: string): Hy2ParseResult | null {
  try {
    // Auth strings frequently contain '/' and other characters that make
    // `new URL` misparse the authority — extract userinfo@host manually,
    // then parse only the query string with URLSearchParams.
    const scheme = text.startsWith('hysteria2://') ? 'hysteria2://' : text.startsWith('hy2://') ? 'hy2://' : null;
    if (!scheme) return null;
    const rest = text.slice(scheme.length);
    const hashIdx = rest.indexOf('#');
    const main = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const remarkRaw = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
    const remark = remarkRaw ? decodeURIComponentSafe(remarkRaw) : null;
    const qIdx = main.indexOf('?');
    const authority = qIdx >= 0 ? main.slice(0, qIdx) : main;
    const params = new URLSearchParams(qIdx >= 0 ? main.slice(qIdx + 1) : '');

    const atIdx = authority.lastIndexOf('@');
    if (atIdx === -1) return null;
    const password = decodeURIComponentSafe(authority.slice(0, atIdx));
    if (!password) return null;
    let hostPort = authority.slice(atIdx + 1);
    if (hostPort.endsWith('/')) hostPort = hostPort.slice(0, -1);

    let host: string;
    let portStr: string;
    if (hostPort.startsWith('[')) {
      const close = hostPort.indexOf(']');
      if (close === -1) return null;
      host = hostPort.slice(1, close);
      portStr = hostPort.slice(close + 1).replace(/^:/, '');
    } else {
      const colon = hostPort.lastIndexOf(':');
      if (colon === -1) return null;
      host = hostPort.slice(0, colon);
      portStr = hostPort.slice(colon + 1);
    }

    const hostClean = validateNodeHost(host);
    const port = validateNodePort(Number(portStr || 443));
    const sni = params.has('sni') ? params.get('sni')! : hostClean;

    const up = params.get('up') ?? params.get('upload') ?? '';
    const down = params.get('down') ?? params.get('download');
    const auth = params.get('auth');
    const ota = params.get('ota') === '1';

    const extra: Record<string, unknown> = {};
    if (up) extra.up = Number(up);
    if (down) extra.down = Number(down);
    if (auth) extra.auth = auth;
    extra.ota = ota;

    return {
      config: {
        protocol: 'hysteria2',
        host,
        port: normalizeNodePort('hysteria2', 'tls', port),
        transport: 'udp',
        security: 'tls',
        sni,
        alpn: [],
        path: null,
        hostHeader: null,
        serviceName: null,
        allowInsecure: params.get('allowInsecure') === '1' || params.get('insecure') === '1',
        flow: null,
        alterId: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        encryption: null,
        ssrProtocol: null,
        remark,
        extra: { ...extra, obfs: params.get('obfs') ?? null, obfsPassword: params.get('obfs-password') ?? null },
      },
      secret: password,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- TUIC parser -------------------------------- */

export interface TuicParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseTuicUri(text: string): TuicParseResult | null {
  try {
    const u = new URL(text);
    if (u.protocol !== 'tuic:') return null;

    const password = decodeURIComponent(u.username);
    if (!password) return null;

    const host = validateNodeHost(u.hostname);
    const port = validateNodePort(u.port ?? 443);
    const sni = u.searchParams.has('sni') ? u.searchParams.get('sni')! : host;

    const user = u.searchParams.get('user') ?? '';
    const group = u.searchParams.get('group') ?? '';
    const alpn = u.searchParams.get('alpn') ?? 'h3';

    const extra: Record<string, unknown> = {};
    if (user) extra.user = user;
    if (group) extra.group = group;
    extra.alpn = alpn;

    return {
      config: {
        protocol: 'tuic',
        host,
        port: normalizeNodePort('tuic', 'tls', port),
        transport: 'quic',
        security: 'tls',
        sni,
        alpn: [alpn],
        path: null,
        hostHeader: null,
        serviceName: null,
        allowInsecure: false,
        flow: null,
        alterId: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        encryption: null,
        ssrProtocol: null,
        remark: u.hash ? decodeURIComponent(u.hash.slice(1)) : null,
        extra,
      },
      secret: password,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- WireGuard parser -------------------------------- */

export interface WGParseResult {
  config: ParsedNodeConfig;
  secret: string;
}

export function parseWireguardUri(text: string): WGParseResult | null {
  try {
    const u = new URL(text);
    if (u.protocol !== 'wireguard://') return null;

    // wireguard://publicKey@host:port?ip=...&dns=...#name
    const pubKey = u.username || u.searchParams.get('publicKey');
    if (!pubKey) return null;

    const host = validateNodeHost(u.hostname);
    const port = validateNodePort(u.port ?? 51820);
    const allowedIp = u.searchParams.get('ip') ?? '0.0.0.0/0';
    const dns = u.searchParams.get('dns');
    const preSharedKey = u.searchParams.get('psk');

    const extra: Record<string, unknown> = {
      allowedIp,
      dns: dns ?? '1.1.1.1',
    };
    if (preSharedKey) extra.preSharedKey = preSharedKey;

    // WireGuard doesn't expose secrets through the URI public key
    // The private key must come separately (not in public configs)
    return {
      config: {
        protocol: 'wireguard',
        host,
        port,
        transport: 'udp',
        security: 'none',
        sni: null,
        alpn: [],
        path: null,
        hostHeader: null,
        serviceName: null,
        allowInsecure: false,
        flow: null,
        alterId: null,
        realityPublicKey: null,
        realityShortId: null,
        realityServerName: null,
        encryption: null,
        ssrProtocol: null,
        remark: u.hash ? decodeURIComponent(u.hash.slice(1)) : null,
        extra,
        // Note: the publicKey is stored in extra - we don't include it in fingerprint
        // since it's already the identifier
      },
      secret: pubKey, // public key is not secret
    };
  } catch {
    return null;
  }
}

/* -------------------------------- unified parser -------------------------------- */

export type UriParseResult =
  | { protocol: 'vless'; result: VlessParseResult }
  | { protocol: 'vmess'; result: VmessParseResult }
  | { protocol: 'trojan'; result: TrojanParseResult }
  | { protocol: 'shadowsocks'; result: SSParseResult }
  | { protocol: 'shadowsocksr'; result: SSRParseResult }
  | { protocol: 'hysteria2'; result: Hy2ParseResult }
  | { protocol: 'tuic'; result: TuicParseResult }
  | { protocol: 'wireguard'; result: WGParseResult }
  | { protocol: 'unknown'; result: null };

export function parseNodeUri(text: string): UriParseResult {
  const protocol = detectUriProtocol(text);
  if (!protocol) return { protocol: 'unknown', result: null };

  /* eslint-disable @typescript-eslint/no-explicit-any -- protocol-specific parsers return heterogeneous result shapes */
  const parse = (fn: (t: string) => any, proto: string): UriParseResult => {
    try {
      const r = fn(text);
      if (r === null || r === undefined) return { protocol: proto as any, result: null };
      return { protocol: proto as any, result: r } as UriParseResult;
    } catch {
      return { protocol: proto as any, result: null };
    }
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  switch (protocol) {
    case 'vless':
      return parse(parseVlessUri, 'vless') as UriParseResult;
    case 'vmess':
      return parse(parseVmessUri, 'vmess') as UriParseResult;
    case 'trojan':
      return parse(parseTrojanUri, 'trojan') as UriParseResult;
    case 'shadowsocks':
      return parse(parseShadowsocksUri, 'shadowsocks') as UriParseResult;
    case 'shadowsocksr':
      return parse(parseSsrUri, 'shadowsocksr') as UriParseResult;
    case 'hysteria2':
      return parse(parseHysteria2Uri, 'hysteria2') as UriParseResult;
    case 'tuic':
      return parse(parseTuicUri, 'tuic') as UriParseResult;
    case 'wireguard':
      return parse(parseWireguardUri, 'wireguard') as UriParseResult;
    default:
      return { protocol: 'unknown', result: null } as UriParseResult;
  }
}

/* -------------------------------- fingerprint helpers -------------------------------- */

/** Build a canonical fingerprint JSON-safe object from a parsed config. */
export function buildFingerprint(config: ParsedNodeConfig): NodeFingerprint {
  return fingerprintFromParsed(config);
}

/** Derive display fields from a parsed config (no secrets). */
export function buildNodeDisplay(config: ParsedNodeConfig): Pick<ParsedNodeConfig, 'protocol' | 'host' | 'port' | 'transport' | 'security' | 'sni' | 'path' | 'hostHeader' | 'serviceName' | 'flow' | 'allowInsecure' | 'encryption' | 'ssrProtocol' | 'remark' | 'extra'> {
  return {
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    transport: config.transport,
    security: config.security,
    sni: config.sni,
    path: config.path,
    hostHeader: config.hostHeader,
    serviceName: config.serviceName,
    flow: config.flow,
    allowInsecure: config.allowInsecure,
    encryption: config.encryption,
    ssrProtocol: config.ssrProtocol,
    remark: config.remark,
    extra: config.extra,
  };
}

/** Protocol display/label helpers. */
export const PROTOCOL_LABELS: Record<NodeProtocol, string> = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  shadowsocks: 'Shadowsocks',
  shadowsocksr: 'ShadowsocksR',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  wireguard: 'WireGuard',
  unknown: 'Unknown',
};

export const TRANSPORT_LABELS: Record<NodeTransport, string> = {
  tcp: 'TCP',
  ws: 'WebSocket',
  grpc: 'gRPC',
  http: 'HTTP',
  quic: 'QUIC',
  udp: 'UDP',
  reality: 'Reality',
  none: 'None',
  unknown: 'Unknown',
};

export const SECURITY_LABELS: Record<NodeSecurity, string> = {
  none: 'None',
  tls: 'TLS',
  reality: 'Reality',
  unknown: 'Unknown',
};

/** HTTP URI for public config import (not a VPN protocol; treat as opaque). */
export function parseHttpUri(text: string): { host: string; port: number; path: string } | null {
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = validateNodeHost(u.hostname);
    const port = validateNodePort(u.port ?? (u.protocol === 'https:' ? 443 : 80));
    return { host, port, path: u.pathname || '/' };
  } catch {
    return null;
  }
}
