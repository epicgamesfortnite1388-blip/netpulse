import type { AdaptiveCalibration, ProxyEngineId } from '@netpulse/shared';

import type { AdaptiveAttemptOutcome, AdaptiveStatus } from './adaptiveEngine';
import { engineSupports } from './proxyCores';

/**
 * Smart Connect: choose one public configuration to dial, and say why.
 *
 * Three rules shape this module, and every one of them exists because the
 * opposite behaviour is easy to ship and easy to believe:
 *
 *  1. **Evidence before rank.** A stored row's `score` is a summary of past
 *     tests. It is not a promise about now, and it is not used as the ranking
 *     input here — the components that produced it are, plus how old they are.
 *     A row with no proxy test can never be reported as verified: it is capped
 *     below the tested band and carries `confidence: 'untested'`, whatever its
 *     stored score says.
 *
 *  2. **A rank is not a connection.** `plan()` opens no sockets. `verify()`
 *     dials at most `maxProbes` candidates through the app's own proxy probe,
 *     which only reaches `done` when traffic actually traversed the node. A
 *     `done` probe is a time-stamped observation, not permanent trust, so the
 *     result carries the measurement time and the trust band it supports.
 *
 *  3. **Learning is a nudge, never a veto.** The adaptive engine's learned
 *     success probability for an engine under the current context shifts a
 *     candidate by at most a few points. It cannot promote an unsupported
 *     freeze or rescue a failing node, and if the adaptive layer throws, the
 *     ranking falls back to evidence alone instead of failing the request.
 *
 * Nothing here connects a tunnel. Selecting is separate from authorising:
 * a third-party endpoint needs the user's explicit go-ahead before first use,
 * so the caller receives the decision and the existing connect routes run it.
 */

export type SmartConfidence = 'verified' | 'tested' | 'untested';

export type TrustCategory =
  | 'PUBLIC_UNVERIFIED'
  | 'STATICALLY_VALIDATED'
  | 'CONNECTION_TESTED'
  | 'TRAFFIC_VERIFIED'
  | 'RECENTLY_RELIABLE'
  | 'FAILED'
  | 'STALE'
  | 'REVOKED';

/** The subset of a stored public node this module reads. */
export interface SmartNodeRow {
  id: string;
  protocol: string;
  host: string;
  port: number;
  status: string;
  freshness: string;
  score: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs?: number | null;
  lastProxyMs: number | null;
  lastTcpMs?: number | null;
  lastSuccessAt: number | null;
  lastFailureAt?: number | null;
  lastValidated: number | null;
  lastSeen: number;
  consecutiveFailures: number;
  testCount: number;
  successCount: number;
  failureCount?: number;
  sourceCount: number;
  country?: string | null;
  /** transport security, when the row carries it; used for engine prescreening */
  security?: string | null;
  /** REALITY public key; without it the core cannot build a REALITY outbound */
  realityPublicKey?: string | null;
}

export interface SmartProbeResult {
  status: 'done' | 'failed' | 'error';
  latencyMs: number | null;
  httpStatus: number | null;
  engine: ProxyEngineId | null;
  error: string | null;
}

export interface SmartComponents {
  reliability: number;
  latency: number;
  freshness: number;
  evidence: number;
  sources: number;
  /** signed adjustment from learned engine performance (never a hard veto) */
  adaptiveBoost: number;
  /** signed deduction for repeated recent failures */
  failurePenalty: number;
}

export interface SmartCandidate {
  nodeId: string;
  protocol: string;
  country: string | null;
  engine: ProxyEngineId | null;
  /** 0-100 composite; capped for untested rows, see verify cap in `rank` */
  score: number;
  components: SmartComponents;
  confidence: SmartConfidence;
  trust: TrustCategory;
  reasons: string[];
  evidenceAgeMs: number | null;
  probe: {
    at: number;
    status: SmartProbeResult['status'];
    latencyMs: number | null;
    httpStatus: number | null;
    engine: ProxyEngineId | null;
    error: string | null;
    /** true only when traffic provably traversed the node */
    verified: boolean;
  } | null;
}

export interface SmartExclusion {
  nodeId: string;
  reason:
    | 'revoked'
    | 'failed'
    | 'stale'
    | 'unsupported-protocol'
    | 'no-engine-installed'
    | 'engine-rejects-config'
    | 'abandoned';
}

export interface SmartPlan {
  generatedAt: number;
  considered: number;
  excluded: SmartExclusion[];
  excludedByReason: Record<string, number>;
  candidates: SmartCandidate[];
  chosen: SmartCandidate | null;
  /** what the caller may safely do next, in words */
  decision: string;
  adaptive: {
    available: boolean;
    enabled: boolean;
    context: string | null;
    contextSummary: string | null;
    /** per-engine learned probability used for the nudge, when available */
    engineProbabilities: Array<{ engine: ProxyEngineId; probability: number; confidence: string }>;
    note: string;
  };
  limits: string[];
}

