import {
  ADAPTIVE_STATE_VERSION,
  DEFAULT_ADAPTIVE_POLICY,
  type AdaptiveConfidence,
  type AdaptiveDecision,
  type AdaptiveEntry,
  type AdaptiveObservation,
  type AdaptivePolicyOptions,
  type AdaptiveState,
  type AdaptiveStats,
  type AdaptiveStrategy,
} from './types';

/**
 * The policy itself: bounded, decaying, deterministic and explainable.
 *
 * Design choices worth stating, because each one is a rejection of a worse
 * option:
 *
 *  - **No random exploration.** A UCB-shaped bonus ranks what to try when
 *    evidence is thin, and the caller caps how much of its attempt budget may be
 *    spent that way. Thompson sampling would have been tidier to write and
 *    impossible to assert against; every function here is deterministic, so a
 *    test can state exactly what the engine will do.
 *
 *  - **Beta posteriors over decayed counts.** "This strategy worked 7 of 9 times
 *    under these conditions" is a sentence a user can check. A neural network
 *    that fits the same data would hide it, cost more CPU on a phone, and cannot
 *    be reasoned about when it is wrong — so a small trained model is explicitly
 *    NOT introduced until the replay evaluation in `scripts/eval-adaptive` shows
 *    it beating this baseline.
 *
 *  - **Evidence decays, so state does not have to be reset.** A half-life means a
 *    network's old behaviour stops dominating, and a strategy that was bad last
 *    month can win again without anyone clearing anything.
 *
 *  - **No evidence means the OLD behaviour, exactly.** With an empty state the
 *    ranking returns the caller's baseline order with reason
 *    `no-evidence-baseline-order`. The adaptive layer can therefore never make
 *    connection worse than the non-adaptive build on a fresh install — that is
 *    asserted in the policy tests and is the reason it can ship enabled.
 */

