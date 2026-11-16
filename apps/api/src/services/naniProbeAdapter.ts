/**
 * NANI probe adapter — bridges the pure, deterministic NANI diagnosis core to
 * real network probes executed by the host.
 *
 * This is the *only* place that opens sockets or resolves hostnames on behalf
 * of NANI. The core never does I/O. Every probe returns a NANI
 * `DiagnosticObservation` plus a sanitized, credential-free error string.
 *
 * Probes are idempotent read-only measurements. They never mutate system
 * routing, DNS, firewall, or proxy configuration.
 */

import type {
  DiagnosticObservation,
  DiagnosticTest,
  NetworkLayer,
  ProbeOutcome,
} from '@netpulse/shared';

import type { PlatformNetworkController } from '../providers/platform/types';
import type { DnsService } from './dnsService';
import type { Logger } from '../logger';

const DNS_PORT = 53;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;

async function resolveHostname(
  controller: PlatformNetworkController,
  hostname: string,
): Promise<string | null> {
  try {
    const dns = await import('node:dns/promises');
    const res = await dns.lookup(hostname, { family: 4 });
    return res.address;
  } catch {
    return null;
  }
}

export async function runDiagnosticTest(
  controller: PlatformNetworkController,
  dns: DnsService,
  test: DiagnosticTest,
  target: string,
  now: number,
  log: Logger,
  /**
   * Path to request for the HTTP-bearing layers. API health checks need a
   * provider's own health path (`/healthz`), while a generic reachability probe
   * legitimately asks for `/`. Absent means the layer default.
   */
  pathOverride?: string,
): Promise<DiagnosticObservation> {
  const parts = target.split(':');
  const host = parts[0];
  const portStr = parts[1];
  const port = portStr ? parseInt(portStr, 10) : defaultPort(test.layer);
  const ip = host ? await resolveHostname(controller, host) : null;
  let outcome: ProbeOutcome = 'unknown';
  let reliability = 1;
  try {
    switch (test.layer) {
      case 'dns': {
        if (!host) { outcome = 'failure'; break; }
        const resolved = await resolveHostname(controller, host);
        outcome = resolved ? 'success' : 'failure';
        reliability = resolved ? 1 : 0.5;
        break;
      }
      case 'tcp': {
        if (!ip) { outcome = 'failure'; break; }
        const tcp = await controller
          .tcpProbe(ip, port, 5_000)
          .then((r) => ({ ok: r.ok, error: r.error }))
          .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        if (tcp.ok) outcome = 'success';
        else if (tcp.error?.includes('timeout')) outcome = 'timeout';
        else outcome = 'failure';
        reliability = 0.9;
        break;
      }
      case 'tls': {
        if (!ip) { outcome = 'failure'; break; }
        const tls = await import('node:tls');
        const net = await import('node:net');
        const socket = net.createConnection({ host: ip, port });
        const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: true });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('tls-timeout')), 5_000);
          tlsSocket.on('secureConnect', () => { clearTimeout(timer); resolve(); });
          tlsSocket.on('error', (err) => { clearTimeout(timer); reject(err); });
          tlsSocket.on('timeout', () => { clearTimeout(timer); reject(new Error('tls-timeout')); });
        });
        tlsSocket.end();
        outcome = 'success';
        reliability = 1.0;
        break;
      }
      case 'http': {
        if (!ip) { outcome = 'failure'; break; }
        const http = await import('node:http');
        const req = http.request({ host: ip, port, path: pathOverride ?? '/', method: 'GET', timeout: 5_000 });
        const res = await new Promise<{ statusCode: number | null; timedOut: boolean }>((resolve, reject) => {
          let timedOut = false;
          req.on('response', (resp) => { resolve({ statusCode: resp.statusCode ?? null, timedOut: false }); resp.resume(); });
          req.on('error', (err) => reject(err));
          req.on('timeout', () => { timedOut = true; req.destroy(); resolve({ statusCode: null, timedOut: true }); });
        });
        if (res.timedOut) outcome = 'timeout';
        else if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 400) outcome = 'success';
        else outcome = 'failure';
        reliability = 0.95;
        break;
      }
      case 'auth': {
        if (!ip) { outcome = 'failure'; break; }
        const http = await import('node:http');
        const req = http.request({ host: ip, port, path: '/', method: 'GET', timeout: 5_000 });
        const res = await new Promise<{ statusCode: number | null; timedOut: boolean }>((resolve, reject) => {
          let timedOut = false;
          req.on('response', (resp) => { resolve({ statusCode: resp.statusCode ?? null, timedOut: false }); resp.resume(); });
          req.on('error', (err) => reject(err));
          req.on('timeout', () => { timedOut = true; req.destroy(); resolve({ statusCode: null, timedOut: true }); });
        });
        if (res.timedOut) outcome = 'timeout';
        else if (res.statusCode === 401 || res.statusCode === 403) outcome = 'failure';
        else if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 400) outcome = 'success';
        else outcome = 'failure';
        reliability = 0.9;
        break;
      }
      case 'application': {
        if (!ip) { outcome = 'failure'; break; }
        const http = await import('node:http');
        const req = http.request({ host: ip, port, path: '/healthz', method: 'GET', timeout: 5_000 });
        const res = await new Promise<{ statusCode: number | null; timedOut: boolean }>((resolve, reject) => {
          let timedOut = false;
          req.on('response', (resp) => { resolve({ statusCode: resp.statusCode ?? null, timedOut: false }); resp.resume(); });
          req.on('error', (err) => reject(err));
          req.on('timeout', () => { timedOut = true; req.destroy(); resolve({ statusCode: null, timedOut: true }); });
        });
        if (res.timedOut) outcome = 'timeout';
        else if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) outcome = 'success';
        else outcome = 'failure';
        reliability = 0.9;
        break;
      }
      default:
        outcome = 'unknown';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ test: test.id, target, error: message }, 'nani probe error');
    if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      outcome = 'timeout';
    } else {
      outcome = 'failure';
    }
  }

  return { testId: test.id, outcome, at: now, reliability };
}

function defaultPort(layer: NetworkLayer): number {
  switch (layer) {
    case 'dns': return DNS_PORT;
    case 'tls': case 'http': case 'auth': case 'application': return HTTPS_PORT;
    case 'tcp': return HTTP_PORT;
  }
}

