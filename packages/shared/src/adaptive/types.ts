import type { ProxyEngineId } from '../models/proxyEngine';
import type { ScanProfileId } from '../models/scanProfile';

/**
 * Adaptive connectivity — the shapes.
 *
 * The engine decides ONE thing: which already-approved, already-compatible way
 * of connecting is most likely to reach the internet right now, based on what
 * the app itself observed happening. It never invents a configuration, never
 * runs a new program, and never activates anything that has not passed the
 * verification path in `services/adaptiveEngine.ts`.
 *
 * Two boundaries are deliberate:
 *
 *  1. **A strategy is a choice the app already supports.** Every strategy names
 *     a local core the user has installed and a DNS mode the engine can honour.
 *     "Learn a new transport" is not a strategy — that is a research candidate
 *     (see `candidates.ts`), which cannot be executed because it was learned.
 *
 *  2. **The context is coarse and non-identifying.** A context bucket is derived
 *     from observable network behaviour (does DNS resolve, does TLS complete,
 *     did a relay work, is IPv6 present) plus the user's own scan profile. It
 *     contains no addresses, no hostnames, no timestamps and nothing that
 *     identifies a network, an ISP or a user.
 */

export const ADAPTIVE_STATE_VERSION = 1;

/* --------------------------------- strategy -------------------------------- */

/**
 * One way of connecting that the app may pick. `id` is stable and readable so
 * stored learning state survives a restart and can be explained to the user.
 */
export interface AdaptiveStrategy {
  /** stable id, e.g. `xray`, `sing-box+doh` */
  id: string;
  engine: ProxyEngineId;
  /** route the tunnel's DNS through the node instead of the local resolver */
  dnsThroughTunnel: boolean;
  /** shown in the UI, e.g. "Xray-core · DNS through tunnel" */
  label: string;
}

export function strategyIdFor(engine: ProxyEngineId, dnsThroughTunnel: boolean): string {
  return dnsThroughTunnel ? `${engine}+doh` : engine;
}

/* --------------------------------- context --------------------------------- */

/**
 * The observable network facts a decision may depend on.
 *
 * Every field is a BOOLEAN the app measured, not an inference: `tlsFailing`
 * means a TLS handshake to a control name failed while TCP connected, not "the
 * network is censored". `profile` is the user's own aggressiveness choice, so a
 * stealth-profile decision and a turbo-profile decision are allowed to differ.
 */
export interface AdaptiveContextSignals {
  /** a DNS lookup of a control name failed recently */
  dnsFailing: boolean;
  /** TCP connected but the TLS handshake did not complete */
  tlsFailing: boolean;
  /** a tunnel verified a real exit through a relay recently */
  relayWorked: boolean;
  /** the host has a usable IPv6 route (observed) */
  ipv6: boolean;
  /** the user's discovery depth/aggressiveness setting */
  profile: ScanProfileId;
}

/**
 * The bucket key. Order-stable and content-derived, so two decisions taken under
 * the same observed conditions share their evidence and nothing else.
 */
export function contextBucketOf(signals: AdaptiveContextSignals): string {
  return [
    `dns:${signals.dnsFailing ? 1 : 0}`,
    `tls:${signals.tlsFailing ? 1 : 0}`,
    `relay:${signals.relayWorked ? 1 : 0}`,
    `v6:${signals.ipv6 ? 1 : 0}`,
    `p:${signals.profile}`,
  ].join('|');
}

/** Read a bucket key back for display; never used to identify a network. */
export function describeContextBucket(bucket: string): string {
  const parts = bucket.split('|');
  const get = (prefix: string): string | null => {
    const found = parts.find((p) => p.startsWith(`${prefix}:`));
    return found ? found.slice(prefix.length + 1) : null;
  };
  const bits: string[] = [];
  if (get('dns') === '1') bits.push('DNS failing');
  if (get('tls') === '1') bits.push('TLS handshake failing');
  if (get('relay') === '1') bits.push('a relay worked recently');
  if (get('v6') === '1') bits.push('IPv6 present');
  const profile = get('p');
  if (profile) bits.push(`${profile} profile`);
  return bits.length > 0 ? bits.join(', ') : 'no distinguishing observations';
}

/* ------------------------------- observations ------------------------------ */

/**
 * What one connection attempt taught the engine. `ok` means a tunnel was
 * VERIFIED to carry traffic (an exit IP was read through it), never merely that
 * a process started or a handshake completed.
 */
export interface AdaptiveObservation {
  at: number;
  context: string;
  strategyId: string;
  ok: boolean;
  /** ms to a verified working tunnel on success; null on failure */
  timeToWorkingMs: number | null;
  /** classified failure kind on failure; null on success */
  failureKind: FailureKind | null;
  /** stable machine code for why it failed; null on success */
  reasonCode: string | null;
}

/* ---------------------------------- stats --------------------------------- */

/**
 * Evidence for one (context, strategy) pair.
 *
 * Counts are FLOATS because they decay: an observation made on a network that no
 * longer exists should not outweigh one made a minute ago. `successes` /
 * `failures` are the decayed counts behind a Beta(1,1) prior, so "no evidence"
 * and "balanced evidence" are distinguishable, and a stale entry fades back to
 * the prior instead of needing a manual reset.
 */