export interface SmartConnectDeps {
  /** stored public nodes, newest/most-scored first is not required — this ranks */
  listCandidates: (limit: number) => SmartNodeRow[];
  /** installed cores, in preference order */
  engines: () => ProxyEngineId[];
  /** bounded proxy probe; resolves only when traffic traversed the node */
  probe?: (nodeId: string) => Promise<SmartProbeResult>;
  adaptive?:
    | {
        status: () => AdaptiveStatus;
        observe: (outcome: AdaptiveAttemptOutcome) => unknown;
      }
    | null;
  now?: () => number;
}

const MS = 1000;
const MIN = 60 * MS;
const HOUR = 60 * MIN;

/** A node seen longer ago than this is not worth dialling. */
const ABANDONED_AFTER = 7 * 24 * HOUR;
/** Evidence older than this cannot support "verified". */
export const VERIFIED_WINDOW = 2 * HOUR;
/**
 * Evidence older than this is treated as stale for selection purposes.
 *
 * Deliberately computed from timestamps rather than read from the stored
 * `freshness` column: a live run showed a node whose proxy test had just
 * succeeded (580 ms, HTTP 200, `last_proxy_ms` written) still carrying
 * `freshness: 'stale'`, because that column is maintained by a different
 * lifecycle than test outcomes. Trusting it would have excluded the one node on
 * the machine that provably worked a minute ago.
 */
export const EVIDENCE_STALE_AFTER = 24 * HOUR;
/** Repeated failures at or above this count exclude the row outright. */
const FAILED_AT = 3;
/** An untested row may never outrank this, however good its metadata is. */
const UNTESTED_CAP = 55;
/**
 * A row that has only ever passed a TCP/TLS check may never outrank this.
 *
 * A TCP handshake is not a working VPN. Live data made the difference concrete:
 * a node with a 15 ms TCP success scored 93 and displaced the node that had just
 * carried real HTTP traffic at 580 ms. Capping port-only evidence keeps the
 * weak signal useful (it still beats untested) without letting it masquerade as
 * traffic verification.
 */
const PORT_ONLY_CAP = 70;

/**
 * Hard ceiling on dials per verification call.
 *
 * Matches the `network:verify-traffic` per-call cap in the agent permission
 * layer, so this module can never promise more traffic than the policy allows.
 */
export const MAX_PROBES = 10;
/**
 * Hard ceiling on cores alive at once during one call.
 *
 * Each probe is a separate engine process (~tens of MB); three is the most a
 * modest desktop should be asked to run concurrently, and one is still the
 * floor for a small budget.
 */
export const MAX_CONCURRENCY = 3;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function latencyScore(row: SmartNodeRow): number {
  const ms = row.medianProxyMs ?? row.lastProxyMs ?? row.medianTcpMs ?? row.lastTcpMs ?? null;
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 0;
  // 100 at ≤150 ms, 0 at ≥3 s, linear between. Deliberately harsh at the top:
  // the measured free-config set had a 1.2 s median, and a 3 s node is not
  // "slower", it is usually about to die.
  if (ms <= 150) return 100;
  if (ms >= 3000) return 0;
  return Math.round(100 - ((ms - 150) / 2850) * 100);
}

function freshnessScore(row: SmartNodeRow, now: number): number {
  const age = now - Math.max(row.lastSeen, row.lastValidated ?? 0);
  if (age <= 15 * MIN) return 100;
  if (age <= HOUR) return 85;
  if (age <= 6 * HOUR) return 65;
  if (age <= 24 * HOUR) return 40;
  if (age <= 3 * 24 * HOUR) return 20;
  return 5;
}

function evidenceScore(row: SmartNodeRow, now: number): number {
  if (row.lastSuccessAt == null) return 0;
  const age = now - row.lastSuccessAt;
  const recency = age <= HOUR ? 100 : age <= 6 * HOUR ? 75 : age <= 24 * HOUR ? 45 : 20;
  // Several independent successes matter, but the tenth success should not
  // double the weight of the second — diminishing, capped.
  const depth = clamp(Math.log2(1 + Math.max(0, row.successCount)) * 12, 0, 25);
  return clamp(Math.round(recency * 0.8 + depth), 0, 100);
}

