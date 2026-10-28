/**
 * Resource cost of the adaptive policy — the measurement behind acceptance
 * criterion 11 ("privacy and resource consumption are measured"), which the
 * evidence report had left as **NOT TESTED** because only the *bound* was
 * structural.
 *
 * This measures the SHIPPED functions (`rankStrategies`, `applyObservation`,
 * `parseAdaptiveState`) at the largest state the shipped policy can hold:
 *
 *   contexts  = DEFAULT_ADAPTIVE_POLICY.maxContexts              32
 *   × strategies per context = maxStrategiesPerContext          12 (only 8 can
 *     exist: 4 engines × 2 DNS modes, so the real ceiling is 8 × 32 = 256)
 *   stored observations = maxObservations                       200
 *
 * Nothing here touches the network: the policy is pure arithmetic, and the
 * engine that calls it makes no network request of its own.
 *
 *   npx tsx scripts/bench-adaptive-cost.ts
 *   npx tsx scripts/bench-adaptive-cost.ts --iterations 50000
 *
 * Prints a table and writes reports/adaptive/ADAPTIVE_COST.json.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  applyObservation,
  contextBucketOf,
  DEFAULT_ADAPTIVE_POLICY,
  emptyAdaptiveState,
  parseAdaptiveState,
  rankStrategies,
  strategyIdFor,
  type AdaptiveContextSignals,
  type AdaptiveObservation,
  type AdaptiveState,
  type AdaptiveStrategy,
  type ProxyEngineId,
  type ScanProfileId,
} from '@netpulse/shared';

const ITERATIONS = (() => {
  const flag = process.argv.indexOf('--iterations');
  const value = flag >= 0 ? Number(process.argv[flag + 1]) : Number(process.env['COST_ITERATIONS'] ?? 20_000);
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : 20_000;
})();

const DAY_MS = 24 * 60 * 60 * 1000;
const ENGINES: ProxyEngineId[] = ['xray', 'hysteria', 'sing-box', 'v2ray'];
const PROFILES: ScanProfileId[] = ['turbo', 'balanced', 'thorough', 'stealth', 'ironclad'];

/** Every strategy the engine's own registry can produce. */
const STRATEGIES: AdaptiveStrategy[] = ENGINES.flatMap((engine) =>
  [false, true].map((dnsThroughTunnel) => ({
    id: strategyIdFor(engine, dnsThroughTunnel),
    engine,
    dnsThroughTunnel,
    label: `${engine}${dnsThroughTunnel ? ' · DNS through tunnel' : ''}`,
  })),
);
const BASELINE_ORDER = STRATEGIES.map((s) => s.id);

/** Every context bucket the 4 boolean signals × profile can produce, capped. */
const ALL_CONTEXTS: string[] = (() => {
  const buckets: string[] = [];
  for (const dnsFailing of [false, true]) {
    for (const tlsFailing of [false, true]) {
      for (const relayWorked of [false, true]) {
        for (const ipv6 of [false, true]) {
          for (const profile of PROFILES) {
            buckets.push(contextBucketOf({ dnsFailing, tlsFailing, relayWorked, ipv6, profile }));
          }
        }
      }
    }
  }
  return buckets;
})();

function observation(at: number, context: string, strategyId: string, ok: boolean): AdaptiveObservation {
  return {
    at,
    context,
    strategyId,
    ok,
    timeToWorkingMs: ok ? 900 + (at % 1500) : null,
    failureKind: ok ? null : 'timeout',
    reasonCode: ok ? null : 'no-exit-ip',
  };
}