export interface AdaptiveStats {
  successes: number;
  failures: number;
  /** exponential mean of time-to-verified-working-tunnel, ms */
  meanSuccessMs: number | null;
  /** consecutive failures on this pair — drives the conservative fallback */
  consecutiveFailures: number;
  /** when this pair was last observed (decay is applied lazily against it) */
  updatedAt: number;
}

export interface AdaptiveEntry {
  context: string;
  strategyId: string;
  stats: AdaptiveStats;
}

/** Persisted learning state. Bounded, versioned, locally stored. */
export interface AdaptiveState {
  version: number;
  entries: AdaptiveEntry[];
  /** recent observations, kept only to detect a repeated transport pattern */
  observations: AdaptiveObservation[];
  createdAt: number;
  updatedAt: number;
  /** set by an explicit user reset; surfaced so the UI can say when it happened */
  resetAt: number | null;
}

/* ---------------------------------- policy -------------------------------- */

export interface AdaptivePolicyOptions {
  /** evidence half-life; older observations weigh proportionally less */
  halfLifeMs: number;
  /** decayed observations required before a strategy may be preferred */
  minSamples: number;
  /** at most this fraction of the attempt budget may be exploratory */
  explorationShare: number;
  /** how much time-to-verified-working-tunnel is allowed to oppose success probability */
  costWeight: number;
  /** the time cost that counts as "the whole budget" (normalization) */
  costReferenceMs: number;
  /** consecutive failures after which a strategy is treated as broken now */
  flopThreshold: number;
  /** bound on stored context buckets (least-recently-updated evicted first) */
  maxContexts: number;
  /** bound on strategies stored per context */
  maxStrategiesPerContext: number;
  /** bound on retained observations */
  maxObservations: number;
}

/**
 * Defaults, chosen to be conservative: evidence that decays, a strategy that
 * cannot be preferred on fewer than five observations, and exploration capped at
 * one attempt in four. None of these are performance claims — they are the
 * bounds the acceptance tests exercise.
 */
export const DEFAULT_ADAPTIVE_POLICY: AdaptivePolicyOptions = {
  halfLifeMs: 14 * 24 * 60 * 60 * 1000,
  minSamples: 5,
  explorationShare: 0.25,
  costWeight: 0.25,
  costReferenceMs: 8_000,
  flopThreshold: 3,
  maxContexts: 32,
  maxStrategiesPerContext: 12,
  maxObservations: 200,
};

export type AdaptiveConfidence = 'none' | 'low' | 'medium' | 'high';

/** Machine-readable reason a strategy was ordered where it was. */
export type AdaptiveReasonCode =
  | 'learned-best'
  | 'learned-lower'
  | 'insufficient-evidence'
  | 'exploratory-probe'
  | 'cooling-off-after-failures'
  /** every learned option is cooling off, so an untried approved one goes first */
  | 'fallback-after-cooling'
  | 'no-evidence-baseline-order';

export interface AdaptiveDecision {
  strategyId: string;
  engine: ProxyEngineId;
  dnsThroughTunnel: boolean;
  label: string;
  /** posterior mean of "this reaches the internet under this context" */
  successProbability: number;
  /** successProbability minus the normalized time cost */
  score: number;
  /** decayed observation count behind the estimate */
  evidence: number;
  confidence: AdaptiveConfidence;
  /** true when this position was chosen to gather evidence, not to win */
  exploratory: boolean;
  reason: AdaptiveReasonCode;
  /** one sentence, shown verbatim in the UI */
  explanation: string;
}

/* ------------------------------ failure classes --------------------------- */

/**
 * Why an attempt failed, as far as the app can tell. `unknown` is a real answer
 * and the common one; "DPI" is deliberately absent — censorship is a pattern, and
 * `censorshipHintOf` may only suggest it from repeated evidence across strategies.
 */
export type FailureKind =
  | 'dns'
  | 'transport'
  | 'authentication'
  | 'server-outage'
  | 'configuration'
  | 'local-network'
  | 'not-verified'
  | 'unknown';

export type ConnectFailureStage = 'resolve' | 'tcp' | 'tls' | 'core-start' | 'verify';

export interface ConnectFailureInput {
  stage: ConnectFailureStage;
  /** the underlying message, when there is one */
  message?: string | null;
  /** the core binary for the chosen strategy is not installed */
  engineUnavailable?: boolean;
  /** TCP connected for this attempt (measured, not assumed) */
  tcpReached?: boolean;
  /** TLS completed for this attempt (measured, not assumed) */
  tlsCompleted?: boolean;
  /** the same strategy worked for this node before (from stored state) */
  previouslyWorked?: boolean;
}

export interface FailureVerdict {
  kind: FailureKind;
  reasonCode: string;
  explanation: string;
  /**
   * Always false. A single failed attempt is never evidence of censorship; only
   * `censorshipHintOf` over a pattern of attempts may say anything about it.
   */
  dpiInferred: false;
}
