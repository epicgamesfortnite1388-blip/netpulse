import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

import { coloInfo, coloLabel } from '@netpulse/shared';

export { coloInfo, coloLabel };

/**
 * Cloudflare edge probing helpers, modeled on the methodology of the
 * SenPaiScanner project (MatinSenPai/SenPaiScanner, MIT): reachability is not
 * enough — a Cloudflare IP is only useful when it (a) is a genuine edge that
 * answers /cdn-cgi/trace with a colo code, (b) survives an idle hold instead of
 * being RST'd by DPI, and (c) can actually carry a data transfer. On filtered
 * networks (e.g. many Iranian ISPs) an endpoint can pass (a) while failing
 * (c) — trace succeeds but downloads stall — which is exactly what the
 * download probe exists to catch.
 */

/** SNI values used when probing raw Cloudflare edge IPs. Rotating the SNI
 *  reduces the chance of deep-packet-inspection blackholing. The edge answers
 *  /cdn-cgi/trace and serves speed.cloudflare.com from any of its IPs. */
export const CF_TRACE_HOSTS = [
  'speed.cloudflare.com',
  'www.cloudflare.com',
  'cloudflare.com',
  '1.1.1.1.cdn.cloudflare.net',
];

export const CF_DOWNLOAD_HOST = 'speed.cloudflare.com';

export interface CfTraceResult {
  ok: boolean;
  /** ms until response headers arrived (includes TCP + TLS) */
  ms: number | null;
  status: number | null;
  /** three-letter Cloudflare edge/colo code from the trace body or CF-Ray */
  colo: string | null;
  /** two-letter country code from the trace body (`loc`) */
  loc: string | null;
  server: string | null;
  host: string | null;
}

export interface CfDownloadResult {
  ok: boolean;
  /** bytes actually received */
  bytes: number;
  /** time to response headers, ms */
  ttfbMs: number | null;
  /** end-to-end throughput including connect, Mbps */
  mbps: number | null;
  status: number | null;
}

/* ------------------------------ parsing ---------------------------------- */

/** Parse a /cdn-cgi/trace body into its `key=value` fields. */
export function parseTraceBody(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return fields;
}

/** Extract the 3-letter colo code from a `CF-Ray: abc123-FRA` style header. */
export function parseColoFromRay(ray: string | null | undefined): string | null {
  if (!ray) return null;
  const parts = ray.split('-');
  if (parts.length < 2) return null;
  const colo = (parts[parts.length - 1] ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(colo) ? colo : null;
}

/* ------------------------------- trace ----------------------------------- */

/**
 * GET /cdn-cgi/trace against a literal Cloudflare IP. The connection is forced
 * to `ip:port` while the SNI + HTTP Host rotate over well-known Cloudflare
 * hostnames so the edge answers regardless of which datacenter the IP routes
 * to. Certificate verification is skipped (phase-1 discovery: any CF edge
 * answers trace over a mismatched-SNI default cert).
 */
export function cfTraceProbe(ip: string, port: number, timeoutMs = 3_000): Promise<CfTraceResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CfTraceResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };

    /** hostIndex < CF_TRACE_HOSTS.length → SNI attempt; equal → no-SNI fallback
     *  (some filtered networks drop TLS by SNI — including the CF hosts proxied
     *  by common VPN tools — while plain SNI-less TLS still reaches the edge). */
    const attempt = (hostIndex: number): void => {
      if (hostIndex > CF_TRACE_HOSTS.length) {
        finish({ ok: false, ms: null, status: null, colo: null, loc: null, server: null, host: null });
        return;
      }
      const host = hostIndex < CF_TRACE_HOSTS.length ? CF_TRACE_HOSTS[hostIndex]! : null;
      const httpHost = host ?? ip;
      const startedAt = process.hrtime.bigint();
      const transport = port === 80 ? http : https;
      const req = transport.request(
        {
          host: ip,
          port,
          path: '/cdn-cgi/trace',
          method: 'GET',
          headers: { host: httpHost, 'user-agent': 'NetPulse/1.0 (+local diagnostics)', accept: 'text/plain', connection: 'close' },
          ...(port !== 80 && host != null ? { servername: host, rejectUnauthorized: false } : {}),
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > 8_192) res.destroy();
          });
          res.on('end', () => {
            const fields = parseTraceBody(body);
            const colo = fields.get('colo') || parseColoFromRay(res.headers['cf-ray'] as string | undefined) || null;
            const loc = fields.get('loc') ?? null;
            const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
            finish({
              ok: res.statusCode != null && res.statusCode >= 200 && res.statusCode < 400,
              ms: Math.round(ms * 100) / 100,
              status: res.statusCode ?? null,
              colo,
              loc,
              server: (res.headers.server as string | undefined) ?? null,
              host: httpHost,
            });
          });
        },
      );
      req.once('timeout', () => req.destroy());
      req.once('error', () => attempt(hostIndex + 1)); // this SNI may be filtered — try the next / fall back to no-SNI
      req.setTimeout(timeoutMs);
      req.end();
    };

    attempt(0);
  });
}

/* ------------------------------ download --------------------------------- */

/**
 * Measure download throughput through a specific Cloudflare edge IP by pulling
 * `__down?bytes=N` from speed.cloudflare.com while forcing the TCP connection
 * to the candidate. Mirrors the SenPaiScanner download probe: this catches
 * endpoints that handshake and answer trace cleanly but stall on real data
 * (common on DPI-throttled / filtered networks).
 */
