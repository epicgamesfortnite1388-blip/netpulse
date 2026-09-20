import net from 'node:net';
import tls from 'node:tls';

import type {
  NodeTestResult,
  NodeTestType,
  NodeProtocol,
  NodeSecurity,
  NodeTransport,
  PublicNode,
} from '@netpulse/shared';
import { proxyProbeWithEngine } from './proxyEngineRunner';
import { familyOfIp } from '../util/targetGuard';
import type { ProxyEngineId } from '@netpulse/shared';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { TestEndpointsRepository } from '../db/repositories';
import type { ParsedNodeConfig } from '@netpulse/shared';

/**
 * One node probe per type, as pure network work.
 *
 * Probes own NOTHING: no repository, no row lifecycle, no event bus. They take
 * the node and return a `NodeTestResult`; the service decides what "running"
 * and "finished" mean for the stored row. That split keeps the probes testable
 * against a socket and lets the service guarantee (in one place) that every
 * test's row reaches a terminal state.
 *
 * Latency is `tenthsOfMs`-rounded elapsed time — see nodeScoring.ts for why.
 */
export const TEST_TIMEOUT_MS = 8_000;
const DEFAULT_TEST_ENDPOINT = 'https://httpbin.org/ip';

export type ProbeDeps = {
  /** enabled test endpoint for proxy probes; null when the table is empty */
  testEndpoints: Pick<TestEndpointsRepository, 'list'> | null;
  /** settings-backed proxy core preference; omitted/throwing = 'auto' */
  proxyEnginePreference?: () => 'auto' | ProxyEngineId;
  /** OS-level ping; omitted = ICMP reports 'unavailable' honestly */
  controller?: Pick<PlatformNetworkController, 'icmpPing'>;
  /** vaulted connection secret for proxy probes */
  secret: string | null;
};

/** The enabled proxy test endpoint, or the built-in default. */
export async function resolveTestEndpoint(
  testEndpoints: Pick<TestEndpointsRepository, 'list'> | null,
): Promise<{ url: string; expectedStatus: number; timeoutMs: number; maxBytes: number }> {
  const enabled = testEndpoints?.list().find((e) => e.enabled);
  if (enabled) {
    return {
      url: enabled.url,
      expectedStatus: enabled.expectedStatus,
      timeoutMs: enabled.timeoutMs,
      maxBytes: enabled.maxBytes,
    };
  }
  return {
    url: DEFAULT_TEST_ENDPOINT,
    expectedStatus: 200,
    timeoutMs: 5000,
    maxBytes: 4096,
  };
}

export async function tcpProbe(node: PublicNode, ip?: string): Promise<NodeTestResult> {
  const host = ip || node.host;
  const port = node.port;

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: TEST_TIMEOUT_MS });
    let resolved = false;

    const finish = (ok: boolean, latency?: number, error?: string) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      const latencyMs = latency ?? round10(Date.now() - start);
      resolve({
        nodeId: node.id,
        type: 'tcp',
        status: ok ? 'done' : 'failed',
        startedAt: start,
        finishedAt: Date.now(),
        latencyMs,
        totalMs: latencyMs,
        tlsVersion: null,
        authorized: null,
        httpStatus: null,
        responseSize: null,
        error: error ?? null,
        family: net.isIP(host) as 4 | 6 | null,
        probedIp: host,
        testEndpoint: null,
        engine: null,
      });
    };

    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, undefined, 'timeout'));
    socket.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED')) {
        finish(false, undefined, 'connection refused');
      } else if (msg.includes('ENETUNREACH')) {
        finish(false, undefined, 'network unreachable');
      } else {
        finish(false, undefined, msg);
      }
    });
  });
}

export async function tlsProbe(node: PublicNode, ip?: string): Promise<NodeTestResult> {
  const host = ip || node.host;
  const port = node.port;
  const sni = node.sni || host;

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: TEST_TIMEOUT_MS });
    let resolved = false;

    const finish = (ok: boolean, latency?: number, tlsVersion?: string, authorized?: boolean, error?: string) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch { /* already closed */ }
      const latencyMs = latency ?? round10(Date.now() - start);
      resolve({
        nodeId: node.id,
        type: 'tls',
        status: ok ? 'done' : 'failed',
        startedAt: start,
        finishedAt: Date.now(),
        latencyMs,
        totalMs: latencyMs,
        tlsVersion: tlsVersion ?? null,
        authorized: authorized ?? null,
        httpStatus: null,
        responseSize: null,
        error: error ?? null,
        family: net.isIP(host) as 4 | 6 | null,
        probedIp: host,
        testEndpoint: null,
        engine: null,
      });
    };

    socket.on('error', (err) => {
      if (resolved) return;
      finish(false, undefined, undefined, undefined, err instanceof Error ? err.message : String(err));
    });

    // Upgrade to TLS after TCP connect
    socket.on('connect', () => {
      try {
        const tlsSocket = tls.connect({
          socket,
          servername: sni,
          rejectUnauthorized: false,
          timeout: TEST_TIMEOUT_MS,
        });

        tlsSocket.on('secureConnect', () => {
          const tlsVersion = tlsSocket.getProtocol();
          const authorized = tlsSocket.authorized;
          finish(true, undefined, tlsVersion ?? undefined, authorized);
        });

        tlsSocket.on('error', (err: Error) => {
          if (resolved) return;
          const msg = err instanceof Error ? err.message : String(err);
          // TLS errors are still "tls failure" not full failure
          finish(false, undefined, undefined, false, msg);
        });

        tlsSocket.on('timeout', () => {
          if (resolved) return;
          finish(false, undefined, undefined, false, 'tls timeout');
        });
      } catch (err) {
        finish(false, undefined, undefined, undefined, err instanceof Error ? err.message : String(err));
      }
    });
  });
}

