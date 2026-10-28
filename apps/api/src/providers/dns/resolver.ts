import dgram from 'node:dgram';
import dnsPromises from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

import { isPrivateIp } from '../../util/targetGuard';
import {
  DnsClass,
  DnsType,
  Rcode,
  decodeDnsResponse,
  encodeDnsQuery,
} from './codec';

import type { DnsResponse } from './codec';

/**
 * SSRF guard for DoH endpoints (custom resolvers are user input): https only,
 * host must be a public literal or resolve publicly, default/declared port
 * only. Enforced at the query layer so every call site is covered.
 */
export function assertPublicDohUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid DoH URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`DoH URL must use https (got "${parsed.protocol}")`);
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`DoH host "${host}" is a private/loopback/metadata address and is not allowed`);
    }
  }
  if (parsed.port && (Number(parsed.port) <= 0 || Number(parsed.port) > 65535 || parsed.port === '0')) {
    throw new Error(`DoH URL has an invalid port: "${parsed.port}"`);
  }
  return parsed;
}

export interface DnsQueryOptions {
  timeoutMs?: number;
  klass?: number;
  port?: number;
  /** attach EDNS0 with the DO bit */
  dnssec?: boolean;
  /** HTTP CONNECT proxy for TCP DNS (e.g. http://127.0.0.1:10808) */
  proxy?: string;
}

export interface DnsQueryResult {
  response: DnsResponse | null;
  ms: number;
  error?: string;
}

/** Single UDP DNS query against a literal server IP. */
export function udpQuery(server: string, name: string, qtype: number, opts: DnsQueryOptions = {}): Promise<DnsQueryResult> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const port = opts.port ?? 53;
  const klass = opts.klass ?? DnsClass.IN;
  const id = (Math.random() * 0xffff) | 0;

  return new Promise((resolve) => {
    let msg: Buffer;
    try {
      msg = encodeDnsQuery(id, name, qtype, { klass, edns: opts.dnssec, dnssecOk: opts.dnssec });
    } catch (err) {
      resolve({ response: null, ms: 0, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const socket = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
    const start = process.hrtime.bigint();
    let done = false;

    const finish = (error?: string, response?: DnsResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ response: response ?? null, ms: Math.round(ms * 100) / 100, error });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    socket.once('error', (err) => finish(err.message));
    socket.once('message', (data) => {
      try {
        const response = decodeDnsResponse(data);
        if (response.id !== id) {
          finish('mismatched transaction id');
          return;
        }
        finish(undefined, response);
      } catch (err) {
        finish(err instanceof Error ? err.message : 'malformed response');
      }
    });

    socket.send(msg, port, server, (err) => {
      if (err) finish(err.message);
    });
  });
}

/**
 * Single TCP DNS query against a literal server IP (RFC 1035 §4.2.2).
 *
 * This is not a port-open probe: it writes a length-prefixed query and
 * requires a decodable response with the matching transaction id. TCP/53 is
 * the path Soar uses when UDP is intercepted, so an open socket alone proves
 * nothing.
 */
export async function tcpQuery(server: string, name: string, qtype: number, opts: DnsQueryOptions = {}): Promise<DnsQueryResult> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const port = opts.port ?? 53;
  const klass = opts.klass ?? DnsClass.IN;
  const id = (Math.random() * 0xffff) | 0;

  let msg: Buffer;
  try {
    msg = encodeDnsQuery(id, name, qtype, { klass, edns: opts.dnssec, dnssecOk: opts.dnssec });
  } catch (err) {
    return { response: null, ms: 0, error: err instanceof Error ? err.message : String(err) };
  }

  const start = process.hrtime.bigint();
  let socket: net.Socket;
  try {
    socket = await connectTcp(server, port, opts.proxy, timeoutMs);
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { response: null, ms: Math.round(ms * 100) / 100, error: err instanceof Error ? err.message : String(err) };
  }

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (error?: string, response?: DnsResponse) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ response: response ?? null, ms: Math.round(ms * 100) / 100, error });
    };

    timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.setNoDelay(true);
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(msg.length, 0);
    socket.write(Buffer.concat([prefix, msg]));
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) return;
      try {
        const response = decodeDnsResponse(buf.subarray(2, 2 + len));
        if (response.id !== id) {
          finish('mismatched transaction id');
          return;
        }
        finish(undefined, response);
      } catch (err) {
        finish(err instanceof Error ? err.message : 'malformed response');
      }
    });
    socket.once('error', (err) => finish(err.message));
    socket.once('close', () => {
      if (!done) finish('connection closed before a response');
    });
  });
}