function trustOf(row: SmartNodeRow, now: number, engine: ProxyEngineId | null): TrustCategory {
  if (row.status === 'revoked' || row.status === 'blocked') return 'REVOKED';
  if (row.consecutiveFailures >= FAILED_AT || row.status === 'failed' || row.status === 'dead') return 'FAILED';
  // Same rule as exclusion: STALE describes old evidence, never a new row and
  // never a row that just passed a probe (whose `freshness` flag may still say
  // `stale`).
  const evidenceAt = Math.max(row.lastSuccessAt ?? 0, row.lastValidated ?? 0);
  const hasEvidence = evidenceAt > 0;
  if (row.freshness === 'expired' || (hasEvidence && now - evidenceAt > EVIDENCE_STALE_AFTER)) return 'STALE';
  if (!hasEvidence && row.testCount > 0) return 'FAILED';
  if (engine == null) return 'PUBLIC_UNVERIFIED';
  const recentSuccess = row.lastSuccessAt != null && now - row.lastSuccessAt <= 6 * HOUR;
  if (recentSuccess && row.reliabilityPct >= 80 && row.successCount >= 3) return 'RECENTLY_RELIABLE';
  if (row.lastProxyMs != null && row.lastSuccessAt != null && now - row.lastSuccessAt <= VERIFIED_WINDOW) {
    return 'TRAFFIC_VERIFIED';
  }
  if (row.testCount > 0 || row.lastValidated != null) return 'CONNECTION_TESTED';
  return 'STATICALLY_VALIDATED';
}

function confidenceOf(row: SmartNodeRow, now: number): SmartConfidence {
  if (row.lastSuccessAt == null) return 'untested';
  if (row.lastProxyMs != null && now - row.lastSuccessAt <= VERIFIED_WINDOW) return 'verified';
  return 'tested';
}

/**
 * Configs an engine refuses before it even dials.
 *
 * Measured on xray 26.10.31 with a live training batch: a plaintext VLESS node
 * (security `none`) makes the core exit during startup — "vless without TLS or
 * other encryption is prohibited unless the server address is a private IP or
 * domain" (exit 23). That happened on a public IP **and** on a hostname, so the
 * rule does not exempt domains: of 699 feed nodes, 394 are plaintext VLESS and
 * every one that was dialled failed this way. The first version of this rule did
 * skip hostnames and five of six training probes still died at startup.
 *
 * VMess is excluded from the rule on purpose: `security: none` is legitimate
 * there because VMess carries its own encryption, and it was not observed
 * failing. sing-box is excluded for the same reason — the rejection was never
 * seen on it.
 */
function engineRejectsConfig(
  engine: ProxyEngineId,
  row: Pick<SmartNodeRow, 'protocol' | 'host' | 'security' | 'realityPublicKey'>,
): string | null {
  if (engine !== 'xray' && engine !== 'v2ray') return null;
  if (row.protocol !== 'vless') return null;
  if ((row.security ?? 'none') === 'none') {
    return `${engine} refuses plaintext VLESS (no TLS, no encryption) at startup`;
  }
  // A REALITY row with no public key builds a plaintext outbound, which the core
  // then refuses — measured live on a node whose stored security said `reality`.
  if (row.security === 'reality' && !row.realityPublicKey) {
    return `${engine} cannot build REALITY without the node's public key`;
  }
  return null;
}

/** First installed core that supports the protocol AND will not reject the config. */
function engineForRow(
  row: Pick<SmartNodeRow, 'protocol' | 'host' | 'security' | 'realityPublicKey'>,
  installed: readonly ProxyEngineId[],
): { engine: ProxyEngineId | null; rejected: string | null } {
  let rejected: string | null = null;
  for (const engine of installed) {
    if (!engineSupports(engine, row.protocol)) continue;
    const why = engineRejectsConfig(engine, row);
    if (why) {
      rejected ??= why;
      continue;
    }
    return { engine, rejected: null };
  }
  return { engine: null, rejected };
}

/**
 * What the model believes per engine under its current context.
 *
 * Three different views, deliberately kept apart:
 *  - `list` is for the plan payload (raw probability + confidence);
 *  - `byEngine` is the SCORE nudge, in points — ±8 max, and what ranking adds;
 *  - `probabilityByEngine` is the probability itself, which is what must be
 *    stored with an observation if calibration is ever to be scored. Returning
 *    the nudge as if it were a probability produced 5.12 in a test, which is not
 *    a probability at all.
 */
const KNOWN_ENGINES: readonly ProxyEngineId[] = ['xray', 'sing-box', 'v2ray', 'hysteria'];

/**
 * Which engine a strategy id belongs to.
 *
 * Ids are `${engine}+doh` when DNS goes through the tunnel and the bare engine
 * name otherwise — NOT `engine:variant`. Splitting on ':' produced the key
 * `xray+doh`, so every live lookup for `xray` missed: the ranking nudge and the
 * calibration prediction silently did nothing for 41 recorded observations until
 * a live training batch made the empty map visible.
 */
function engineOfStrategy(strategyId: string): ProxyEngineId | null {
  const head = strategyId.split(/[+:]/)[0] ?? '';
  return (KNOWN_ENGINES as readonly string[]).includes(head) ? (head as ProxyEngineId) : null;
}

