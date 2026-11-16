/**
 * NANI read-only diagnostic adapter.
 *
 * Bridges the pure NANI core (`packages/shared/src/nani`) to the probes that
 * already exist in this API (`nodeTestProbes`). The adapter owns no state and
 * takes no action: it resolves one target, runs the idempotent TCP/TLS probes,
 * and folds the observations into a Bayesian diagnosis.
 *
 * It deliberately does NOT:
 *   - register APIs in the live NANI registry,
 *   - publish events or write history rows,
 *   - plan or activate recovery, routes, DNS or system-proxy changes.
 *
 * TLS certificates are verified: `nodeTestProbes.tlsProbe` reports
 * `authorized`, and a completed handshake with an invalid certificate is a
 * TLS failure, never a success.
 */

import {
  DEFAULT_TESTS,
  diagnose,
  selectNextTest,
} from '@netpulse/shared';
import type {
  DiagnosisResult,
  DiagnosticObservation,
  DiagnosticTest,
  NetworkLayer,
  NodeTestResult,
  PublicNode,
} from '@netpulse/shared';

import { AppError, badRequest } from '../util/appError';
import { resolveTarget, type ResolvedTarget } from '../util/targetGuard';
import type { Logger } from '../logger';
import { tcpProbe, tlsProbe } from './nodeTestProbes';

export interface NaniDiagnosticDeps {
  log: Logger;
  /** Overridable for deterministic tests; defaults to the SSRF-guarded resolver. */
  resolve?: (host: string) => Promise<ResolvedTarget>;
  tcpProbe?: typeof tcpProbe;
  tlsProbe?: typeof tlsProbe;
}

export interface NaniDiagnosticOptions {
  /** Run a TLS handshake. Default: only on port 443. */
  tls?: boolean;
}

export interface NaniReadOnlyDiagnosis {
  readOnly: true;
  target: string;
  host: string;
  port: number;
  generatedAt: number;
  observations: DiagnosticObservation[];
  diagnosis: DiagnosisResult;
  recommendedTest: { id: string; layer: NetworkLayer; label: string; cost: number } | null;
  limits: string[];
}

const READ_ONLY_LIMITS = [
  'Read-only: probes never change DNS, routing, proxy, firewall or VPN state.',
  'TLS success requires a verified certificate; certificate verification is never disabled.',
  'Skipped or unknown outcomes are excluded from the diagnosis, never counted as failures.',
  'No recovery is planned, activated or persisted by this adapter.',
] as const;

/** Parse `host`, `host:port` or `[ipv6]:port`. Default port is 443. */
export function parseDiagnosticTarget(raw: string): { host: string; port: number } {
  const trimmed = raw.trim();
  if (!trimmed) throw badRequest('invalid_target', 'target is required');

  let host: string;
  let portPart: string | null = null;

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) throw badRequest('invalid_target', `"${raw}" has an unterminated IPv6 address`);
    host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (rest.startsWith(':')) portPart = rest.slice(1);
    else if (rest.length > 0) throw badRequest('invalid_target', `"${raw}" has trailing characters`);
  } else {
    const firstColon = trimmed.indexOf(':');
    const lastColon = trimmed.lastIndexOf(':');
    // More than one colon means an unbracketed IPv6 literal, not host:port.
    if (firstColon > 0 && firstColon === lastColon) {
      host = trimmed.slice(0, lastColon);
      portPart = trimmed.slice(lastColon + 1);
    } else {
      host = trimmed;
    }
  }

  if (!host) throw badRequest('invalid_target', `"${raw}" has no host`);

  const port = portPart === null ? 443 : Number(portPart);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw badRequest('invalid_target', `"${raw}" has an invalid port`);
  }
  return { host, port };
}

/** Minimal node shape consumed by the TCP/TLS probes (id/host/port/sni only). */
function probeNode(host: string, port: number): PublicNode {
  return {
    id: 'nani-read-only-diagnostic',
    protocol: 'vless',
    host,
    ipv4: [],
    ipv6: [],
    port,
    transport: 'tcp',
    security: 'tls',
    sni: host,
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    encryption: null,
    ssrProtocol: null,
    remark: null,
  } as unknown as PublicNode;
}

function timeoutLike(error: string | null): boolean {
  return error != null && /timeout|timed out|ETIMEDOUT/i.test(error);
}