/** Drive the state to the policy's cap with realistic, decayed evidence. */
function fillState(now: number): AdaptiveState {
  let state = emptyAdaptiveState(now - 30 * DAY_MS);
  const contexts = ALL_CONTEXTS.slice(0, DEFAULT_ADAPTIVE_POLICY.maxContexts);
  let step = 0;
  for (const context of contexts) {
    for (const strategy of STRATEGIES) {
      // 6 observations per pair: just past `minSamples`, so the trusted path is
      // the measured one, with one failure so a cooling check is exercised too.
      for (let k = 0; k < 6; k += 1) {
        step += 1;
        const at = now - Math.round((step / (contexts.length * STRATEGIES.length * 6)) * 2 * DAY_MS);
        const ok = !(k === 5 && step % 3 === 0);
        state = applyObservation(state, observation(at, context, strategy.id, ok));
      }
    }
  }
  return state;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function summarize(samples: number[]): { p50Us: number; p95Us: number; maxUs: number; meanUs: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  return {
    p50Us: Number(percentile(sorted, 50).toFixed(2)),
    p95Us: Number(percentile(sorted, 95).toFixed(2)),
    maxUs: Number(sorted[sorted.length - 1]?.toFixed(2) ?? 0),
    meanUs: Number(mean.toFixed(2)),
  };
}

/** hrtime is nanoseconds: convert once, as a float, to microseconds. */
const sinceUs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1000;

/** Bytes of heap that survive a collection, when the runtime allows one. */
const gc: (() => void) | null = typeof (globalThis as { gc?: () => void }).gc === 'function' ? (globalThis as { gc: () => void }).gc : null;
const retainedHeap = (): number => {
  if (gc) {
    gc();
    gc();
  }
  return process.memoryUsage().heapUsed;
};

/** Consume results so a smart compiler cannot delete the work being timed. */
let sink = 0;

const now = Date.now();
const heapBefore = retainedHeap();
const buildStart = process.hrtime.bigint();
const full = fillState(now);
const buildMs = sinceUs(buildStart) / 1000;
const heapAfterBuild = retainedHeap();

const filledContexts = new Set(full.entries.map((e) => e.context));
const strategiesInContext = full.entries.length / Math.max(1, filledContexts.size);
const serialized = JSON.stringify(full);

// 1. rankStrategies — the call on the connect path.
const rankSamples: number[] = [];
const rankHarness = (): number => {
  const decision = rankStrategies({
    state: full,
    context: ALL_CONTEXTS[7]!,
    strategies: STRATEGIES,
    baselineOrder: BASELINE_ORDER,
    now,
    attemptBudget: 2,
  });
  return decision.length;
};
{
  for (let i = 0; i < 200; i += 1) sink += rankHarness(); // warm-up, not sampled
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t = process.hrtime.bigint();
    sink += rankHarness();
    rankSamples.push(sinceUs(t));
  }
}

// 2. applyObservation — the call after every attempt, at the cap (so pruneState
//    runs its sort on every one of them).
const applySamples: number[] = [];
let state: AdaptiveState = full;
{
  const contexts = ALL_CONTEXTS.slice(0, DEFAULT_ADAPTIVE_POLICY.maxContexts);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const context = contexts[i % contexts.length]!;
    const strategy = STRATEGIES[i % STRATEGIES.length]!;
    const t = process.hrtime.bigint();
    state = applyObservation(state, observation(now - (i % 5_000), context, strategy.id, i % 4 !== 0));
    applySamples.push(sinceUs(t));
  }
  sink += state.entries.length;
}

// 3. parseAdaptiveState — the startup path, on the largest stored blob.
const parseSamples: number[] = [];
{
  // The real startup path: the store hands back a decoded object, so the cost is
  // JSON.parse of the stored blob PLUS parseAdaptiveState's validation.
  const decode = (): number => parseAdaptiveState(JSON.parse(serialized) as Record<string, unknown>).state.entries.length;
  for (let i = 0; i < 200; i += 1) sink += decode(); // warm-up
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t = process.hrtime.bigint();
    sink += decode();
    parseSamples.push(sinceUs(t));
  }
}

// 4. Growth: bytes a single new observation adds to the persisted blob, both
//    while below the entry cap and once at it.
const oneMore = applyObservation(full, observation(now, ALL_CONTEXTS[0]!, STRATEGIES[0]!.id, true));
const bytesAtCap = Buffer.byteLength(serialized, 'utf8');
const bytesAfterOne = Buffer.byteLength(JSON.stringify(oneMore), 'utf8');
const heapDelta = heapAfterBuild - heapBefore;
const stateAfterRun = state;