function engineProbabilities(adaptive: AdaptiveStatus | null): {
  list: Array<{ engine: ProxyEngineId; probability: number; confidence: string }>;
  byEngine: Map<ProxyEngineId, number>;
  probabilityByEngine: Map<ProxyEngineId, number>;
} {
  const byEngine = new Map<ProxyEngineId, number>();
  const probabilityByEngine = new Map<ProxyEngineId, number>();
  const list: Array<{ engine: ProxyEngineId; probability: number; confidence: string }> = [];
  if (!adaptive) return { list, byEngine, probabilityByEngine };
  // A belief learned under a different network context is not this context's
  // belief. Averaging the two (which happened live: every prediction came out as
  // 0.232, the mean of a 0.054 and a 0.41 row) steers a decision with evidence
  // that was measured somewhere else. Entries without a context (older state,
  // test doubles) are taken as applicable.
  const scoped = adaptive.entries.filter((e) => {
    const ctx = (e as { context?: string | null }).context;
    return ctx == null || ctx === adaptive.context;
  });
  for (const entry of scoped) {
    const engine = engineOfStrategy(entry.strategyId);
    if (!engine) continue;
    // A row the engine has barely observed must not steer anything.
    if (entry.confidence === 'none') continue;
    const weight = entry.confidence === 'high' ? 1 : entry.confidence === 'medium' ? 0.75 : 0.5;
    const nudge = (entry.successProbability - 0.5) * 16 * weight;
    const current = byEngine.get(engine);
    byEngine.set(engine, current == null ? nudge : (current + nudge) / 2);
    const previous = probabilityByEngine.get(engine);
    probabilityByEngine.set(engine, previous == null ? entry.successProbability : (previous + entry.successProbability) / 2);
    list.push({ engine, probability: entry.successProbability, confidence: entry.confidence });
  }
  return { list, byEngine, probabilityByEngine };
}

export class SmartConnectService {
  private readonly now: () => number;

