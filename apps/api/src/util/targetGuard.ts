import dns from 'node:dns/promises';
import net from 'node:net';

import type { IpFamily } from '@netpulse/shared';

import { badRequest } from './appError';

const TARGET_CHARSET = /^[a-zA-Z0-9._\-:\[\]]+$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

const V4_RESERVED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function isPrivateIpv4(ip: string): boolean {
  const asInt = ipv4ToInt(ip);
  if (asInt === null) return false;
  return V4_RESERVED.some(([base, bits]) => inCidr4(asInt, base, bits));
}

export function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip;
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx >= 0) addr = addr.slice(0, zoneIdx);
  const doubleColon = addr.split('::');
  if (doubleColon.length > 2) return null;
  const head = doubleColon[0] ? doubleColon[0].split(':').filter(Boolean) : [];
  const tail = doubleColon[1] !== undefined ? doubleColon[1].split(':').filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (doubleColon.length === 2 && missing < 0) return null;
  if (doubleColon.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...new Array(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    value = (value << 16n) | BigInt(n);
  }
  return value;
}

const V6_RESERVED: [bigint, number][] = [
  [0n, 128], // ::/128 unspecified
  [0n, 96], // ::/96 incl. v4-mapped ::ffff:0:0/96
  [0x64ff9bn << 96n, 96], // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052)
  [0xfc00n << 112n, 7], // ULA fc00::/7
  [0xfe80n << 112n, 10], // link-local fe80::/10
  [0xfec0n << 112n, 10], // site-local fec0::/10 (deprecated)
  [0xff00n << 112n, 8], // multicast ff00::/8
  [0x20010db8n << 96n, 32], // documentation 2001:db8::/32
];

function inCidr6(value: bigint, base: bigint, bits: number): boolean {
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (base & mask);
}

export function isPrivateIpv6(ip: string): boolean {
  const value = ipv6ToBigInt(ip);
  if (value === null) return false;
  return V6_RESERVED.some(([base, bits]) => inCidr6(value, base, bits));
}

export function isPrivateIp(ip: string): boolean {
  return net.isIP(ip) === 4 ? isPrivateIpv4(ip) : isPrivateIpv6(ip);
}

export interface ResolvedTarget {
  /** normalized host as entered (brackets stripped) */
  host: string;
  /** all resolved addresses; probing MUST use these, not the hostname */
  ips: string[];
  family: IpFamily | null;
}

/** DNS lookups must complete within this deadline so callers never hang on slow resolvers. */
const DNS_LOOKUP_TIMEOUT_MS = 4_000;

function lookupWithDeadline(host: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(badRequest(
        'dns_resolution_failed',
        `DNS resolution of "${host}" timed out after ${DNS_LOOKUP_TIMEOUT_MS / 1000}s`,
        'Your DNS resolver may be unresponsive. Check your DNS settings.',
      ));
    }, DNS_LOOKUP_TIMEOUT_MS);
    timer.unref();
    dns.lookup(host, { all: true, verbatim: true }).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * SSRF guard: validate syntax, resolve hostnames and refuse any target
 * that resolves into a private, loopback, link-local or reserved range.
 * Callers must probe the returned IPs (not the hostname) to close the
 * DNS-rebinding window.
 */
