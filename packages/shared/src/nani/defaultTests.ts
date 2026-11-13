/**
 * NANI — default diagnostic test library.
 *
 * The likelihoods below are *priors supplied by engineering judgement*, not
 * measured ground truth. They are intentionally readable and editable so that a
 * calibration run over captured probe data can replace them. `metrics.ts`
 * measures how well the resulting probabilities are calibrated; a miscalibrated
 * prior is a bug to be fixed, not hidden.
 *
 * Convention: `failure[h] = P(probe fails | hypothesis h is true)`. Unlisted
 * hypotheses use `baseFailure` (a probe usually works when the named cause is
 * absent). `success` is the remainder; `timeout` is added explicitly where a
 * hang is plausible.
 */

import { NETWORK_HYPOTHESES, type DiagnosticTest, type NetworkHypothesis, type NetworkLayer, type ProbeOutcome } from './types';

interface TestSpec {
  id: string;
  layer: NetworkLayer;
  label: string;
  cost: number;
  baseFailure?: number;
  /**
   * Baseline timeout probability. A timeout must be possible under every
   * hypothesis; otherwise an observed timeout has zero likelihood everywhere
   * and the update is silently discarded — a bug this type makes explicit.
   */
  baseTimeout?: number;
  failure: Partial<Record<NetworkHypothesis, number>>;
  timeout?: Partial<Record<NetworkHypothesis, number>>;
}

function buildTest(spec: TestSpec): DiagnosticTest {
  const base = spec.baseFailure ?? 0.1;
  const baseTimeout = spec.baseTimeout ?? 0.02;
  const likelihoods = {} as DiagnosticTest['likelihoods'];

  for (const h of NETWORK_HYPOTHESES) {
    const fail = clamp(spec.failure[h] ?? base);
    const to = clamp(spec.timeout?.[h] ?? baseTimeout);
    // `failure` and `timeout` are disjoint outcomes; keep their sum ≤ 1 so the
    // likelihood is a genuine distribution rather than an unnormalized score.
    const success = clamp(1 - fail - to);
    likelihoods[h] = { success, failure: fail, timeout: to, skipped: 0, unknown: 0 } as Record<ProbeOutcome, number>;
  }

  return { id: spec.id, layer: spec.layer, label: spec.label, cost: spec.cost, likelihoods };
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Default library. Order is irrelevant — selection is by information gain.
 * Costs are relative: DNS is cheap, a TLS handshake costs a round trip, an
 * application operation costs the most (and may have side effects, so it is
 * never auto-run against non-idempotent endpoints).
 */
export const DEFAULT_TESTS: readonly DiagnosticTest[] = [
  buildTest({
    id: 'dns-lookup',
    layer: 'dns',
    label: 'Resolve the hostname',
    cost: 0.1,
    failure: { dns: 0.95, 'local-interface': 0.4, 'upstream-proxy': 0.3, routing: 0.2 },
  }),
  buildTest({
    id: 'gateway-ping',
    layer: 'tcp',
    label: 'Reach the local gateway',
    cost: 0.15,
    failure: { gateway: 0.9, 'local-interface': 0.85, routing: 0.35, ipv4: 0.4 },
  }),
  buildTest({
    id: 'ipv6-connect',
    layer: 'tcp',
    label: 'Connect over IPv6',
    cost: 0.2,
    failure: { ipv6: 0.9, routing: 0.25, 'local-interface': 0.2 },
  }),
  buildTest({
    id: 'tcp-connect',
    layer: 'tcp',
    label: 'Open a TCP connection',
    cost: 0.3,
    failure: { tcp: 0.78, routing: 0.6, 'remote-endpoint': 0.7, 'upstream-proxy': 0.5, mtu: 0.2, ipv4: 0.35 },
    timeout: { tcp: 0.2, routing: 0.2, 'remote-endpoint': 0.15, 'upstream-proxy': 0.15 },
  }),
  buildTest({
    id: 'tls-handshake',
    layer: 'tls',
    label: 'Complete the TLS handshake',
    cost: 0.4,
    failure: { tls: 0.95, mtu: 0.45, 'upstream-proxy': 0.4, 'remote-endpoint': 0.2 },
  }),
  buildTest({
    id: 'mtu-probe',
    layer: 'tcp',
    label: 'Probe path MTU / fragmentation',
    cost: 0.35,
    // A black-holed MTU usually hangs rather than returning an error, so the
    // signal lives in the timeout outcome, not the failure outcome.
    failure: { mtu: 0.35, tls: 0.1, routing: 0.15 },
    timeout: { mtu: 0.55 },
  }),
  buildTest({
    id: 'http-reachability',
    layer: 'http',
    label: 'Receive an HTTP response',
    cost: 0.5,
    failure: { 'remote-endpoint': 0.8, 'upstream-proxy': 0.5, 'server-application': 0.35, tcp: 0.3, 'api-auth': 0.05, 'api-rate-limit': 0.05 },
  }),
  buildTest({
    id: 'auth-check',
    layer: 'auth',
    label: 'Authenticate the API request',
    cost: 0.55,
    failure: { 'api-auth': 0.9, 'remote-endpoint': 0.05, 'server-application': 0.1 },
  }),
  buildTest({
    id: 'rate-limit-check',
    layer: 'application',
    label: 'Check the provider rate limit',
    cost: 0.55,
    failure: { 'api-rate-limit': 0.85, 'server-application': 0.1 },
  }),
  buildTest({
    id: 'app-operation',
    layer: 'application',
    label: 'Perform the real API operation',
    cost: 0.9,
    failure: { 'server-application': 0.85, 'api-auth': 0.3, 'api-rate-limit': 0.3, 'remote-endpoint': 0.3 },
  }),
] as const;

export type { TestSpec };