const report = {
  generatedAt: new Date().toISOString(),
  iterations: ITERATIONS,
  policyBounds: {
    maxContexts: DEFAULT_ADAPTIVE_POLICY.maxContexts,
    maxStrategiesPerContext: DEFAULT_ADAPTIVE_POLICY.maxStrategiesPerContext,
    maxObservations: DEFAULT_ADAPTIVE_POLICY.maxObservations,
    halfLifeMs: DEFAULT_ADAPTIVE_POLICY.halfLifeMs,
    minSamples: DEFAULT_ADAPTIVE_POLICY.minSamples,
  },
  state: {
    entries: full.entries.length,
    contexts: filledContexts.size,
    strategiesPerContext: strategiesInContext,
    strategiesInRegistry: STRATEGIES.length,
    observationsStored: full.observations.length,
    contextsAvailableInSignals: ALL_CONTEXTS.length,
    entriesAfterRun: stateAfterRun.entries.length,
    observationsAfterRun: stateAfterRun.observations.length,
    serializedBytes: bytesAtCap,
    bytesPerEntry: Number((bytesAtCap / Math.max(1, full.entries.length)).toFixed(1)),
    serializedBytesAfterOneMoreObservation: bytesAfterOne,
    bytesAddedByOneObservation: bytesAfterOne - bytesAtCap,
  },
  buildMs: Number(buildMs.toFixed(1)),
  rankStrategies: summarize(rankSamples),
  applyObservation: summarize(applySamples),
  parseAdaptiveState: summarize(parseSamples),
  heap: {
    measuredWithForcedGc: gc != null,
    deltaBytesAfterBuildingMaxState: heapDelta,
    deltaPerEntryBytes: Number((heapDelta / Math.max(1, full.entries.length)).toFixed(1)),
  },
  warmup: 'excluded from the samples',
  sink,
};

const p = (n: number): string => n.toFixed(2);
process.stdout.write('\nadaptive policy cost · shipped functions, maximum stored state\n');
process.stdout.write(
  `  state        ${report.state.entries} entries (${report.state.contexts} contexts × ${report.state.strategiesPerContext} strategies)` +
    ` · ${report.state.observationsStored} stored observations · ${report.state.serializedBytes} B persisted\n`,
);
process.stdout.write(
  `  registry     ${STRATEGIES.length} strategies (4 engines × 2 DNS modes) — the policy's 12/context cap is above what can exist\n`,
);
process.stdout.write(`  iterations   ${ITERATIONS.toLocaleString('en-US')} per function\n\n`);
const rows: Array<[string, string]> = [
  ['rankStrategies (connect path)', `p50 ${p(report.rankStrategies.p50Us)} µs · p95 ${p(report.rankStrategies.p95Us)} µs · max ${p(report.rankStrategies.maxUs)} µs`],
  ['applyObservation (per attempt)', `p50 ${p(report.applyObservation.p50Us)} µs · p95 ${p(report.applyObservation.p95Us)} µs · max ${p(report.applyObservation.maxUs)} µs`],
  ['state decode at startup', `p50 ${p(report.parseAdaptiveState.p50Us)} µs · p95 ${p(report.parseAdaptiveState.p95Us)} µs · max ${p(report.parseAdaptiveState.maxUs)} µs (JSON.parse of the stored blob + parseAdaptiveState)`],
  ['state built from empty', `${report.buildMs} ms for ${report.state.entries} entries (test setup, not a runtime path)`],
  [
    gc ? 'heap retained by max state' : 'heap high-water, no forced GC available',
    `${(heapDelta / 1024).toFixed(1)} KiB (${report.heap.deltaPerEntryBytes} B/entry)`,
  ],
  ['persisted blob', `${report.state.serializedBytes} B at the cap; +${report.state.bytesAddedByOneObservation} B per observation while at the cap (the whole row is rewritten each attempt)`],
  ['network calls by the policy', '0 — the module imports nothing that can dial; the engine calls it locally'],
];
const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value] of rows) process.stdout.write(`  ${label.padEnd(width)}  ${value}\n`);
process.stdout.write('\n');

const out = process.env['OUT'] ?? path.join('reports', 'adaptive', 'ADAPTIVE_COST.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`  evidence written to ${out}\n\n`);
