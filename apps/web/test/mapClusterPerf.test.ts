import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { clusterNodes } from '../src/features/map/clusterNodes';

import type { GlobeNode } from '../src/features/map/mapEncoding';

/**
 * Performance measurement for the clustering pipeline — run deliberately, not
 * on every commit.
 *
 * ## How to run it
 *
 *     NP_PERF=1 npx vitest run test/mapClusterPerf.test.ts
 *
 * Without `NP_PERF=1` the suite reports these cases as *skipped*, so the default
 * run shows `4 skipped` rather than pretending the measurement does not exist.
 * That is the whole point of the split: a wall-clock assertion and a correctness
 * gate have incompatible requirements. This file needs a quiet machine and
 * statistical treatment; the correctness suite needs to be trustworthy on a
 * busy one. Mixing them produced the worst of both — a green suite that had been
 * re-run until it passed, and a performance signal nobody trusted.
 *
 * ## What it measures
 *
 * The product requirement behind the old budgets: clustering 5,000 nodes must
 * fit inside a user interaction, because the map re-clusters when the camera
 * settles. That is a real requirement and it is still measured here.
 *
 * ## Why the numbers are not absolute
 *
 * An absolute millisecond budget is a statement about one machine on one day. A
 * concurrent build, a headless browser holding four cores, or a thermal-throttled
 * laptop all change it without changing the code. So the measurement is
 * comparative: each scenario records a baseline, and a run fails only when the
 * median moves by a factor that no amount of ambient load explains. The absolute
 * budget survives as a sanity ceiling that is far above the observed cost.
 *
 * Methodology, in order:
 *   - warm-up passes, discarded, so the first-call cost is not in the sample;
 *   - N timed samples of the same workload, with input built outside the timer;
 *   - the median, which ignores both a lucky fast run and an outlier stall;
 *   - a recorded baseline, and a failure only on a multiple of it;
 *   - the environment printed into the report so a surprising number has context.
 */

interface Scenario {
  id: string;
  nodes: number;
  zoom: number;
  /** Sanity ceiling in milliseconds — deliberately far above the observed cost. */
  ceilingMs: number;
  /**
   * True when this zoom returns before clustering any node.
   *
   * `clusterCellDeg` resolves to 0.5 at zoom >= 2.2, which makes `clusterNodes`
   * return the input untouched. Two of the three original wall-clock assertions
   * used zoom 2.5 and zoom 6 — both passthroughs — so they were measuring an
   * early return and could not have caught a clustering regression at all. The
   * scenario is kept because "the early return stays an early return" is worth
   * guarding, but it is marked so it is not compared against a clustering
   * baseline.
   */
  passthrough?: boolean;
  why: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'far-5000', nodes: 5000, zoom: 1.2, ceilingMs: 250, why: 'a large map at the idle view must still cluster into markers' },
  // zoom 1.8 => cell 2.47 degrees: still above the 1.2 degree dissolve
  // threshold, so this genuinely clusters. (The original used 2.5, which does
  // not.)
  { id: 'mid-1000', nodes: 1000, zoom: 1.8, ceilingMs: 80, why: 'the common case: a few hundred to a thousand nodes while panning' },
  { id: 'close-5000', nodes: 5000, zoom: 6, ceilingMs: 0.05, passthrough: true, why: 'close zoom is a passthrough and must stay free' },
];

/** Samples per scenario. Odd, so the median is a real observation. */
const SAMPLES = 21;
const WARMUP = 8;

/**
 * How far the median may drift from the recorded baseline before this fails.
 *
 * Wide on purpose. It has to absorb a shared CI box running four other jobs,
 * while still being far below the order-of-magnitude jump a regression makes.
 * A 3x regression in a hot path is worth waking someone for; a 1.4x wobble on a
 * laptop is not.
 */
const DRIFT_FACTOR = 3;

function makeNodes(count: number): GlobeNode[] {
  const out: GlobeNode[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `n${i}`,
      label: `Node ${i}`,
      lat: ((i * 37) % 180) - 90,
      lon: ((i * 173) % 360) - 180,
      kind: 'target',
      status: 'good',
      latencyMs: 30 + (i % 90),
      geoConfidence: 'medium',
    });
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

/** Target time per timed batch. Below ~5ms the timer's own resolution dominates. */
const BATCH_TARGET_MS = 5;
const MAX_BATCH = 512;