export function cfDownloadProbe(ip: string, port: number, bytes: number, timeoutMs = 15_000): Promise<CfDownloadResult> {
  return new Promise((resolve) => {
    if (port === 80) {
      resolve({ ok: false, bytes: 0, ttfbMs: null, mbps: null, status: null });
      return;
    }
    let done = false;
    const startedAt = process.hrtime.bigint();
    const finish = (r: CfDownloadResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };

    const req = https.request(
      {
        host: ip,
        port,
        path: `/__down?bytes=${bytes}`,
        method: 'GET',
        servername: CF_DOWNLOAD_HOST,
        rejectUnauthorized: false,
        headers: { host: CF_DOWNLOAD_HOST, 'user-agent': 'NetPulse/1.0 (+local diagnostics)', accept: '*/*', connection: 'close' },
      },
      (res) => {
        let received = 0;
        const ttfbMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const settle = () => {
          const elapsedSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
          const ok = res.statusCode != null && res.statusCode >= 200 && res.statusCode < 400 && received > 0;
          finish({
            ok,
            bytes: received,
            ttfbMs: Math.round(ttfbMs * 100) / 100,
            mbps: elapsedSec > 0 && received > 0 ? Math.round(((received * 8) / 1e6 / elapsedSec) * 100) / 100 : null,
            status: res.statusCode ?? null,
          });
        };
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received >= bytes) {
            res.destroy();
            settle();
          }
        });
        res.on('end', settle);
        res.on('close', settle);
        res.on('error', settle);
      },
    );
    req.once('timeout', () => req.destroy());
    req.once('error', () => finish({ ok: false, bytes: 0, ttfbMs: null, mbps: null, status: null }));
    req.setTimeout(timeoutMs);
    req.end();
  });
}

/* ----------------------------- idle hold --------------------------------- */

/**
 * SenPai-style idle-hold stability check: open a TLS connection to the edge and
 * wait without sending application data. DPI on filtered networks often lets
 * the initial GET through but RSTs long-lived TLS tunnels shortly after. A
 * timeout while idle means the connection survived; an early close/error means
 * DPI killed it.
 */
export function cfStabilityHold(ip: string, port: number, holdMs = 1_200): Promise<boolean> {
  return new Promise((resolve) => {
    if (port === 80) {
      resolve(true);
      return;
    }
    let settled = false;
    const socket = tls.connect({ host: ip, port, servername: CF_DOWNLOAD_HOST, rejectUnauthorized: false });
    // A TCP-accepting endpoint that never completes TLS (DPI blackhole) would
    // otherwise hold this promise forever — the whole hold is deadline-bound.
    const handshakeTimer = setTimeout(() => finish(false), holdMs + 4_000);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      socket.destroy();
      resolve(result);
    };
    socket.once('secureConnect', () => {
      const win = setTimeout(() => finish(true), holdMs); // idle timeout = survived
      socket.once('error', () => {
        clearTimeout(win);
        finish(false);
      });
      socket.once('close', () => {
        clearTimeout(win);
        finish(false);
      });
    });
    socket.once('error', () => finish(false));
  });
}

/* ------------------------- colo / region metadata ------------------------ */
// coloInfo / coloLabel / COLO_NAMES live in @netpulse/shared (models/colo) so
// the API and the web UI resolve edge codes identically.

/* --------------------------- clean verdict ------------------------------- */

export interface CleanVerdictInput {
  /** number of probe tries performed */
  tries: number;
  /** number of tries that succeeded */
  successes: number;
  /** average successful latency, ms */
  avgMs: number | null;
  /** whether a genuine CF edge answered trace with a colo */
  colo: string | null;
  /** whether a download sample was attempted */
  downloadAttempted: boolean;
  /** measured download throughput, Mbps */
  downloadMbps: number | null;
}

export interface CleanVerdict {
  clean: boolean;
  reasons: string[];
}

/**
 * SenPaiScanner IsHealthy() ported to this scanner's validation run:
 *  - >= 2 successful tries and loss < 50%
 *  - a genuine edge (colo known)
 *  - when a download was attempted it must have carried bytes — an endpoint
 *    that answers trace but cannot transfer data is NOT clean (the classic
 *    filtered-network failure mode), regardless of how fast it handshakes.
 */
export function cfCleanVerdict(input: CleanVerdictInput): CleanVerdict {
  const reasons: string[] = [];
  const successPct = input.tries > 0 ? (input.successes / input.tries) * 100 : 0;
  let clean = true;

  if (input.tries < 2 || input.successes < 2) {
    clean = false;
    reasons.push(`only ${input.successes}/${input.tries} probes succeeded`);
  } else if (successPct < 50) {
    clean = false;
    reasons.push(`packet loss ${Math.round((100 - successPct) * 10) / 10}% exceeds 50%`);
  }
  if (!input.colo) {
    clean = false;
    reasons.push('not a Cloudflare edge (no colo from /cdn-cgi/trace)');
  }
  if (input.downloadAttempted && (input.downloadMbps == null || input.downloadMbps <= 0)) {
    clean = false;
    reasons.push('edge answers probes but carried no download data — likely filtered');
  } else if (input.downloadAttempted && input.downloadMbps != null) {
    reasons.push(`downloaded ${input.downloadMbps.toFixed(1)} Mbps through this edge`);
  }
  if (clean && reasons.length === 0) reasons.push('reachable, stable, and carries traffic');
  return { clean, reasons };
}
