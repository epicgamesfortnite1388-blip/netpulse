import type {
  AdaptiveObservation,
  ConnectFailureInput,
  ConnectFailureStage,
  FailureKind,
  FailureVerdict,
} from './types';

/**
 * Failure classification — what a failed attempt is allowed to mean.
 *
 * The single most dangerous thing this system could do is decide that a failed
 * connection means censorship and act on that belief. A dead server, an expired
 * account, a broken local resolver, a wrong password and an ISP resetting a TLS
 * handshake all look identical from inside one attempt. So:
 *
 *  1. `classifyConnectFailure` returns `dpiInferred: false`, always, and its
 *     verdict is derived from what was MEASURED (did DNS answer, did TCP connect,
 *     did TLS complete, did the core even start) rather than from the message
 *     text alone.
 *  2. Nothing in the connection path branches on `FailureKind` in order to
 *     change transport for censorship reasons. The kind only feeds the learning
 *     state and the diagnostics UI.
 *  3. `censorshipHintOf` may raise a hint, and only from a PATTERN: several
 *     attempts, across different strategies, failing at the same stage, inside a
 *     short window. It is a prompt to look, never a conclusion, and it is not
 *     used to change behaviour.
 */

const AUTH_HINTS = /\b(401|403|unauthori[sz]ed|forbidden|invalid user|bad uuid|authentication|auth failed|wrong password|account|expired|quota|not entitled)\b/i;
const DNS_HINTS = /\b(enotfound|eai_again|getaddrinfo|dns|nxdomain|no such host|name resolution)\b/i;
const REFUSED_HINTS = /\b(econnrefused|connection refused)\b/i;
const RESET_HINTS = /\b(econnreset|connection reset|socket hang up|econnaborted)\b/i;
const TLS_HINTS = /\b(tls|ssl|certificate|handshake|alert|reality|xtls|x509)\b/i;
const TIMEOUT_HINTS = /\b(timeout|timed out|etimedout)\b/i;
const LOCAL_HINTS = /\b(enetunreach|enetdown|ehostunreach|network is unreachable|no route to host|eaddrinuse|eacces|eperm)\b/i;

function stageExplanation(stage: ConnectFailureStage): string {
  switch (stage) {
    case 'resolve':
      return 'the name did not resolve on this machine';
    case 'tcp':
      return 'no TCP connection was established';
    case 'tls':
      return 'TCP connected but the TLS handshake did not complete';
    case 'core-start':
      return 'the local core did not start';
    case 'verify':
      return 'the tunnel started but traffic never traversed it';
  }
}

/**
 * Classify ONE failed attempt.
 *
 * Order matters and is deliberate: a local problem outranks a remote one (an
 * unreachable local network is not a dead server), an unavailable core outranks
 * everything (nothing was even attempted), and authentication — which is the
 * documented cause of the "profile looks healthy, tunnel dies" failure — is
 * checked before transport, because an auth rejection also resets the connection.
 */