/**
 * Open a TCP connection, optionally through a local HTTP CONNECT proxy.
 *
 * A DNS tunnel on a host with an active TUN can still use TCP/53 through the
 * user's proxy without touching the TUN or the system route. Only `http://`
 * proxies are accepted; no credentials are read from or written to logs.
 */
async function connectTcp(server: string, port: number, proxy: string | undefined, timeoutMs: number): Promise<net.Socket> {
  if (!proxy) {
    const socket = net.connect({ host: server, port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    return socket;
  }

  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error('proxy must be an http://host:port URL');
  }
  if (url.protocol !== 'http:') throw new Error('proxy must use http:// (HTTP CONNECT)');
  if (url.username || url.password) throw new Error('proxy credentials are not supported');
  const proxyPort = Number(url.port || 80);
  if (!url.hostname || !Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) {
    throw new Error('proxy must be an http://host:port URL');
  }

  const socket = net.connect({ host: url.hostname, port: proxyPort });
  return new Promise<net.Socket>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('proxy connect timeout')); }, timeoutMs);
    const fail = (err: Error) => { clearTimeout(timer); socket.destroy(); reject(err); };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onData);
      clearTimeout(timer);
      const status = buf.slice(0, end).split('\r\n')[0] ?? '';
      if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
        fail(new Error(`proxy CONNECT failed: ${status.slice(0, 80)}`));
        return;
      }
      socket.removeListener('error', fail);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${server}:${port} HTTP/1.1\r\nHost: ${server}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });
  });
}

