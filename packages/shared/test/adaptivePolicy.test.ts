import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_STATE_VERSION,
  DEFAULT_ADAPTIVE_POLICY,
  applyObservation,
  contextBucketOf,
  decayStats,
  emptyAdaptiveState,
  parseAdaptiveState,
  posteriorOf,
  rankStrategies,
  resetAdaptiveState,
  serializeAdaptiveState,
  summarizeState,
  type AdaptiveContextSignals,
  type AdaptiveObservation,
  type AdaptiveState,
  type AdaptiveStrategy,
} from '../src/adaptive';

/**
 * The policy's contract, stated as tests.
 *
 * The first block is the one that matters most: with no evidence the engine must
 * reproduce the behaviour the app had before it existed. That is what makes it
 * safe to ship enabled, and it is asserted rather than assumed.
 */

const signals = (over: Partial<AdaptiveContextSignals> = {}): AdaptiveContextSignals => ({
  dnsFailing: false,
  tlsFailing: false,
  relayWorked: false,
  ipv6: false,
  profile: 'balanced',
  ...over,
});

const CONTEXT = contextBucketOf(signals());

function strategy(id: string): AdaptiveStrategy {
  const [engine, suffix] = id.split('+');
  return {
    id,
    engine: (engine ?? 'xray') as AdaptiveStrategy['engine'],
    dnsThroughTunnel: suffix === 'doh',
    label: id,
  };
}

function stateWith(rows: Array<{ context?: string; strategyId: string; successes?: number; failures?: number; meanSuccessMs?: number | null; consecutiveFailures?: number; updatedAt?: number }>, now: number): AdaptiveState {
  return {
    version: ADAPTIVE_STATE_VERSION,
    entries: rows.map((r) => ({
      context: r.context ?? CONTEXT,
      strategyId: r.strategyId,
      stats: {
        successes: r.successes ?? 0,
        failures: r.failures ?? 0,
        meanSuccessMs: r.meanSuccessMs ?? null,
        consecutiveFailures: r.consecutiveFailures ?? 0,
        updatedAt: r.updatedAt ?? now,
      },
    })),
    observations: [],
    createdAt: now,
    updatedAt: now,
    resetAt: null,
  };
}

const BASELINE = ['xray', 'sing-box', 'v2ray'];