export function classifyConnectFailure(input: ConnectFailureInput): FailureVerdict {
  const message = (input.message ?? '').trim();
  const lower = message.toLowerCase();

  if (input.engineUnavailable === true) {
    return {
      kind: 'configuration',
      reasonCode: 'engine-unavailable',
      explanation: 'The local core for this option is not installed, so nothing was attempted.',
      dpiInferred: false,
    };
  }

  if (LOCAL_HINTS.test(lower)) {
    return {
      kind: 'local-network',
      reasonCode: 'local-network-error',
      explanation: `This machine could not reach the network (${stageExplanation(input.stage)}): ${message}`,
      dpiInferred: false,
    };
  }

  if (AUTH_HINTS.test(lower)) {
    return {
      kind: 'authentication',
      reasonCode: 'authentication-rejected',
      explanation: 'The server rejected the credential — the subscription may have been rotated or expired.',
      dpiInferred: false,
    };
  }

  if (input.stage === 'resolve' || DNS_HINTS.test(lower)) {
    return {
      kind: 'dns',
      reasonCode: 'dns-resolution-failed',
      explanation: 'Name resolution failed here, so the attempt never reached the transport stage.',
      dpiInferred: false,
    };
  }

  if (input.stage === 'verify') {
    return {
      kind: 'not-verified',
      reasonCode: 'traffic-not-verified',
      explanation: 'The core started, but the tunnel never carried traffic — a started process is not a working tunnel.',
      dpiInferred: false,
    };
  }

  // A refusal or a reset is a MORE specific reading than "the TLS stage failed",
  // so it is checked first: a reset that ends a handshake is reported as a reset,
  // including the distinction between a path that never worked and one that did.
  if (REFUSED_HINTS.test(lower)) {
    return {
      kind: 'server-outage',
      reasonCode: 'connection-refused',
      explanation: 'The endpoint actively refused the connection.',
      dpiInferred: false,
    };
  }

  if (RESET_HINTS.test(lower)) {
    return {
      kind: input.previouslyWorked === true ? 'transport' : 'server-outage',
      reasonCode: 'connection-reset',
      explanation: input.previouslyWorked === true
        ? 'A connection that worked before was reset — the path or the process changed, which is not yet evidence of anything else.'
        : 'The connection was reset before it was established.',
      dpiInferred: false,
    };
  }

  if (input.stage === 'tls' || (input.tcpReached === true && input.tlsCompleted !== true)) {
    return {
      kind: 'transport',
      reasonCode: TLS_HINTS.test(lower) ? 'tls-handshake-failed' : 'transport-failed-after-tcp',
      explanation: `TCP connected but the transport did not complete (${stageExplanation('tls')}).`,
      dpiInferred: false,
    };
  }

  if (TIMEOUT_HINTS.test(lower) || input.stage === 'tcp') {
    return {
      kind: 'transport',
      reasonCode: 'tcp-unreachable',
      explanation: `No TCP connection was established (${stageExplanation('tcp')}).`,
      dpiInferred: false,
    };
  }

  if (input.stage === 'core-start') {
    return {
      kind: 'configuration',
      reasonCode: 'core-start-failed',
      explanation: 'The local core exited instead of starting — usually a configuration this core cannot run.',
      dpiInferred: false,
    };
  }

  return {
    kind: 'unknown',
    reasonCode: 'unclassified',
    explanation: message
      ? `Unclassified failure: ${message}. This is not attributed to censorship.`
      : 'Unclassified failure with no message. This is not attributed to censorship.',
    dpiInferred: false,
  };
}

export interface CensorshipHint {
  likely: boolean;
  reason: string;
  /** how many attempts were considered (within the window) */
  considered: number;
  /** distinct strategies that failed at the same stage */
  distinctStrategies: number;
  /** the shared failure kind, when one dominates */
  kind: FailureKind | null;
}

export interface CensorshipHintOptions {
  windowMs?: number;
  /** distinct strategies that must fail the same way before a pattern is claimed */
  minDistinctStrategies?: number;
}

/**
 * The ONLY place censorship may be suggested, and only from a pattern:
 * several DIFFERENT strategies failing the same way inside a short window.
 *
 * One server being down, one credential being wrong, or one core being broken
 * can never satisfy this rule, because they cannot produce failures across
 * distinct strategies. Even when it fires, the wording is "worth looking at" —
 * the caller must not branch on it to change what it does.
 */
export function censorshipHintOf(
  observations: readonly AdaptiveObservation[],
  now: number,
  options: CensorshipHintOptions = {},
): CensorshipHint {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const minDistinct = options.minDistinctStrategies ?? 3;
  const recent = observations.filter((o) => !o.ok && now - o.at <= windowMs && now - o.at >= 0);

  const byKind = new Map<FailureKind, Set<string>>();
  for (const observation of recent) {
    const kind = observation.failureKind;
    if (!kind) continue;
    const set = byKind.get(kind) ?? new Set<string>();
    set.add(observation.strategyId);
    byKind.set(kind, set);
  }

  let best: { kind: FailureKind; strategies: Set<string> } | null = null;
  for (const [kind, strategies] of byKind) {
    if (!best || strategies.size > best.strategies.size) best = { kind, strategies };
  }

  if (!best || best.strategies.size < minDistinct) {
    return {
      likely: false,
      reason:
        best == null
          ? 'No failures at a common stage in this window — nothing suggests a network-level block.'
          : `Failures at a common stage came from ${best.strategies.size} strategy(ies); ${minDistinct} are needed before a pattern is worth looking at.`,
      considered: recent.length,
      distinctStrategies: best?.strategies.size ?? 0,
      kind: best?.kind ?? null,
    };
  }

  return {
    likely: true,
    reason: `${best.strategies.size} different strategies all failed the same way (${best.kind}) within ${Math.round(windowMs / 60000)} minutes — worth investigating as a network-level block. This is a pattern, not a diagnosis.`,
    considered: recent.length,
    distinctStrategies: best.strategies.size,
    kind: best.kind,
  };
}