function measure(scenario: Scenario): { medianMs: number; p95Ms: number; minMs: number; batch: number } {
  // Built once and reused: allocating 5,000 objects inside the timer would
  // measure the allocator, not the clustering.
  const nodes = makeNodes(scenario.nodes);

  for (let i = 0; i < WARMUP; i++) clusterNodes(nodes, scenario.zoom);

  // Calibrate a batch size. A single close-zoom passthrough completes in well
  // under the timer's resolution and would record as a flat 0ms — which then
  // makes a recorded baseline of 0 assert `0 < 0` and fail on the next run. Run
  // the workload enough times per sample that the measured interval is real.
  let batch = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) clusterNodes(nodes, scenario.zoom);
    if (performance.now() - t0 >= BATCH_TARGET_MS || batch >= MAX_BATCH) break;
    batch *= 2;
  }

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    for (let i2 = 0; i2 < batch; i2++) clusterNodes(nodes, scenario.zoom);
    samples.push((performance.now() - t0) / batch);
  }

  return {
    medianMs: Number(median(samples).toFixed(4)),
    p95Ms: Number(percentile(samples, 95).toFixed(4)),
    minMs: Number(Math.min(...samples).toFixed(4)),
    batch,
  };
}

/**
 * The baseline lives beside this file.
 *
 * `import.meta.url` is not reliably a `file:` URL under the test runner's
 * transform, so the directory is resolved from the runner's working directory
 * (the package root) with a documented fallback. The resolved path is printed
 * with the measurements so a baseline written somewhere unexpected is obvious
 * rather than silent.
 */
const TEST_DIR = (import.meta as { dirname?: string }).dirname ?? path.join(process.cwd(), 'test');
const BASELINE_PATH = path.join(TEST_DIR, 'perf-baseline.json');

function loadBaseline(): Record<string, number> {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

function saveBaseline(next: Record<string, number>): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

describe.runIf(process.env.NP_PERF === '1')('clustering performance', () => {
  it('reports the environment the numbers came from', () => {
    const env = {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cores: cpus().length,
      loadavg: loadavg().map((n) => Number(n.toFixed(2))),
      samples: SAMPLES,
      warmup: WARMUP,
    };
    // Printed rather than asserted: a surprising median is only interpretable
    // next to the machine that produced it.
    process.stdout.write(`\n[perf] environment ${JSON.stringify(env)}\n`);
    process.stdout.write(`[perf] baseline file ${BASELINE_PATH}\n`);
    expect(env.cores).toBeGreaterThan(0);
  });

  for (const scenario of SCENARIOS) {
    it(`clusters ${scenario.nodes} nodes at zoom ${scenario.zoom} (${scenario.why})`, () => {
      const stats = measure(scenario);
      const baseline = loadBaseline();
      const recorded = baseline[scenario.id];

      process.stdout.write(
        `[perf] ${scenario.id.padEnd(10)} median=${String(stats.medianMs).padStart(8)}ms  p95=${String(stats.p95Ms).padStart(8)}ms  min=${String(stats.minMs).padStart(8)}ms  batch=${String(stats.batch).padStart(4)}  baseline=${recorded ?? 'none'}\n`,
      );

      // Sanity ceiling: a cost so far above the observed one that reaching it
      // means something structural changed, not that the machine was busy.
      expect(stats.medianMs).toBeLessThan(scenario.ceilingMs);

      // A passthrough has no baseline to drift from: the requirement is that it
      // stays effectively free, which the ceiling above already states.
      if (scenario.passthrough) return;

      // A baseline of 0 cannot express drift, so it is re-recorded rather than
      // trusted.
      if (recorded == null || recorded <= 0) {
        baseline[scenario.id] = stats.medianMs;
        saveBaseline(baseline);
        process.stdout.write(`[perf] recorded baseline for ${scenario.id}: ${stats.medianMs}ms\n`);
        return;
      }

      expect(stats.medianMs).toBeLessThan(recorded * DRIFT_FACTOR);

      // A large improvement is also worth knowing about, because it usually
      // means the workload stopped being the workload.
      if (stats.medianMs < recorded / DRIFT_FACTOR) {
        process.stdout.write(
          `[perf] ${scenario.id} is now ${(recorded / stats.medianMs).toFixed(1)}x faster than baseline — confirm the workload still measures what it did\n`,
        );
      }
    });
  }
});