describe('no evidence means the old behaviour, exactly', () => {
  it('keeps the baseline order when nothing has been learned', () => {
    const now = Date.now();
    const decisions = rankStrategies({
      state: emptyAdaptiveState(now),
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions.map((d) => d.strategyId)).toEqual(BASELINE);
    expect(decisions.every((d) => d.reason === 'no-evidence-baseline-order')).toBe(true);
    expect(decisions.every((d) => d.exploratory === false)).toBe(true);
    expect(decisions.every((d) => d.confidence === 'none')).toBe(true);
    expect(decisions[0]!.explanation).toMatch(/default order/);
  });

  it('refuses to reorder on fewer observations than minSamples', () => {
    const now = Date.now();
    const state = stateWith(
      [
        { strategyId: 'v2ray', successes: 3, failures: 0 },
        { strategyId: 'xray', successes: 0, failures: 4 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions.map((d) => d.strategyId)).toEqual(BASELINE);
    expect(decisions.every((d) => d.reason === 'insufficient-evidence')).toBe(true);
    // Each position explains its OWN count, so "4 observations" on the strategy
    // with four failures is the honest number to quote.
    expect(decisions[0]!.explanation).toMatch(/4 observation/);
    expect(decisions[1]!.explanation).toMatch(/No stored|0 observation/);
    expect(decisions[0]!.explanation).toContain(String(DEFAULT_ADAPTIVE_POLICY.minSamples));
  });

  it('ignores evidence recorded under a different context', () => {
    const now = Date.now();
    const otherContext = contextBucketOf(signals({ tlsFailing: true }));
    const state = stateWith([{ context: otherContext, strategyId: 'v2ray', successes: 40, failures: 0 }], now);

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions.map((d) => d.strategyId)).toEqual(BASELINE);
    expect(decisions.every((d) => d.evidence === 0)).toBe(true);
  });
});

describe('learning from verified outcomes', () => {
  it('prefers the strategy that reached the internet here', () => {
    const now = Date.now();
    const state = stateWith(
      [
        { strategyId: 'xray', successes: 1, failures: 6 },
        { strategyId: 'sing-box', successes: 9, failures: 1, meanSuccessMs: 1_800 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions[0]!.strategyId).toBe('sing-box');
    expect(decisions[0]!.reason).toBe('learned-best');
    expect(decisions[0]!.confidence).toBe('medium');
    // Beta(1,1) prior over 9 successes / 1 failure → 10/12, quoted as 83%.
    expect(decisions[0]!.explanation).toMatch(/83%/);
    expect(decisions[0]!.explanation).toMatch(/1\.8 s/);
    // Nothing is dropped: the caller still owns the attempt budget.
    expect(decisions).toHaveLength(3);
  });

  it('lets time-to-working-tunnel break a tie in success probability', () => {
    const now = Date.now();
    const state = stateWith(
      [
        { strategyId: 'xray', successes: 6, failures: 0, meanSuccessMs: 8_500 },
        { strategyId: 'v2ray', successes: 6, failures: 0, meanSuccessMs: 600 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions[0]!.strategyId).toBe('v2ray');
    expect(decisions[1]!.strategyId).toBe('xray');
  });

  it('demotes a strategy that is failing right now, even with a good record', () => {
    const now = Date.now();
    const state = stateWith(
      [
        { strategyId: 'xray', successes: 20, failures: 2, consecutiveFailures: 3 },
        { strategyId: 'sing-box', successes: 5, failures: 0 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions[0]!.strategyId).toBe('sing-box');
    expect(decisions[1]!.strategyId).toBe('xray');
    expect(decisions[1]!.reason).toBe('cooling-off-after-failures');
    expect(decisions[1]!.explanation).toMatch(/3 consecutive failures/);
  });
});

describe('decay and reset', () => {
  it('fades old evidence until it no longer justifies a reorder', () => {
    const now = Date.now();
    const stale = now - 60 * 24 * 60 * 60 * 1000;
    const state = stateWith([{ strategyId: 'v2ray', successes: 60, failures: 1, updatedAt: stale }], now);

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });

    expect(decisions[0]!.evidence).toBeLessThan(1);
    expect(decisions.map((d) => d.strategyId)).toEqual(BASELINE);
    expect(decisions[0]!.reason).toBe('insufficient-evidence');
  });

  it('decays toward the prior rather than to zero', () => {
    const now = Date.now();
    const stale = now - 120 * 24 * 60 * 60 * 1000;
    const decayed = decayStats(
      { successes: 10, failures: 0, meanSuccessMs: 1_000, consecutiveFailures: 0, updatedAt: stale },
      now,
      DEFAULT_ADAPTIVE_POLICY.halfLifeMs,
    );
    const posterior = posteriorOf(decayed, now, DEFAULT_ADAPTIVE_POLICY);
    // Beta(1,1) prior stays behind the evidence, so a fainted strategy reads as
    // "unknown" (0.5), never as "proven bad" (0).
    expect(posterior.probability).toBeGreaterThan(0.5);
    expect(posterior.probability).toBeLessThan(0.6);
  });

  it('clears everything on an explicit reset, and records that it happened', () => {
    const now = Date.now();
    const state = stateWith([{ strategyId: 'v2ray', successes: 9, failures: 0 }], now);
    const reset = resetAdaptiveState(now);

    expect(reset.entries).toEqual([]);
    expect(reset.observations).toEqual([]);
    expect(reset.resetAt).toBe(now);

    const decisions = rankStrategies({
      state: reset,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
    });
    expect(decisions.map((d) => d.strategyId)).toEqual(BASELINE);
  });
});

describe('bounded exploration', () => {
  it('caps exploration at the configured share of the attempt budget', () => {
    const now = Date.now();
    const state = stateWith([{ strategyId: 'xray', successes: 8, failures: 0 }], now);

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 8,
      options: { explorationShare: 0.25 },
    });

    const exploratory = decisions.filter((d) => d.exploratory);
    expect(exploratory).toHaveLength(2); // floor(8 × 0.25)
    expect(decisions[0]!.exploratory).toBe(false); // never the leading position
    expect(exploratory[0]!.reason).toBe('exploratory-probe');
    expect(exploratory[0]!.explanation).toMatch(/Exploratory/);
  });

  it('does not explore at all when the budget cannot afford it', () => {
    const now = Date.now();
    const state = stateWith([{ strategyId: 'xray', successes: 8, failures: 0 }], now);

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 3,
      options: { explorationShare: 0.25 },
    });

    expect(decisions.some((d) => d.exploratory)).toBe(false);
    expect(decisions.map((d) => d.strategyId)).toEqual(['xray', 'sing-box', 'v2ray']);
  });

  it('falls back to an untried strategy at a two-attempt budget once every learned option is cooling', () => {
    const now = Date.now();
    // The live-corpus dead-end: both learned cores failed the last N times in a
    // row, the budget is the app's real 2, and 0.25 × 2 floors to zero exploration
    // slots — so without this rule the working-but-untried core is never reached.
    const state = stateWith(
      [
        { strategyId: 'xray', successes: 0, failures: 6, consecutiveFailures: 6 },
        { strategyId: 'sing-box', successes: 0, failures: 6, consecutiveFailures: 6 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 2,
      options: { explorationShare: 0.25 },
    });

    expect(decisions.map((d) => d.strategyId)).toEqual(['v2ray', 'xray', 'sing-box']);
    expect(decisions[0]!.exploratory).toBe(false);
    expect(decisions[0]!.reason).toBe('fallback-after-cooling');
    expect(decisions[0]!.explanation).toMatch(/every option already known under these conditions is cooling off/);
    expect(decisions.slice(1).map((d) => d.reason)).toEqual([
      'cooling-off-after-failures',
      'cooling-off-after-failures',
    ]);
  });

  it('keeps a learned leader that is still working in front of any probe', () => {
    const now = Date.now();
    const state = stateWith([{ strategyId: 'xray', successes: 6, failures: 0 }], now);

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 2,
      options: { explorationShare: 0.25 },
    });

    expect(decisions.map((d) => d.strategyId)).toEqual(BASELINE);
    expect(decisions.some((d) => d.exploratory)).toBe(false);
  });

  it('keeps the cooling fallback when exploration is switched off, but probes nothing', () => {
    const now = Date.now();
    const state = stateWith(
      [
        { strategyId: 'xray', successes: 0, failures: 6, consecutiveFailures: 6 },
        { strategyId: 'sing-box', successes: 0, failures: 6, consecutiveFailures: 6 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 2,
      options: { explorationShare: 0 },
    });

    // Recovery from a dead-end is not the evidence-gathering the user opted out of.
    expect(decisions.some((d) => d.exploratory)).toBe(false);
    expect(decisions[0]!.strategyId).toBe('v2ray');
    expect(decisions[0]!.reason).toBe('fallback-after-cooling');
  });

  it('prefers a proven leader over the cooling fallback', () => {
    const now = Date.now();
    // Non-cooling leader + one cooling option: the normal case, unchanged — no
    // fallback is inserted ahead of a leader that still works.
    const state = stateWith(
      [
        { strategyId: 'sing-box', successes: 6, failures: 0 },
        { strategyId: 'xray', successes: 20, failures: 2, consecutiveFailures: 4 },
      ],
      now,
    );

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 2,
      options: { explorationShare: 0.25 },
    });

    expect(decisions[0]!.strategyId).toBe('sing-box');
    expect(decisions[0]!.reason).toBe('learned-best');
    expect(decisions.some((d) => d.reason === 'fallback-after-cooling')).toBe(false);
  });

  it('never explores when exploration is switched off', () => {
    const now = Date.now();
    const state = stateWith([{ strategyId: 'xray', successes: 8, failures: 0 }], now);

    const decisions = rankStrategies({
      state,
      context: CONTEXT,
      strategies: BASELINE.map(strategy),
      baselineOrder: BASELINE,
      now,
      attemptBudget: 20,
      options: { explorationShare: 0 },
    });

    expect(decisions.some((d) => d.exploratory)).toBe(false);
  });
});

