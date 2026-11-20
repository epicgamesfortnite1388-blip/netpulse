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
import type { Logger } from '../logger';

const DNS_PORT = 53;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const PROBE_TIMEOUT_MS = 5_000;

async function resolveHostname(hostname: string): Promise<string | null> {
  try {
    const dns = await import('node:dns/promises');
    const res = await dns.lookup(hostname, { family: 4 });
    return res.address;
  } catch {
    return null;
  }
}

interface HttpProbeResponse {
  statusCode: number | null;
  timedOut: boolean;
}

/**
 * One HTTP-bearing probe. Port 443 is a TLS endpoint: using the plain `http`
 * module there produces a socket error that was being misclassified as a
 * provider failure. Loopback sidecars on other ports remain plain HTTP.
 *
 * `req.end()` is required for a bodyless GET; without it Node never sends the
 * request and the probe always times out.
 */
async function requestHttpOutcome(
  address: string,
  serverName: string | undefined,
  port: number,
  path: string,
): Promise<HttpProbeResponse> {
  const isTls = port === HTTPS_PORT;
  const transport = isTls ? await import('node:https') : await import('node:http');
  const req = transport.request({
    host: address,
    port,
    path,
    method: 'GET',
    timeout: PROBE_TIMEOUT_MS,
    ...(isTls && serverName ? { servername: serverName, rejectUnauthorized: true } : {}),
  });

  return new Promise<HttpProbeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (result: HttpProbeResponse) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('response', (resp) => {
      resp.resume();
      finish({ statusCode: resp.statusCode ?? null, timedOut: false });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ statusCode: null, timedOut: true });
    });
    req.end();
  });
}

/** TLS handshake probe with deterministic cleanup on every exit path. */
async function probeTls(address: string, serverName: string | undefined, port: number): Promise<void> {
  const tls = await import('node:tls');
  const net = await import('node:net');
  const socket = net.createConnection({ host: address, port });
  const tlsSocket = tls.connect({
    socket,
    ...(serverName ? { servername: serverName } : {}),
    rejectUnauthorized: true,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timerRef: { handle?: ReturnType<typeof setTimeout> } = {};
      const cleanup = () => {
        if (timerRef.handle) clearTimeout(timerRef.handle);
        tlsSocket.off('secureConnect', onConnect);
        tlsSocket.off('error', onError);
        tlsSocket.off('timeout', onTimeout);
        socket.off('error', onError);
      };
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const onTimeout = () => { cleanup(); reject(new Error('tls-timeout')); };
      timerRef.handle = setTimeout(onTimeout, PROBE_TIMEOUT_MS);
      tlsSocket.on('secureConnect', onConnect);
      tlsSocket.on('error', onError);
      tlsSocket.on('timeout', onTimeout);
      socket.on('error', onError);
    });
  } finally {
    tlsSocket.destroy();
    socket.destroy();
  }
}

export async function runDiagnosticTest(
  controller: PlatformNetworkController,
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
  // Resolve once. Reusing this address keeps the DNS verdict and every later
  // layer on the same answer; a second lookup could disagree mid-probe.
  const ip = host ? await resolveHostname(host) : null;
  let outcome: ProbeOutcome = 'unknown';
  let reliability = 1;
  try {
    switch (test.layer) {
      case 'dns': {
        if (!host) { outcome = 'failure'; break; }
        outcome = ip ? 'success' : 'failure';
        reliability = ip ? 1 : 0.5;
        break;
      }
      case 'tcp': {
        if (!ip) { outcome = 'failure'; break; }
        const tcp = await controller
          .tcpProbe(ip, port, PROBE_TIMEOUT_MS)
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
        await probeTls(ip, host, port);
        outcome = 'success';
        reliability = 1.0;
        break;
      }
      case 'http':
      case 'auth':
      case 'application': {
        if (!ip) { outcome = 'failure'; break; }
        const path = test.layer === 'application'
          ? (pathOverride ?? '/healthz')
          : test.layer === 'auth'
            ? '/'
            : (pathOverride ?? '/');
        const res = await requestHttpOutcome(ip, host, port, path);
        if (res.timedOut) outcome = 'timeout';
        else if (res.statusCode === null) outcome = 'failure';
        else if (test.layer === 'auth') {
          outcome = res.statusCode === 401 || res.statusCode === 403
            ? 'failure'
            : res.statusCode >= 200 && res.statusCode < 400
              ? 'success'
              : 'failure';
        } else if (test.layer === 'application') {
          outcome = res.statusCode >= 200 && res.statusCode < 300 ? 'success' : 'failure';
        } else {
          outcome = res.statusCode >= 200 && res.statusCode < 400 ? 'success' : 'failure';
        }
        reliability = test.layer === 'http' ? 0.95 : 0.9;
        break;
      }
      default:
        outcome = 'unknown';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ test: test.id, target, error: message }, 'nani probe error');
    if (message.includes('timeout') || message.includes('ETIMEDOUT') || message.includes('tls-timeout')) {
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