/** Versioned empty state. */
export function emptyAdaptiveState(now: number): AdaptiveState {
  return {
    version: ADAPTIVE_STATE_VERSION,
    entries: [],
    observations: [],
    createdAt: now,
    updatedAt: now,
    resetAt: null,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function emptyStats(now: number): AdaptiveStats {
  return { successes: 0, failures: 0, meanSuccessMs: null, consecutiveFailures: 0, updatedAt: now };
}

/**
 * Apply the half-life to stored counts and the mean cost.
 *
 * Decay is applied lazily at read time against `updatedAt`, so a long-idle app
 * does not need a background job to stay honest — the entry simply fades toward
 * the prior the next time anything looks at it.
 */
export function decayStats(stats: AdaptiveStats, now: number, halfLifeMs: number, reference: AdaptiveStats | null = null): AdaptiveStats {
  if (!(halfLifeMs > 0)) return { ...stats };
  const ageMs = Math.max(0, now - finite(stats.updatedAt, now));
  if (ageMs === 0) return { ...stats };
  const factor = Math.pow(0.5, ageMs / halfLifeMs);
  if (factor >= 1) return { ...stats };
  const base = reference ?? { successes: 0, failures: 0, meanSuccessMs: null, consecutiveFailures: 0, updatedAt: now };
  return {
    successes: finite(stats.successes, 0) * factor,
    failures: finite(stats.failures, 0) * factor,
    meanSuccessMs: stats.meanSuccessMs == null ? null : carryMean(base.meanSuccessMs, stats.meanSuccessMs, factor),
    // A failure streak is a statement about NOW, not a rate: it is not decayed,
    // it is cleared by the next verified success.
    consecutiveFailures: Math.max(0, Math.round(finite(stats.consecutiveFailures, 0))),
    updatedAt: now,
  };
}

/**
 * Decayed mean cost: a success at time T is worth `factor` of a recent one, so
 * it drags the estimate only proportionally. No successes yet → no estimate.
 */
function carryMean(previous: number | null, current: number, factor: number): number {
  if (previous == null) return current;
  const weight = 1 - factor;
  if (weight <= 0) return current;
  return previous * factor + current * weight;
}

export interface AdaptivePosterior {
  alpha: number;
  beta: number;
  /** posterior mean of success under this context */
  probability: number;
  /** decayed observation count (successes + failures) */
  evidence: number;
}

/**
 * Two decimals is the resolution the engine reasons and reports at.
 *
 * Without it, a single observation made five seconds ago decays to 0.999996 and
 * reads as "no evidence", while a build with exactly `minSamples` quickly-aged
 * samples reads as "not enough" — labels that depend on the clock rather than on
 * what was observed. Rounding is applied here, once, so the number in the
 * explanation is the number the decision used.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Beta(1,1) prior over the decayed counts — so 0 observations is "unknown", not "0%". */
export function posteriorOf(stats: AdaptiveStats, now: number, options: AdaptivePolicyOptions): AdaptivePosterior {
  const decayed = decayStats(stats, now, options.halfLifeMs);
  const successes = round2(Math.max(0, finite(decayed.successes, 0)));
  const failures = round2(Math.max(0, finite(decayed.failures, 0)));
  const alpha = 1 + successes;
  const beta = 1 + failures;
  return { alpha, beta, probability: alpha / (alpha + beta), evidence: round2(successes + failures) };
}

export function confidenceOf(evidence: number, options: AdaptivePolicyOptions): AdaptiveConfidence {
  if (evidence < 1) return 'none';
  if (evidence < options.minSamples) return 'low';
  if (evidence < options.minSamples * 3) return 'medium';
  return 'high';
}

/**
 * Score = expected success − time cost. Cost is normalized so the weight means
 * "how much of a probability point is worth one full-cost connect", keeping the
 * two terms comparable rather than unit-dependent.
 */
export function scoreOf(stats: AdaptiveStats, posterior: AdaptivePosterior, options: AdaptivePolicyOptions): number {
  const cost = stats.meanSuccessMs == null ? 0 : clamp(stats.meanSuccessMs / options.costReferenceMs, 0, 1);
  return posterior.probability - options.costWeight * cost;
}

/** The ordinal position of a strategy in the caller's baseline order. */
function baselineIndex(order: readonly string[], id: string): number {
  const i = order.indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export interface RankInput {
  state: AdaptiveState;
  context: string;
  /** strategies that are approved, installed and compatible with the candidate */
  strategies: readonly AdaptiveStrategy[];
  /** what the app would do today, with no learning: the parity anchor */
  baselineOrder: readonly string[];
  now: number;
  options?: Partial<AdaptivePolicyOptions>;
  /** how many attempts the caller can afford; caps exploration, never exceeds it */
  attemptBudget?: number;
}

interface Scored {
  strategy: AdaptiveStrategy;
  stats: AdaptiveStats;
  posterior: AdaptivePosterior;
  score: number;
  /** exploration bonus (UCB shape) — only used to rank untrusted strategies */
  bonus: number;
  trusted: boolean;
  cooling: boolean;
}

/**
 * Order the approved strategies for one decision, and explain every position.
 *
 * Returns one decision per strategy, in the order they should be attempted. The
 * list is never shorter than what the caller passed in: dropping a candidate is
 * `quickConnectCore`'s business, not the policy's.
 */
export function rankStrategies(input: RankInput): AdaptiveDecision[] {
  const options = { ...DEFAULT_ADAPTIVE_POLICY, ...(input.options ?? {}) };
  const budget = Math.max(1, Math.floor(input.attemptBudget ?? input.strategies.length));

  const entries = new Map<string, AdaptiveStats>();
  for (const entry of input.state.entries) {
    if (entry.context !== input.context) continue;
    entries.set(entry.strategyId, entry.stats);
  }

  const scored: Scored[] = input.strategies.map((strategy) => {
    const stats = decayStats(entries.get(strategy.id) ?? emptyStats(input.now), input.now, options.halfLifeMs);
    const posterior = posteriorOf(stats, input.now, options);
    const trusted = posterior.evidence >= options.minSamples;
    // UCB-shaped exploration bonus: an untried strategy has infinite bonus, so
    // the probe order among untried strategies falls back to the baseline order
    // (deterministic), and a strategy tried twice is probed before one tried
    // forty times.
    const bonus = posterior.evidence === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(Math.log(1 + totalEvidence(entries)) / (1 + posterior.evidence));
    return {
      strategy,
      stats,
      posterior,
      score: scoreOf(stats, posterior, options),
      bonus,
      trusted,
      cooling: stats.consecutiveFailures >= options.flopThreshold,
    };
  });

  const byBaseline = (a: Scored, b: Scored): number => {
    const ai = baselineIndex(input.baselineOrder, a.strategy.id);
    const bi = baselineIndex(input.baselineOrder, b.strategy.id);
    if (ai !== bi) return ai - bi;
    return a.strategy.id < b.strategy.id ? -1 : a.strategy.id > b.strategy.id ? 1 : 0;
  };

  const trusted = scored.filter((s) => s.trusted);
  const untrusted = scored.filter((s) => !s.trusted).sort(byBaseline);

  // Nothing is known well enough to reorder: keep the baseline, say so.
  if (trusted.length === 0) {
    const anyEvidence = scored.some((s) => s.posterior.evidence > 0);
    return [...scored]
      .sort(byBaseline)
      .map((s) =>
        decision(s, options, {
          exploratory: false,
          reason: anyEvidence ? 'insufficient-evidence' : 'no-evidence-baseline-order',
          explanation: anyEvidence
            ? `Only ${formatEvidence(s.posterior.evidence)} observation(s) here — ${options.minSamples} are needed before this can be preferred, so the default order is kept.`
            : 'No stored evidence for these network conditions, so the default order is used.',
        }),
      );
  }

  // Trusted strategies first, best score first; a cooling-off strategy is pushed
  // below the ones that are not, because its failures are recent and consecutive.
  const trustedOrdered = [...trusted].sort((a, b) => {
    if (a.cooling !== b.cooling) return a.cooling ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return byBaseline(a, b);
  });

  const order: AdaptiveDecision[] = trustedOrdered.map((s, index) =>
    decision(s, options, {
      exploratory: false,
      reason: s.cooling ? 'cooling-off-after-failures' : index === 0 ? 'learned-best' : 'learned-lower',
      explanation: s.cooling
        ? `Cooling off: ${s.stats.consecutiveFailures} consecutive failures under these conditions.`
        : index === 0
          ? `Best under these conditions: ${formatEvidence(s.posterior.evidence)} observations, ${formatPct(s.posterior.probability)} reached the internet${s.stats.meanSuccessMs == null ? '' : `, typically in ${formatMs(s.stats.meanSuccessMs)}`}.`
          : `Kept below a better-scoring option here (${formatEvidence(s.posterior.evidence)} observations, ${formatPct(s.posterior.probability)}).`,
    }),
  );

  // Fallback, not exploration: when EVERY trusted strategy is cooling off, the
  // learned leaders are known-broken right now, so repeating them spends the whole
  // budget re-learning what the state already says — and a small budget never
  // reaches the option that might still work. One untried, non-cooling strategy is
  // therefore placed first.
  //
  // This is a measured dead-end, not a hypothesis. Against the live VPS corpus
  // (2026-10-27) the app's real 2-attempt budget floors 0.25 × 2 to zero
  // exploration slots, every recorded xray/sing-box attempt timed out while v2ray
  // carried traffic in ~1.3 s, and BOTH policies reached a working core 0 % of the
  // time: the working core was never in the first two positions.
  //
  // Deliberately NOT gated on `explorationShare`: that setting is the user opting
  // into probes that gather evidence, whereas this is recovery from a state where
  // every known option has just failed repeatedly. It is bounded — one candidate,
  // only in this state, only from strategies that are not cooling — and it never
  // invents a candidate: it reorders what the caller already approved.
  const allTrustedCooling = trusted.length > 0 && trusted.every((s) => s.cooling);
  const fallback = allTrustedCooling ? (untrusted.find((s) => !s.cooling) ?? null) : null;

  // Exploration: bounded by the share of the attempt budget, normally placed after
  // the learned options, and only for strategies whose local evidence is thin. An
  // untried strategy is ranked by its bonus (how much a probe would teach), not by
  // a hoped-for win.
  const explorationSlots = options.explorationShare > 0 ? Math.floor(budget * options.explorationShare) : 0;
  const candidatesForProbe = untrusted
    .filter((s) => !s.cooling && s.strategy.id !== fallback?.strategy.id)
    .sort((a, b) => (b.bonus !== a.bonus ? b.bonus - a.bonus : byBaseline(a, b)))
    .slice(0, explorationSlots);

  const promoted = new Set(candidatesForProbe.map((s) => s.strategy.id));
  const promotedDecisions: AdaptiveDecision[] = candidatesForProbe.map((s) =>
    decision(s, options, {
      exploratory: true,
      reason: 'exploratory-probe',
      explanation: `Exploratory probe: tried to learn whether it works here (${formatEvidence(s.posterior.evidence)} of ${options.minSamples} observations so far), not because it is expected to win.`,
    }),
  );

  const rest = untrusted
    .filter((s) => !promoted.has(s.strategy.id) && s.strategy.id !== fallback?.strategy.id)
    .map((s) =>
      decision(s, options, {
        exploratory: false,
        reason: 'insufficient-evidence',
        explanation: `Not enough evidence here (${formatEvidence(s.posterior.evidence)} of ${options.minSamples}) — kept in its default position.`,
      }),
    );

  const fallbackDecisions: AdaptiveDecision[] = fallback
    ? [
        decision(fallback, options, {
          exploratory: false,
          reason: 'fallback-after-cooling',
          explanation: `Fallback: every option already known under these conditions is cooling off after consecutive failures, so the next approved one is tried instead of repeating a known-broken core (${formatEvidence(fallback.posterior.evidence)} of ${options.minSamples} observations so far).`,
        }),
      ]
    : [];

  // Order: the fallback when the learned options are all cooling off, then the
  // learned first, then at most the explored slice, then everything else.
  return [...fallbackDecisions, ...order, ...promotedDecisions, ...rest];
}

/** Total stored evidence in this context — the UCB budget term. */
function totalEvidence(entries: Map<string, AdaptiveStats>): number {
  let total = 0;
  for (const stats of entries.values()) {
    total += Math.max(0, finite(stats.successes, 0)) + Math.max(0, finite(stats.failures, 0));
  }
  return total;
}

function decision(
  s: Scored,
  options: AdaptivePolicyOptions,
  extra: { exploratory: boolean; reason: AdaptiveDecision['reason']; explanation: string },
): AdaptiveDecision {
  return {
    strategyId: s.strategy.id,
    engine: s.strategy.engine,
    dnsThroughTunnel: s.strategy.dnsThroughTunnel,
    label: s.strategy.label,
    successProbability: s.posterior.probability,
    score: s.score,
    evidence: s.posterior.evidence,
    confidence: confidenceOf(s.posterior.evidence, options),
    exploratory: extra.exploratory,
    reason: extra.reason,
    explanation: extra.explanation,
  };
}

function formatEvidence(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/* ------------------------------- observations ------------------------------ */

/**
 * Fold one real outcome into the state. Pure: the caller persists the result.
 *
 * `timeToWorkingMs` is only accepted when the attempt SUCCEEDED — a failed
 * attempt has no time-to-working-tunnel, and storing one would corrupt the cost
 * estimate the score depends on.
 */
export function applyObservation(
  state: AdaptiveState,
  observation: AdaptiveObservation,
  options?: Partial<AdaptivePolicyOptions>,
): AdaptiveState {
  const opts = { ...DEFAULT_ADAPTIVE_POLICY, ...(options ?? {}) };
  const at = finite(observation.at, Date.now());
  const ok = observation.ok === true;

  const key = `${observation.context}\u0000${observation.strategyId}`;
  const index = new Map(state.entries.map((e, i) => [`${e.context}\u0000${e.strategyId}`, i]));
  const entries = state.entries.map((e) => ({ ...e, stats: { ...e.stats } }));

  const existingIndex = index.get(key);
  const previous = existingIndex == null ? null : entries[existingIndex]!;
  const base = previous ? decayStats(previous.stats, at, opts.halfLifeMs) : emptyStats(at);

  const successes = Math.max(0, finite(base.successes, 0)) + (ok ? 1 : 0);
  const failures = Math.max(0, finite(base.failures, 0)) + (ok ? 0 : 1);
  const timeToWorkingMs = ok ? observation.timeToWorkingMs : null;
  const meanSuccessMs =
    timeToWorkingMs != null && Number.isFinite(timeToWorkingMs)
      ? base.meanSuccessMs == null
        ? timeToWorkingMs
        : base.meanSuccessMs * 0.7 + timeToWorkingMs * 0.3
      : base.meanSuccessMs;

  const stats: AdaptiveStats = {
    successes,
    failures,
    meanSuccessMs,
    consecutiveFailures: ok ? 0 : Math.max(0, finite(base.consecutiveFailures, 0)) + 1,
    updatedAt: at,
  };

  const next: AdaptiveEntry = { context: observation.context, strategyId: observation.strategyId, stats };
  if (previous) entries[existingIndex!] = next;
  else entries.push(next);

  const observations = [...state.observations, { ...observation, at }].slice(-opts.maxObservations);

  return pruneState(
    {
      version: ADAPTIVE_STATE_VERSION,
      entries,
      observations,
      createdAt: finite(state.createdAt, at),
      updatedAt: at,
      resetAt: state.resetAt ?? null,
    },
    opts,
  );
}

/**
 * Keep the stored state bounded: at most `maxContexts` buckets (most recently
 * updated kept) and at most `maxStrategiesPerContext` strategies each (strongest
 * evidence kept). Storage on a phone is not free, and an unbounded map of
 * contexts is how a "lightweight" learner quietly becomes a large one.
 */
export function pruneState(state: AdaptiveState, options?: Partial<AdaptivePolicyOptions>): AdaptiveState {
  const opts = { ...DEFAULT_ADAPTIVE_POLICY, ...(options ?? {}) };

  const byContext = new Map<string, AdaptiveEntry[]>();
  for (const entry of state.entries) {
    const list = byContext.get(entry.context) ?? [];
    list.push(entry);
    byContext.set(entry.context, list);
  }

  const contexts = [...byContext.entries()].sort((a, b) => lastUpdated(b[1]) - lastUpdated(a[1])).slice(0, opts.maxContexts);

  const entries: AdaptiveEntry[] = [];
  for (const [, list] of contexts) {
    const kept = [...list]
      .sort((a, b) => evidenceOf(b.stats) - evidenceOf(a.stats))
      .slice(0, opts.maxStrategiesPerContext);
    entries.push(...kept);
  }

  return {
    ...state,
    entries,
    observations: state.observations.slice(-opts.maxObservations),
    updatedAt: state.updatedAt,
  };
}

function lastUpdated(entries: AdaptiveEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, finite(e.stats.updatedAt, 0)), 0);
}

function evidenceOf(stats: AdaptiveStats): number {
  return Math.max(0, finite(stats.successes, 0)) + Math.max(0, finite(stats.failures, 0));
}

/** Explicit user reset — the whole point of "clear local learning data". */
export function resetAdaptiveState(now: number): AdaptiveState {
  return { ...emptyAdaptiveState(now), resetAt: now };
}

/* ------------------------------ (de)serialization ------------------------- */

/**
 * Read persisted state defensively. A corrupt blob, a future schema version or a
 * nonsensical number degrades to "no evidence" — never to a decision made from
 * garbage, and never to a crash on the connection path.
 */
export function parseAdaptiveState(
  raw: unknown,
  options?: Partial<AdaptivePolicyOptions>,
): { state: AdaptiveState; warnings: string[] } {
  const now = Date.now();
  const warnings: string[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: emptyAdaptiveState(now), warnings };
  }
  const candidate = raw as Partial<AdaptiveState> & { version?: unknown };
  if (finite(candidate.version, -1) !== ADAPTIVE_STATE_VERSION) {
    warnings.push(`adaptive state version ${String(candidate.version)} is not ${ADAPTIVE_STATE_VERSION} — starting from no evidence`);
    return { state: emptyAdaptiveState(now), warnings };
  }

  const entries: AdaptiveEntry[] = [];
  for (const entry of Array.isArray(candidate.entries) ? candidate.entries : []) {
    const e = entry as Partial<AdaptiveEntry> | null;
    if (!e || typeof e.context !== 'string' || typeof e.strategyId !== 'string') {
      warnings.push('dropped a malformed adaptive entry');
      continue;
    }
    const s = (e.stats ?? {}) as Partial<AdaptiveStats>;
    const successes = finite(s.successes, 0);
    const failures = finite(s.failures, 0);
    if (successes < 0 || failures < 0) {
      warnings.push('dropped an adaptive entry with negative counts');
      continue;
    }
    entries.push({
      context: e.context,
      strategyId: e.strategyId,
      stats: {
        successes,
        failures,
        meanSuccessMs: typeof s.meanSuccessMs === 'number' && Number.isFinite(s.meanSuccessMs) ? s.meanSuccessMs : null,
        consecutiveFailures: Math.max(0, Math.round(finite(s.consecutiveFailures, 0))),
        updatedAt: finite(s.updatedAt, now),
      },
    });
  }

  const observations: AdaptiveObservation[] = [];
  for (const observation of Array.isArray(candidate.observations) ? candidate.observations : []) {
    const o = observation as Partial<AdaptiveObservation> | null;
    if (!o || typeof o.context !== 'string' || typeof o.strategyId !== 'string' || typeof o.ok !== 'boolean') continue;
    observations.push({
      at: finite(o.at, now),
      context: o.context,
      strategyId: o.strategyId,
      ok: o.ok,
      timeToWorkingMs: typeof o.timeToWorkingMs === 'number' && Number.isFinite(o.timeToWorkingMs) ? o.timeToWorkingMs : null,
      failureKind: (o.failureKind ?? null) as AdaptiveObservation['failureKind'],
      reasonCode: typeof o.reasonCode === 'string' ? o.reasonCode : null,
    });
  }

  return {
    state: pruneState(
      {
        version: ADAPTIVE_STATE_VERSION,
        entries,
        observations,
        createdAt: finite(candidate.createdAt, now),
        updatedAt: finite(candidate.updatedAt, now),
        resetAt: typeof candidate.resetAt === 'number' && Number.isFinite(candidate.resetAt) ? candidate.resetAt : null,
      },
      options,
    ),
    warnings,
  };
}

/** The persisted shape: exactly the state, nothing else. */
export function serializeAdaptiveState(state: AdaptiveState): AdaptiveState {
  return {
    version: ADAPTIVE_STATE_VERSION,
    entries: state.entries,
    observations: state.observations,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    resetAt: state.resetAt ?? null,
  };
}

/* ---------------------------------- summary -------------------------------- */

/** One (context, strategy) row as the diagnostics UI shows it. */
export interface AdaptiveStateRow {
  context: string;
  contextSummary: string;
  strategyId: string;
  successes: number;
  failures: number;
  evidence: number;
  successProbability: number;
  confidence: AdaptiveConfidence;
  meanSuccessMs: number | null;
  consecutiveFailures: number;
  updatedAt: number;
}

/** Bounded, newest-first rows for the UI. Evidence is decayed to `now`. */
export function summarizeState(
  state: AdaptiveState,
  now: number,
  options?: Partial<AdaptivePolicyOptions>,
): AdaptiveStateRow[] {
  const opts = { ...DEFAULT_ADAPTIVE_POLICY, ...(options ?? {}) };
  return state.entries
    .map((entry) => {
      const posterior = posteriorOf(entry.stats, now, opts);
      const decayed = decayStats(entry.stats, now, opts.halfLifeMs);
      return {
        context: entry.context,
        contextSummary: describeContext(entry.context),
        strategyId: entry.strategyId,
        successes: Math.round(decayed.successes * 10) / 10,
        failures: Math.round(decayed.failures * 10) / 10,
        evidence: Math.round(posterior.evidence * 10) / 10,
        successProbability: posterior.probability,
        confidence: confidenceOf(posterior.evidence, opts),
        meanSuccessMs: decayed.meanSuccessMs,
        consecutiveFailures: decayed.consecutiveFailures,
        updatedAt: entry.stats.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Local copy of the bucket reader, to keep this module dependency-free. */
function describeContext(bucket: string): string {
  const parts = bucket.split('|');
  const get = (prefix: string): string | null => {
    const found = parts.find((p) => p.startsWith(`${prefix}:`));
    return found ? found.slice(prefix.length + 1) : null;
  };
  const bits: string[] = [];
  if (get('dns') === '1') bits.push('DNS failing');
  if (get('tls') === '1') bits.push('TLS failing');
  if (get('relay') === '1') bits.push('a relay worked');
  if (get('v6') === '1') bits.push('IPv6 present');
  const profile = get('p');
  if (profile) bits.push(`${profile} profile`);
  return bits.length > 0 ? bits.join(', ') : 'no distinguishing observations';
}