describe('folding outcomes into state', () => {
  const observation = (over: Partial<AdaptiveObservation> = {}): AdaptiveObservation => ({
    at: 1_000,
    context: CONTEXT,
    strategyId: 'xray',
    ok: true,
    timeToWorkingMs: 2_000,
    failureKind: null,
    reasonCode: null,
    ...over,
  });

  it('counts successes, times them, and clears the failure streak', () => {
    const state = applyObservation(
      stateWith([{ strategyId: 'xray', successes: 3, failures: 0, consecutiveFailures: 2, meanSuccessMs: 4_000, updatedAt: 1_000 }], 1_000),
      observation({ at: 2_000, timeToWorkingMs: 2_000 }),
    );

    const entry = state.entries.find((e) => e.strategyId === 'xray')!;
    // The pre-existing count is decayed to the observation's timestamp first, so
    // a one-second-old entry lands at 4 minus an unmeasurably small amount.
    expect(entry.stats.successes).toBeCloseTo(4, 4);
    expect(entry.stats.consecutiveFailures).toBe(0);
    // EMA toward the new measurement, not a replacement.
    expect(entry.stats.meanSuccessMs).toBeGreaterThan(2_000);
    expect(entry.stats.meanSuccessMs).toBeLessThan(4_000);
  });

  it('refuses to record a time-to-working-tunnel for a failure', () => {
    const state = applyObservation(
      stateWith([{ strategyId: 'xray', successes: 1, failures: 0, updatedAt: 1_000 }], 1_000),
      observation({ at: 2_000, ok: false, timeToWorkingMs: 9_999, failureKind: 'transport', reasonCode: 'tcp-unreachable' }),
    );

    const entry = state.entries.find((e) => e.strategyId === 'xray')!;
    expect(entry.stats.failures).toBe(1);
    expect(entry.stats.meanSuccessMs).toBeNull();
    expect(entry.stats.consecutiveFailures).toBe(1);
    expect(state.observations).toHaveLength(1);
  });

  it('keeps storage bounded in both directions', () => {
    let state = emptyAdaptiveState(0);
    const options = { maxContexts: 2, maxStrategiesPerContext: 2, maxObservations: 3 };
    for (let i = 0; i < 6; i += 1) {
      for (let s = 0; s < 4; s += 1) {
        state = applyObservation(
          state,
          { at: 1_000 + i * 10, context: `ctx-${i}`, strategyId: `s-${s}`, ok: true, timeToWorkingMs: 100, failureKind: null, reasonCode: null },
          options,
        );
      }
    }

    expect(state.entries.filter((e) => e.context === 'ctx-5')).toHaveLength(2);
    expect(new Set(state.entries.map((e) => e.context)).size).toBeLessThanOrEqual(2);
    expect(state.observations).toHaveLength(3);
    expect(state.observations.at(-1)!.context).toBe('ctx-5');
  });
});