/** DoH query (RFC 8484 POST, application/dns-message). */
export async function dohQuery(url: string, name: string, qtype: number, opts: DnsQueryOptions = {}): Promise<DnsQueryResult> {
  assertPublicDohUrl(url);
  // Resolve-time guard for hostname URLs (parity with the DoT guard): a DoH
  // host that statically resolves to a private/loopback/metadata address is
  // refused. `assertPublicDohUrl` only covers literal IP hosts.
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host) === 0) {
    let resolved: { address: string }[];
    try {
      resolved = await dnsPromises.lookup(host, { all: true, verbatim: true });
    } catch (err) {
      return { response: null, ms: 0, error: `DoH host "${host}" could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
    }
    const hit = resolved.find((r) => isPrivateIp(r.address));
    if (hit) {
      return { response: null, ms: 0, error: `DoH host "${host}" resolves to a private/loopback address (${hit.address}) and is not allowed` };
    }
  }
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const id = (Math.random() * 0xffff) | 0;
  const start = process.hrtime.bigint();

  const wire = encodeDnsQuery(id, name, qtype, { edns: opts.dnssec, dnssecOk: opts.dnssec });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: new Uint8Array(wire),
      signal: controller.signal,
      // A public DoH endpoint never redirects; following one could bounce the
      // request at an internal address (redirect-based SSRF).
      redirect: 'error',
    });
    if (!res.ok) {
      return { response: null, ms: Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100, error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const response = decodeDnsResponse(buf);
    return { response, ms: Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { response: null, ms: Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100, error: message === 'This operation was aborted' ? 'timeout' : message };
  } finally {
    clearTimeout(timer);
  }
}

/** DoT query (RFC 7858, TLS-transported DNS on port 853). Pure-JS TLS client
 * built on node:tls — no external dependency; the wire encoding is shared with
 * UDP/DoH through the existing DNS codec. Each DNS message is framed with a
 * 2-byte length prefix as required by RFC 7858. TLS certificate validation is
 * performed against the resolver hostname (servername SNI).
 */
export function dotQuery(hostname: string, name: string, qtype: number, opts: DnsQueryOptions = {}): Promise<DnsQueryResult> {
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const port = opts.port ?? 853;
  const start = process.hrtime.bigint();
  const id = (Math.random() * 0xffff) | 0;

  const wire = encodeDnsQuery(id, name, qtype, { edns: opts.dnssec, dnssecOk: opts.dnssec });

  const result = (data: Buffer | null, err?: string): DnsQueryResult => {
    const ms = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
    if (data === null) return { response: null, ms, error: err ?? 'tls error' };
    let response: DnsResponse | null = null;
    let decodeError: string | undefined;
    try {
      response = decodeDnsResponse(data);
    } catch (e) {
      decodeError = e instanceof Error ? e.message : 'decode error';
    }
    if (response && response.id !== id) return { response: null, ms, error: 'mismatched transaction id' };
    return { response, ms, error: decodeError };
  };

  return new Promise<DnsQueryResult>((resolve) => {
    // SSRF guard: resolve the DoT host and connect to a validated public
    // literal (SNI/cert check stays on the hostname). A DNS rebinding after
    // this point changes nothing — we already hold the IP we dial.
    let buf = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let socket: tls.TLSSocket | null = null;

    const settle = (value: DnsQueryResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // already closed
      }
      resolve(value);
    };

    const startConnect = (dotHost: string) => {
    socket = tls.connect({ host: dotHost, port, servername: hostname, timeout: timeoutMs });
    timer = setTimeout(() => settle(result(null, 'timeout')), timeoutMs);

    socket.once('error', (err: Error) => settle(result(null, err.message)));
    socket.once('close', () => {
      if (buf.length > 0 && !settled) settle(result(buf));
    });
    socket.once('secureConnect', () => {
      try {
        socket?.write(wire);
      } catch {
        // socket closed concurrently
      }
    });
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // RFC 7858 framing: 2-byte big-endian length prefix, then the message.
      while (!settled && buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return; // wait for the rest
        const message = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        settle(result(message));
      }
    });
    };

    const guardFail = (message: string) => settle(result(null, message));
    const literal = net.isIP(hostname) !== 0 ? hostname : null;
    if (literal) {
      if (isPrivateIp(literal)) {
        guardFail(`DoT host "${hostname}" is a private/loopback/metadata address and is not allowed`);
        return;
      }
      startConnect(literal);
      return;
    }
    void (async () => {
      const dns = await import('node:dns/promises');
      const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
      const hit = resolved.find((r) => isPrivateIp(r.address));
      if (hit) throw new Error(`DoT host "${hostname}" resolves to a private/loopback address (${hit.address}) and is not allowed`);
      startConnect(resolved[0]?.address ?? hostname);
    })().catch((err) => guardFail(err instanceof Error ? err.message : 'dot dns error'));
  });
}
const KNOWN_RESOLVER_ORGS: { test: (ip: string) => boolean; org: string }[] = [
  { test: (ip) => /^(1\.1\.1\.|1\.0\.0\.|162\.158\.|172\.6[89]\.|172\.7[01]\.)/.test(ip), org: 'Cloudflare' },
  { test: (ip) => /^(8\.8\.8\.|8\.8\.4\.|2001:4860:)/.test(ip), org: 'Google Public DNS' },
  { test: (ip) => /^(9\.9\.9\.|149\.112\.112\.)/.test(ip), org: 'Quad9' },
  { test: (ip) => /^(208\.67\.222\.|208\.67\.220\.)/.test(ip), org: 'OpenDNS' },
  { test: (ip) => /^(94\.140\.14\.|94\.140\.15\.|2a10:50c0:)/.test(ip), org: 'AdGuard DNS' },
  { test: (ip) => /^185\.228\.168\./.test(ip), org: 'CleanBrowsing' },
  { test: (ip) => /^(76\.76\.)/.test(ip), org: 'Control D' },
  { test: (ip) => /^185\.222\.222\./.test(ip), org: 'DNS.SB' },
];

export function knownResolverOrg(ip: string): string | null {
  return KNOWN_RESOLVER_ORGS.find((r) => r.test(ip))?.org ?? null;
}

/**
 * Identify the egress resolver for `server`:
 *  - `o-o.myaddr.l.google.com` TXT (IN class) works on any resolver and
 *    returns the resolver's egress IP as the first TXT string.
 *  - `whoami.cloudflare` TXT (CH class) works on Cloudflare resolvers.
 * Returns null when the resolver does not support the technique.
 */
export async function resolverEgressIp(server: string, timeoutMs = 2_000): Promise<string | null> {
  const google = await udpQuery(server, 'o-o.myaddr.l.google.com', DnsType.TXT, { timeoutMs, klass: DnsClass.IN });
  const ip = google.response?.answers[0]?.txt?.[0];
  if (ip && /[\d.a-f:]+/i.test(ip)) return ip.trim();

  const cf = await udpQuery(server, 'whoami.cloudflare', DnsType.TXT, { timeoutMs, klass: DnsClass.CH });
  const cfIp = cf.response?.answers[0]?.txt?.[0];
  if (cfIp && /[\d.a-f:]+/i.test(cfIp)) return cfIp.trim();

  return null;
}

/**
 * DNSSEC validation probe: a validating resolver returns SERVFAIL for the
 * deliberately broken zone `dnssec-failed.org`. Returns null when the
 * resolver could not be reached at all.
 */
export async function dnssecValidating(server: string, timeoutMs = 2_500): Promise<boolean | null> {
  const res = await udpQuery(server, 'dnssec-failed.org', DnsType.A, { timeoutMs, dnssec: true });
  if (res.response === null) return null;
  if (res.response.rcode === Rcode.SERVFAIL) return true;
  if (res.response.rcode === Rcode.NOERROR) return false;
  return false;
}