export async function resolveTarget(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<ResolvedTarget> {
  const host = raw.trim().replace(/^\[/, '').replace(/\]$/, '');

  if (!host || host.length > 253 || !TARGET_CHARSET.test(host)) {
    throw badRequest(
      'invalid_target',
      `"${raw}" is not a valid hostname or IP address`,
      'Use a hostname like example.com or an IPv4/IPv6 address.',
    );
  }

  if (opts.allowPrivate !== true) {
    const literalFamily = net.isIP(host);
    if (literalFamily !== 0 && isPrivateIp(host)) {
      throw badRequest(
        'private_target_not_allowed',
        `"${host}" is a private or reserved address and cannot be tested`,
        'Only public internet destinations can be probed.',
      );
    }
  }

  const literal = net.isIP(host);
  if (literal !== 0) {
    return { host, ips: [host], family: literal === 4 ? 4 : 6 };
  }

  if (!HOSTNAME_RE.test(host)) {
    throw badRequest('invalid_target', `"${host}" is not a valid hostname`);
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookupWithDeadline(host);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'dns_resolution_failed') {
      throw err;
    }
    throw badRequest(
      'dns_resolution_failed',
      `Could not resolve "${host}"`,
      'Check the spelling of the hostname or use an IP address instead.',
    );
  }

  if (resolved.length === 0) {
    throw badRequest('dns_resolution_failed', `"${host}" did not resolve to any address`);
  }

  if (opts.allowPrivate !== true) {
    const privateHit = resolved.find((r) => isPrivateIp(r.address));
    if (privateHit) {
      throw badRequest(
        'private_target_not_allowed',
        `"${host}" resolves to a private address (${privateHit.address}) and cannot be tested`,
        'Only public internet destinations can be probed.',
      );
    }
  }

  const ips = resolved.map((r) => r.address);
  const family = ips.some((ip) => net.isIP(ip) === 6) ? null : 4;
  return { host, ips, family };
}/** Pick the address matching the preferred family, defaulting to the first. */
export function pickIp(ips: string[], preferred?: IpFamily): string {
  if (preferred) {
    const match = ips.find((ip) => net.isIP(ip) === preferred);
    if (match) return match;
  }
  return ips[0]!;
}
export function familyOfIp(ip: string): IpFamily {
  return net.isIP(ip) === 6 ? 6 : 4;
}

/* ---------------------------- node config validation ---------------------------- */

/** Allowed URI schemes for imported node configs. */
export const NODE_URI_SCHEMES = new Set([
  'vmess:',
  'vless:',
  'trojan:',
  'ss:',
  'shadowsocks:',
  'ssr://',
  'hysteria2://',
  'hy2://',
  'tuic://',
  'wireguard://',
]);

/** Detect whether a string looks like a node URI (protocol-prefixed). */
export function looksLikeNodeUri(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.startsWith('ss://') && !t.startsWith('ssr://')) return true;
  if (t.startsWith('ssr://')) return true;
  if (t.startsWith('vmess://')) return true;
  if (t.startsWith('vless://')) return true;
  if (t.startsWith('trojan://')) return true;
  if (t.startsWith('hysteria2://') || t.startsWith('hy2://')) return true;
  if (t.startsWith('tuic://')) return true;
  if (t.startsWith('wireguard://')) return true;
  return false;
}

/** Well-known ports that node configs commonly advertise — used for display only, never for scanning. */
export const COMMON_NODE_PORTS = new Set([
  80, 443, 8443, 2053, 2083, 2087, 2096, 8080, 1234, 12345, 12346, 65535,
]);

/** Validate that a hostname/IP string is safe to probe from an imported node config. */
export function validateNodeHost(host: string): string {
  const h = host.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!h || h.length > 253) throw badRequest('invalid_node_host', `Invalid hostname/IP "${host}"`);
  const literal = net.isIP(h);
  if (literal !== 0) {
    if (literal === 4 && isPrivateIpv4(h)) throw badRequest('private_node_host', `Node host "${host}" is a private IPv4 address`);
    if (literal === 6 && isPrivateIpv6(h)) throw badRequest('private_node_host', `Node host "${host}" is a private IPv6 address`);
    if (h === '0.0.0.0' || h === '::' || h === '::1') throw badRequest('invalid_node_host', `Node host "${host}" is not a routable address`);
    return h;
  }
  if (!HOSTNAME_RE.test(h)) throw badRequest('invalid_node_host', `Invalid hostname "${host}"`);
  return h;
}

/** Validate a port number from a node config. */
export function validateNodePort(port: number | string | undefined): number {
  const p = port !== undefined ? Number(port) : NaN;
  if (!Number.isFinite(p) || p < 1 || p > 65535 || !Number.isInteger(p)) {
    throw badRequest('invalid_node_port', `Invalid port "${port}"`);
  }
  return p;
}

/** Normalize a port to a well-known default when omitted for a given protocol/security combo. */
export function normalizeNodePort(protocol: string, security: string | undefined, port?: number): number {
  if (port !== undefined && Number.isFinite(port) && port >= 1 && port <= 65535) return port;
  if (protocol === 'shadowsocks' || protocol === 'shadowsocksr') return 8388;
  if (protocol === 'tuic') return 443;
  if (protocol === 'hysteria2') return 443;
  if (protocol === 'wireguard') return 51820;
  if (security === 'tls' || security === 'reality') return 443;
  return 443;
}