describe('persistence', () => {
  it('round-trips state', () => {
    const now = Date.now();
    const state = stateWith([{ strategyId: 'xray', successes: 4, failures: 1, meanSuccessMs: 900 }], now);
    const parsed = parseAdaptiveState(serializeAdaptiveState(state));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.state.entries).toEqual(state.entries);
  });

  it('degrades to no evidence on garbage rather than throwing', () => {
    for (const raw of [null, 42, 'nope', [], { version: ADAPTIVE_STATE_VERSION }]) {
      const parsed = parseAdaptiveState(raw);
      expect(parsed.state.entries).toEqual([]);
      expect(parsed.state.version).toBe(ADAPTIVE_STATE_VERSION);
    }
  });

  it('refuses state written by an unknown schema version', () => {
    const parsed = parseAdaptiveState({
      version: ADAPTIVE_STATE_VERSION + 1,
      entries: [{ context: CONTEXT, strategyId: 'xray', stats: { successes: 99, failures: 0 } }],
      observations: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.state.entries).toEqual([]);
    expect(parsed.warnings.join(' ')).toMatch(/version/);
  });

  it('drops malformed and impossible entries with a warning', () => {
    const parsed = parseAdaptiveState({
      version: ADAPTIVE_STATE_VERSION,
      entries: [
        { context: CONTEXT, strategyId: 'xray', stats: { successes: -5, failures: 0, updatedAt: 1 } },
        { context: 7, strategyId: 'x', stats: {} },
        { context: CONTEXT, strategyId: 'v2ray', stats: { successes: 2, failures: 1, updatedAt: 1 } },
      ],
      observations: [{ at: 1, context: CONTEXT, strategyId: 'v2ray', ok: true }],
      createdAt: 1,
      updatedAt: 1,
    });

    expect(parsed.state.entries.map((e) => e.strategyId)).toEqual(['v2ray']);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('diagnostics summary', () => {
  it('reports decayed counts, probability and confidence per pair', () => {
    const now = Date.now();
    const state = stateWith(
      [
        { strategyId: 'xray', successes: 7, failures: 1, meanSuccessMs: 1_200, updatedAt: now },
        { strategyId: 'v2ray', successes: 1, failures: 0, updatedAt: now - 5_000 },
      ],
      now,
    );

    const rows = summarizeState(state, now);

    expect(rows[0]!.strategyId).toBe('xray');
    expect(rows[0]!.confidence).toBe('medium');
    expect(rows[0]!.successProbability).toBeCloseTo(8 / 10, 5);
    expect(rows[0]!.contextSummary).toContain('balanced profile');
    expect(rows[1]!.confidence).toBe('low');
  });
});