  constructor(private readonly deps: SmartConnectDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Rank stored candidates. Pure: no sockets, no writes, no adaptive updates.
   */
  /**
   * `allowStale` exists for training and scans, not for connecting.
   *
   * Connecting must never dial an endpoint whose only evidence is a day old, so
   * `plan()` drops those. But a training batch is how evidence becomes fresh
   * again: excluding them made `train()` return `attempted: 0` on a live
   * catalogue whose top-ranked 18 rows were all stale — the model could never
   * learn from the nodes it most needed to re-measure. Nodes that have only ever
   * failed stay excluded even here: a retry is not evidence.
   */
  plan(opts: { limit?: number; adaptive?: AdaptiveStatus | null; allowStale?: boolean } = {}): SmartPlan {
    const now = this.now();
    const installed = this.deps.engines();
    const rows = this.deps.listCandidates(clamp(opts.limit ?? 300, 1, 2000));

    let adaptiveStatus: AdaptiveStatus | null = null;
    let adaptiveNote = 'adaptive engine unavailable; ranking uses stored evidence only';
    try {
      adaptiveStatus = opts.adaptive !== undefined ? opts.adaptive : (this.deps.adaptive?.status() ?? null);
      adaptiveNote = adaptiveStatus
        ? `${adaptiveStatus.contextSummary} (context ${adaptiveStatus.context})`
        : 'adaptive engine returned no state; ranking uses stored evidence only';
    } catch (err) {
      adaptiveNote = `adaptive engine threw (${err instanceof Error ? err.message : String(err)}); ranking uses stored evidence only`;
    }

    const { list: probabilities, byEngine } = engineProbabilities(adaptiveStatus);

    const excluded: SmartExclusion[] = [];
    const candidates: SmartCandidate[] = [];

    for (const row of rows) {
      const age = now - row.lastSeen;
      if (row.status === 'revoked' || row.status === 'blocked') {
        excluded.push({ nodeId: row.id, reason: 'revoked' });
        continue;
      }
      if (row.consecutiveFailures >= FAILED_AT || row.status === 'failed' || row.status === 'dead') {
        excluded.push({ nodeId: row.id, reason: 'failed' });
        continue;
      }
      // Staleness is about EVIDENCE age, not the `freshness` column.
      //
      // `importParsedConfigs` writes every new node as `stale` because it has no
      // test yet, and a successful proxy test does not always clear the flag.
      // Excluding on the raw column therefore did two wrong things in live runs:
      // it emptied the whole freshly discovered catalog, and it would have
      // excluded a node that had just passed a 580 ms / HTTP 200 probe. A row
      // with no evidence is eligible (capped as untested); a row whose evidence
      // is older than EVIDENCE_STALE_AFTER, or which has only failing tests, is not.
      const evidenceAt = Math.max(row.lastSuccessAt ?? 0, row.lastValidated ?? 0);
      const hasEvidence = evidenceAt > 0;
      const evidenceTooOld = hasEvidence && now - evidenceAt > EVIDENCE_STALE_AFTER;
      const failedOnly = !hasEvidence && row.testCount > 0;
      const staleByTime = row.freshness === 'expired' || evidenceTooOld;
      if (staleByTime || failedOnly) {
        const refreshing = opts.allowStale === true && staleByTime && !failedOnly;
        if (!refreshing) {
          excluded.push({ nodeId: row.id, reason: 'stale' });
          continue;
        }
      }
      if (age > ABANDONED_AFTER) {
        excluded.push({ nodeId: row.id, reason: 'abandoned' });
        continue;
      }
      const selected = engineForRow(row, installed);
      const engine = selected.engine;
      if (engine == null) {
        if (selected.rejected) {
          // An engine is installed and knows this protocol, but refuses this
          // config. Say so instead of blaming the node's liveness or the user's
          // missing core — and instead of spending a probe to prove it.
          excluded.push({ nodeId: row.id, reason: 'engine-rejects-config' });
          continue;
        }
        // Distinguish "this protocol is unsupported everywhere" from "no core
        // is installed": the first is a property of the config, the second is
        // a property of this machine, and the UI must say which.
        const anyProtocolSupport = (['xray', 'sing-box', 'v2ray', 'hysteria'] as ProxyEngineId[]).some((e) =>
          engineSupports(e, row.protocol),
        );
        excluded.push({ nodeId: row.id, reason: anyProtocolSupport ? 'no-engine-installed' : 'unsupported-protocol' });
        continue;
      }

      const reliability = clamp(Math.round(row.reliabilityPct), 0, 100);
      const latency = latencyScore(row);
      const freshness = freshnessScore(row, now);
      const evidence = evidenceScore(row, now);
      const sources = clamp(Math.round((Math.min(row.sourceCount, 5) / 5) * 100), 0, 100);
      const adaptiveBoost = clamp(byEngine.get(engine) ?? 0, -8, 8);
      const failurePenalty = -clamp(row.consecutiveFailures * 6, 0, 30);

      const base =
        reliability * 0.3 + latency * 0.24 + freshness * 0.16 + evidence * 0.16 + sources * 0.08;

      let score = Math.round(clamp(base + adaptiveBoost + failurePenalty, 0, 100));
      const confidence = confidenceOf(row, now);
      if (confidence === 'untested') score = Math.min(score, UNTESTED_CAP);
      // Proxy evidence is the strong signal; a port-only success is the weak one.
      if (confidence !== 'untested' && row.lastProxyMs == null) score = Math.min(score, PORT_ONLY_CAP);

      const reasons: string[] = [];
      reasons.push(`reliability ${reliability}% over ${row.testCount} test${row.testCount === 1 ? '' : 's'}`);
      reasons.push(
        latency > 0
          ? `latency evidence ${row.medianProxyMs ?? row.lastProxyMs ?? row.medianTcpMs ?? row.lastTcpMs} ms`
          : 'no latency measurement yet',
      );
      reasons.push(
        row.lastSuccessAt != null
          ? `last verified success ${Math.round((now - row.lastSuccessAt) / MIN)} min ago`
          : 'never carried verified traffic',
      );
      reasons.push(`seen in ${row.sourceCount} source${row.sourceCount === 1 ? '' : 's'}`);
      if (adaptiveBoost !== 0) {
        reasons.push(`adaptive ${engine}: ${adaptiveBoost > 0 ? '+' : ''}${adaptiveBoost.toFixed(1)} from learned engine performance`);
      }
      if (failurePenalty !== 0) reasons.push(`${row.consecutiveFailures} consecutive failure(s), ${failurePenalty} points`);

      candidates.push({
        nodeId: row.id,
        protocol: row.protocol,
        country: row.country ?? null,
        engine,
        score,
        components: { reliability, latency, freshness, evidence, sources, adaptiveBoost, failurePenalty },
        confidence,
        trust: trustOf(row, now, engine),
        reasons,
        evidenceAgeMs: row.lastSuccessAt != null ? now - row.lastSuccessAt : null,
        probe: null,
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // A verified candidate wins a tie, and then a smaller evidence age does.
      const rank: Record<SmartConfidence, number> = { verified: 2, tested: 1, untested: 0 };
      if (rank[b.confidence] !== rank[a.confidence]) return rank[b.confidence] - rank[a.confidence];
      return (a.evidenceAgeMs ?? Number.MAX_SAFE_INTEGER) - (b.evidenceAgeMs ?? Number.MAX_SAFE_INTEGER);
    });

    const chosen = candidates[0] ?? null;
    const excludedByReason: Record<string, number> = {};
    for (const e of excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;

    const decision =
      chosen == null
        ? explainEmpty(rows.length, excludedByReason)
        : `${chosen.confidence === 'verified' ? 'Verified' : chosen.confidence === 'tested' ? 'Previously tested but not freshly measured' : 'Untested'}: node ${chosen.nodeId} (${chosen.protocol} over ${chosen.engine}), score ${chosen.score}/100. This is a selection, not a connection.`;

    return {
      generatedAt: now,
      considered: rows.length,
      excluded,
      excludedByReason,
      candidates,
      chosen,
      decision,
      adaptive: {
        available: this.deps.adaptive != null,
        enabled: adaptiveStatus?.enabled ?? false,
        context: adaptiveStatus?.context ?? null,
        contextSummary: adaptiveStatus?.contextSummary ?? null,
        engineProbabilities: probabilities,
        note: adaptiveNote,
      },
      limits: [
        'A stored score is historical. A successful test is time-sensitive and is never permanent trust.',
        'The operator of a free public endpoint is unknown; traffic metadata may be visible to them.',
        'Ranking does not imply safety, legality, or that the endpoint will still answer in an hour.',
      ],
    };
  }

  /**
   * Probe the best candidates through a **bounded concurrent pool** and return
   * the highest-ranked candidate that provably carried traffic. Every attempt,
   * including one that finishes after the winner, is fed back to the adaptive
   * engine.
   *
   * Bounded by construction, on three independent axes:
   *  - at most `maxProbes` dials per call (hard ceiling `MAX_PROBES`);
   *  - at most `concurrency` cores alive at once (ceiling `MAX_CONCURRENCY`), so
   *    one call cannot spawn an unbounded number of engine processes;
   *  - no new dial is launched once a candidate has been verified — the pool
   *    drains what is already running and stops.
   *
   * Why a pool and not a loop: a probe costs a core start plus a handshake
   * (hundreds of milliseconds to the full timeout), and most of that is waiting.
   * Running two or three at a time gathers two to three times the real evidence
   * per wall-clock second for the same dial budget — which is what makes the
   * adaptive engine train on this machine at a useful rate.
   *
   * The cost of the parallelism is honest and visible: the pool may dial up to
   * `concurrency` candidates even when the first one succeeds, and `probesRun`
   * reports exactly how many were dialled. Rank order is still authoritative —
   * if a lower-ranked probe succeeds first, the higher-ranked one already in
   * flight wins if it also succeeds.
   */
  async verify(opts: {
    limit?: number;
    maxProbes?: number;
    /** cores dialled at once; clamped to 1..3 and to the probe budget */
    concurrency?: number;
    adaptive?: AdaptiveStatus | null;
  } = {}): Promise<SmartPlan & { probesRun: number; verified: boolean }> {
    const plan = this.plan({ limit: opts.limit, adaptive: opts.adaptive });
    const probe = this.deps.probe;
    const budget = clamp(opts.maxProbes ?? 3, 1, MAX_PROBES);
    const concurrency = clamp(opts.concurrency ?? 2, 1, Math.min(MAX_CONCURRENCY, budget));

    if (!probe) {
      return {
        ...plan,
        probesRun: 0,
        verified: false,
        decision: `${plan.decision} No proxy core probe is available in this process, so nothing was dialled.`,
      };
    }

    // Only candidates the installed cores can actually dial are worth a dial.
    const queue = plan.candidates.filter((c) => c.engine != null).slice(0, budget);
    if (queue.length === 0) {
      return { ...plan, probesRun: 0, verified: false };
    }

    const { probabilityByEngine } = engineProbabilities(opts.adaptive ?? this.deps.adaptive?.status() ?? null);
    const pool = await this.probePool(queue, concurrency, { stopOnVerified: true, predictedByEngine: probabilityByEngine });
    const { probesRun, winner } = pool;

    if (winner !== null) {
      const probe = winner.probe!;
      const latency = probe.latencyMs != null ? `${probe.latencyMs} ms` : 'latency unmeasured';
      return {
        ...plan,
        candidates: orderAfterProbe(plan.candidates, winner.nodeId),
        chosen: winner,
        probesRun,
        verified: true,
        decision: `Traffic verified through node ${winner.nodeId} (${winner.protocol} via ${probe.engine}, ${latency}, HTTP ${probe.httpStatus}). Probe count: ${probesRun}, at most ${concurrency} at a time. Authorise the connection to use this endpoint.`,
      };
    }

    // Nothing carried traffic. Say so with the failures attached; do not fall
    // back to an unverified "best stored score" and call it a connection.
    const failed = probesRun;
    return {
      ...plan,
      candidates: orderAfterProbe(plan.candidates, null),
      chosen: null,
      probesRun,
      verified: false,
      decision: `${failed} candidate${failed === 1 ? '' : 's'} were dialled and none carried traffic. Staying disconnected is the correct outcome; the failures are recorded against each node.`,
    };
  }

  /**
   * Run a bounded pool of probes over `queue`, learning from every settled one.
   *
   * Two callers share this: `verify` (stop at the first success — you want a
   * working endpoint) and `train` (probe the whole batch — you want evidence).
   * The scheduling rules live here once so they cannot drift apart:
   *  - never more than `concurrency` engines alive;
   *  - refill a slot only while there is no winner and the queue has more;
   *  - after a hit, drain in-flight attempts and launch nothing new.
   *
   * `predictedByEngine` is the probability the model assigned to the engine
   * under this context; it is stored with each observation so calibration can be
   * scored instead of assumed.
   */
  private async probePool(
    queue: SmartCandidate[],
    concurrency: number,
    opts: { stopOnVerified: boolean; predictedByEngine: Map<ProxyEngineId, number> },
  ): Promise<{ probesRun: number; winner: SmartCandidate | null; verifiedCount: number }> {
    const probe = this.deps.probe;
    if (!probe || queue.length === 0) return { probesRun: 0, winner: null, verifiedCount: 0 };

    interface Settled {
      idx: number;
      candidate: SmartCandidate;
      result: SmartProbeResult;
      started: number;
    }

    let probesRun = 0;
    let verifiedCount = 0;
    let next = 0;
    let winner: Settled | null = null;
    const inFlight = new Map<number, Promise<Settled>>();

    const dial = (idx: number): void => {
      const candidate = queue[idx]!;
      const started = this.now();
      const attempt = (async (): Promise<Settled> => {
        try {
          return { idx, candidate, started, result: await probe(candidate.nodeId) };
        } catch (err) {
          return {
            idx,
            candidate,
            started,
            result: {
              status: 'error',
              latencyMs: null,
              httpStatus: null,
              engine: candidate.engine,
              error: err instanceof Error ? err.message : String(err),
            },
          };
        }
      })();
      inFlight.set(idx, attempt);
    };

    const settle = (done: Settled): boolean => {
      const { candidate, result } = done;
      probesRun += 1;

      const verified =
        result.status === 'done' &&
        result.engine != null &&
        result.httpStatus != null &&
        result.httpStatus >= 200 &&
        result.httpStatus < 400;
      if (verified) verifiedCount += 1;

      candidate.probe = {
        at: this.now(),
        status: result.status,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        engine: result.engine,
        error: result.error,
        verified,
      };

      const engine = result.engine ?? candidate.engine;
      if (engine == null) return verified;

      try {
        this.deps.adaptive?.observe({
          nodeId: candidate.nodeId,
          engine,
          ok: verified,
          timeToWorkingMs: verified ? Math.max(0, this.now() - done.started) : null,
          failure: verified
            ? null
            : { stage: 'verify', message: result.error ?? 'proxy probe did not carry traffic' },
          predicted: opts.predictedByEngine.get(engine) ?? null,
        });
      } catch {
        // Learning must never be able to fail a connection attempt.
      }

      return verified;
    };

    for (let i = 0; i < Math.min(concurrency, queue.length); i += 1) dial(next++);

    while (inFlight.size > 0) {
      const done = await Promise.race(inFlight.values());
      inFlight.delete(done.idx);

      const verified = settle(done);
      // Rank order decides, not finish order: lowest index that verified wins.
      if (verified && (winner === null || done.idx < winner.idx)) winner = done;

      const stop = opts.stopOnVerified && winner !== null;
      if (!stop && next < queue.length) dial(next++);
    }

    return { probesRun, winner: winner?.candidate ?? null, verifiedCount };
  }

  /**
   * Train the adaptive model on real attempts.
   *
   * This is the counterpart to `verify`, and it deliberately does NOT stop at
   * the first success: a connection wants one working endpoint, a model wants
   * outcomes — including failures, which are the majority of public nodes. Each
   * attempt is observed with the probability the engine had assigned, so the
   * calibration score moves with every batch.
   *
   * Bounded exactly like verification: at most `MAX_PROBES` candidates, at most
   * `MAX_CONCURRENCY` cores at once, and the caller charges the same
   * `network:verify-traffic` allowance before the first dial.
   */
  async train(opts: { size?: number; concurrency?: number } = {}): Promise<{
    attempted: number;
    verified: number;
    failed: number;
    byEngine: Record<string, { attempted: number; verified: number }>;
    candidates: SmartCandidate[];
    calibrationBefore: AdaptiveCalibration | null;
    calibrationAfter: AdaptiveCalibration | null;
    note: string;
  }> {
    const size = clamp(opts.size ?? 6, 1, MAX_PROBES);
    const concurrency = clamp(opts.concurrency ?? 2, 1, Math.min(MAX_CONCURRENCY, size));
    const status = this.deps.adaptive?.status() ?? null;
    const { probabilityByEngine } = engineProbabilities(status);

    if (!this.deps.probe) {
      return {
        attempted: 0,
        verified: 0,
        failed: 0,
        byEngine: {},
        candidates: [],
        calibrationBefore: status?.calibration ?? null,
        calibrationAfter: status?.calibration ?? null,
        note: 'No proxy core probe is available in this process, so nothing was dialled and the model learned nothing.',
      };
    }

    // The top of the ranking is where most undialable configs collect (plaintext
    // VLESS, keyless REALITY, nodes that only ever failed), so a slice of size×6
    // returned 2 eligible candidates out of 6 requested on a live catalogue. A
    // wider slice costs pure ranking work and nothing else.
    const plan = this.plan({ limit: Math.max(size * 20, 200), allowStale: true });
    const queue = plan.candidates.filter((c) => c.engine != null).slice(0, size);
    if (queue.length === 0) {
      return {
        attempted: 0,
        verified: 0,
        failed: 0,
        byEngine: {},
        candidates: [],
        calibrationBefore: status?.calibration ?? null,
        calibrationAfter: status?.calibration ?? null,
        note: `Nothing eligible to dial. ${plan.decision}`,
      };
    }

    const pool = await this.probePool(queue, concurrency, { stopOnVerified: false, predictedByEngine: probabilityByEngine });

    const perEngine: Record<string, { attempted: number; verified: number }> = {};
    for (const c of queue) {
      const engine = c.probe?.engine ?? c.engine;
      if (engine == null || c.probe == null) continue;
      const row = (perEngine[engine] ??= { attempted: 0, verified: 0 });
      row.attempted += 1;
      if (c.probe.verified) row.verified += 1;
    }

    const after = this.deps.adaptive?.status() ?? null;
    const failed = pool.probesRun - pool.verifiedCount;
    return {
      attempted: pool.probesRun,
      verified: pool.verifiedCount,
      failed,
      byEngine: perEngine,
      candidates: queue,
      calibrationBefore: status?.calibration ?? null,
      calibrationAfter: after?.calibration ?? null,
      note: `Probed ${pool.probesRun} candidate${pool.probesRun === 1 ? '' : 's'} at most ${concurrency} at a time: ${pool.verifiedCount} carried traffic, ${failed} did not.${pool.probesRun < size ? ` Only ${plan.candidates.length} of the ${plan.considered} considered configurations were dialable, so the batch was smaller than the ${size} asked for.` : ''} Every attempt was recorded with the probability the model had assigned, so this batch moves the calibration score, not just the counts.`,
    };
  }
}

/**
 * Explain an empty candidate list by its DOMINANT cause.
 *
 * The first version of this said "stale, failing, revoked, or unsupported" for
 * every empty result. A live run with no core installed produced exactly that
 * sentence while the real reason was `no-engine-installed` on all 300 rows —
 * telling the user to give up on their configurations when the fix was to
 * install a core. An empty list must name the filter that emptied it.
 */
function explainEmpty(considered: number, byReason: Record<string, number>): string {
  if (considered === 0) {
    return 'No public configurations are stored. Refresh a source before asking Smart Connect to choose.';
  }
  const ranked = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  const [topReason, topCount] = ranked[0] ?? ['', 0];
  const rest = ranked.slice(1).reduce((sum, [, n]) => sum + n, 0);

  switch (topReason) {
    case 'no-engine-installed':
      return `None of the ${considered} stored configurations can be dialled: no local proxy core is installed that speaks them. Install Xray, sing-box or V2Ray from the core tabs, then ask again. (${topCount} blocked by this${rest > 0 ? `, ${rest} by other filters` : ''}.)`;
    case 'engine-rejects-config':
      return `${topCount} of ${considered} stored configurations are refused by the installed core itself (for example plaintext VLESS to a public IP, which xray rejects at startup). They are not tested, because the outcome is known before a dial.${rest > 0 ? ` ${rest} more were filtered by other rules.` : ''}`;
    case 'unsupported-protocol':
      return `None of the ${considered} stored configurations use a protocol this app can dial. (${topCount} unsupported${rest > 0 ? `, ${rest} by other filters` : ''}.)`;
    case 'stale':
      return `${topCount} of ${considered} stored configurations have stale test evidence. Refresh a source, or run a scan so the evidence is current again. Stay disconnected rather than dialling one on old evidence.`;
    case 'failed':
      return `${topCount} of ${considered} stored configurations are marked failing after repeated attempts. The rest were filtered too; nothing here is worth dialling right now.`;
    case 'abandoned':
      return `${topCount} of ${considered} stored configurations have not appeared in any feed for 7+ days. Refresh your sources to pick up what is current.`;
    default:
      return `No candidate survived the filters (${topCount} excluded by ${topReason || 'unknown reasons'}). Stay disconnected rather than dialling an unverified endpoint.`;
  }
}

/** Move a probed candidate to the front so the caller's list matches the decision. */
function orderAfterProbe(candidates: SmartCandidate[], headId: string | null): SmartCandidate[] {
  if (headId == null) return candidates;
  const head = candidates.find((c) => c.nodeId === headId);
  if (!head) return candidates;
  return [head, ...candidates.filter((c) => c.nodeId !== headId)];
}