export async function proxyProbe(node: PublicNode, ip?: string, deps?: Partial<ProbeDeps>): Promise<NodeTestResult> {
  // REAL proxy test: tunnel traffic through the node with a local core
  // (xray or sing-box — see proxyEngineRunner.ts) on an ephemeral port.
  // No fake 200s — latency is measured only when traffic provably traversed
  // the proxy, and the node's REAL secret comes from the at-rest vault.
  const testEndpoint = await resolveTestEndpoint(deps?.testEndpoints ?? null);
  const start = Date.now();

  const probeResult = await proxyProbeWithEngine(
    {
      protocol: node.protocol,
      host: node.host,
      port: node.port,
      transport: node.transport as ParsedNodeConfig['transport'],
      security: node.security as ParsedNodeConfig['security'],
      sni: node.sni,
      alpn: node.alpn,
      fingerprint: node.fingerprint,
      flow: node.flow,
      alterId: node.alterId,
      path: node.path,
      hostHeader: node.hostHeader,
      serviceName: node.serviceName,
      allowInsecure: node.allowInsecure,
      encryption: node.encryption,
      ssrProtocol: node.ssrProtocol,
      // Reality material MUST reach the engine config — without the public
      // key xray rejects the outbound at startup (exit 23) and the probe
      // blames the node for what is a dropped field.
      realityPublicKey: node.realityPublicKey,
      realityShortId: node.realityShortId,
      realityServerName: node.realityServerName,
      vmessSecurity: node.encryption,
      extra: (node as unknown as { extra?: Record<string, unknown> | null }).extra ?? null,
      remark: node.remark,
    },
    {
      secret: deps?.secret ?? null,
      testUrl: testEndpoint.url,
      preferred: deps?.proxyEnginePreference ? deps.proxyEnginePreference() : 'auto',
    },
  );

  const failed = probeResult.status !== 'done';
  return {
    nodeId: node.id,
    type: 'proxy',
    status: failed ? 'failed' : 'done',
    startedAt: start,
    finishedAt: Date.now(),
    latencyMs: probeResult.latencyMs,
    totalMs: probeResult.totalMs,
    tlsVersion: failed ? null : (probeResult.tlsVersion ?? null),
    authorized: null,
    httpStatus: probeResult.httpStatus,
    responseSize: null,
    error: failed ? (probeResult.error ?? 'proxy test failed') : null,
    family: null,
    probedIp: ip ?? node.host,
    testEndpoint: testEndpoint.url,
    engine: probeResult.engine,
  };
}

export async function icmpProbe(
  node: PublicNode,
  ip?: string,
  controller?: Pick<PlatformNetworkController, 'icmpPing'>,
): Promise<NodeTestResult> {
  // Real ICMP via the platform controller (OS ping). Without a controller
  // (unit-test seams) the result is an honest 'unavailable' failure — never
  // a fabricated measurement.
  const start = Date.now();
  if (!controller) {
    return {
      nodeId: node.id,
      type: 'icmp',
      status: 'failed',
      startedAt: start,
      finishedAt: Date.now(),
      latencyMs: null,
      totalMs: null,
      tlsVersion: null,
      authorized: null,
      httpStatus: null,
      responseSize: null,
      error: 'ICMP ping not available on this platform',
      family: null,
      probedIp: ip || node.host,
      testEndpoint: null,
      engine: null,
    };
  }

  const targetIp = ip || node.ipv4[0] || node.host;
  try {
    const ping = await controller.icmpPing(targetIp, { count: 4, timeoutMs: 2000 });
    const avg = ping.avg ?? ping.median ?? null;
    const done = ping.received > 0;
    return {
      nodeId: node.id,
      type: 'icmp',
      status: done ? 'done' : 'failed',
      startedAt: start,
      finishedAt: Date.now(),
      latencyMs: avg,
      totalMs: Date.now() - start,
      tlsVersion: null,
      authorized: null,
      httpStatus: null,
      responseSize: null,
      error: done ? null : `ICMP: ${ping.lossPct}% packet loss (${ping.received}/${ping.sent})`,
      family: familyOfIp(targetIp),
      probedIp: targetIp,
      testEndpoint: null,
      engine: null,
    };
  } catch (err) {
    return {
      nodeId: node.id,
      type: 'icmp',
      status: 'failed',
      startedAt: start,
      finishedAt: Date.now(),
      latencyMs: null,
      totalMs: Date.now() - start,
      tlsVersion: null,
      authorized: null,
      httpStatus: null,
      responseSize: null,
      error: `ICMP failed: ${err instanceof Error ? err.message : String(err)}`,
      family: familyOfIp(targetIp),
      probedIp: targetIp,
      testEndpoint: null,
      engine: null,
    };
  }
}

/** Run one probe of the given type. The service-level dispatch, in one place. */
export function runProbe(
  node: PublicNode,
  type: NodeTestType,
  ip: string | undefined,
  deps: ProbeDeps,
): Promise<NodeTestResult> {
  switch (type) {
    case 'tcp': return tcpProbe(node, ip);
    case 'tls': return tlsProbe(node, ip);
    case 'proxy': return proxyProbe(node, ip, deps);
    case 'icmp': return icmpProbe(node, ip, deps.controller);
  }
}

// Re-exported for the shared DTO mapper (protocol labels live on nodes too).
export type { NodeProtocol, NodeSecurity, NodeTransport };

function round10(ms: number): number {
  return Math.round(ms * 10) / 10;
}