function tcpObservation(result: NodeTestResult, at: number): DiagnosticObservation {
  if (result.status === 'done') {
    return { testId: 'tcp-connect', outcome: 'success', at, reliability: 1 };
  }
  return {
    testId: 'tcp-connect',
    outcome: timeoutLike(result.error) ? 'timeout' : 'failure',
    at,
    reliability: 0.9,
  };
}

function tlsObservation(result: NodeTestResult, at: number): DiagnosticObservation {
  if (result.status === 'done' && result.authorized === true) {
    return { testId: 'tls-handshake', outcome: 'success', at, reliability: 1 };
  }
  return {
    testId: 'tls-handshake',
    // A completed handshake with an untrusted certificate is still a TLS
    // failure for NANI: the connection is not trustworthy.
    outcome: timeoutLike(result.error) ? 'timeout' : 'failure',
    at,
    reliability: 1,
  };
}

function recommendedTestOf(
  diagnosis: DiagnosisResult,
  excluded: ReadonlySet<string>,
  now: number,
): NaniReadOnlyDiagnosis['recommendedTest'] {
  const choice = selectNextTest(diagnosis.posterior, DEFAULT_TESTS, excluded, now);
  if (!choice) return null;
  const test: DiagnosticTest = choice.test;
  return { id: test.id, layer: test.layer, label: test.label, cost: test.cost };
}

export class NaniDiagnosticAdapter {
  private readonly resolve: (host: string) => Promise<ResolvedTarget>;
  private readonly tcp: typeof tcpProbe;
  private readonly tls: typeof tlsProbe;

  constructor(private readonly deps: NaniDiagnosticDeps) {
    this.resolve = deps.resolve ?? ((host) => resolveTarget(host));
    this.tcp = deps.tcpProbe ?? tcpProbe;
    this.tls = deps.tlsProbe ?? tlsProbe;
  }

  async diagnose(rawTarget: string, opts: NaniDiagnosticOptions = {}): Promise<NaniReadOnlyDiagnosis> {
    const { host, port } = parseDiagnosticTarget(rawTarget);
    const observations: DiagnosticObservation[] = [];

    let resolved: ResolvedTarget | null = null;
    try {
      resolved = await this.resolve(host);
      observations.push({ testId: 'dns-lookup', outcome: 'success', at: Date.now(), reliability: 1 });
    } catch (err) {
      const dnsFailure =
        err instanceof AppError && (err.code === 'dns_resolution_failed' || err.code === 'invalid_target');
      if (!dnsFailure) throw err;
      // A DNS failure is itself evidence; without a resolved address there is
      // nothing to dial, so the transport probes are recorded as skipped.
      observations.push({ testId: 'dns-lookup', outcome: 'failure', at: Date.now(), reliability: 0.8 });
      observations.push({ testId: 'tcp-connect', outcome: 'skipped', at: Date.now(), reliability: 0 });
      observations.push({ testId: 'tls-handshake', outcome: 'skipped', at: Date.now(), reliability: 0 });
    }

    if (resolved) {
      const ip = resolved.ips[0]!;
      const node = probeNode(host, port);
      const tcp = await this.tcp(node, ip);
      observations.push(tcpObservation(tcp, Date.now()));

      const runTls = opts.tls ?? port === 443;
      if (!runTls) {
        observations.push({ testId: 'tls-handshake', outcome: 'skipped', at: Date.now(), reliability: 0 });
      } else if (tcp.status === 'done') {
        const tls = await this.tls(node, ip);
        observations.push(tlsObservation(tls, Date.now()));
      } else {
        observations.push({ testId: 'tls-handshake', outcome: 'skipped', at: Date.now(), reliability: 0 });
      }
    }

    const now = Date.now();
    const diagnosis = diagnose(observations, DEFAULT_TESTS, now);
    const excluded = new Set(observations.map((o) => o.testId));
    this.deps.log.info(
      { target: host, port, evidenceCount: diagnosis.evidenceCount, sufficient: !diagnosis.insufficientEvidence },
      'nani read-only diagnosis',
    );

    return {
      readOnly: true,
      target: rawTarget,
      host,
      port,
      generatedAt: now,
      observations,
      diagnosis,
      recommendedTest: recommendedTestOf(diagnosis, excluded, now),
      limits: [...READ_ONLY_LIMITS],
    };
  }
}
