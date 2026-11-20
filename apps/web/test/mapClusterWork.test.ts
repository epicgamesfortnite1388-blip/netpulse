import { describe, expect, it } from 'vitest';

import { clusterNodes } from '../src/features/map/clusterNodes';

import type { GlobeNode } from '../src/features/map/mapEncoding';

/**
 * Deterministic work envelope for the clustering pipeline.
 *
 * ## Why this file exists
 *
 * This replaces three wall-clock assertions (`<100ms`, `<25ms`, `<10ms`) that
 * failed on a correct implementation whenever the machine was busy. A test that
 * measures elapsed milliseconds measures the scheduler as much as the code: a
 * concurrent `vite build` or a headless browser competing for cores can push a
 * 6ms call past 100ms without a single line of the algorithm changing. The
 * result was a suite that reported a real failure on correct code, which trains
 * everyone to re-run until green — the worst possible outcome for a suite whose
 * job is to catch regressions.
 *
 * What actually matters about this pipeline is not "how many milliseconds on
 * this machine today" but "how does the work grow with the number of nodes".
 * The map renders every node it is given, so the failure mode that would hurt a
 * user is an accidental O(n²) — a nested loop over the node list that is
 * invisible at 50 nodes and unusable at 5,000.
 *
 * So the property is measured directly: count the property reads the algorithm
 * performs on its input, and assert that the count grows linearly. That number
 * is a deterministic function of the code and the input size. It does not depend
 * on CPU speed, on how many other processes are running, or on when the garbage
 * collector last ran.
 *
 * The wall-clock measurement still exists, with warm-up, repeated samples and a
 * recorded baseline, in `mapClusterPerf.test.ts`. It is opt-in because a
 * performance measurement and a correctness gate have different requirements:
 * one needs a quiet machine and statistical treatment, the other needs to be
 * trustworthy on a busy one.
 */

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

/**
 * Nodes whose property reads are counted.
 *
 * The counter wraps each node rather than the array: the algorithm iterates with
 * `for…of`, which reaches the array's own iterator and would bypass an array
 * Proxy, but every iteration still reads properties off the node itself.
 */
function instrumented(count: number): { nodes: GlobeNode[]; reads: () => number } {
  let reads = 0;
  const nodes = makeNodes(count).map(
    (node) =>
      new Proxy(node, {
        get(target, prop) {
          reads += 1;
          // Deliberately not forwarding the receiver: forwarding it back into
          // the proxy would re-enter this trap for the same property.
          return Reflect.get(target, prop);
        },
      }) as GlobeNode,
  );
  return { nodes, reads: () => reads };
}

/**
 * Total counted operations for one clustering pass: node property reads plus
 * entries yielded by iterating a Map.
 *
 * Both halves are needed. Node reads alone catch a blow-up in the per-node
 * constant, but they are blind to the failure that actually matters here: a
 * lookup that scans the bin table instead of indexing it. That defect adds no
 * node reads at all — it adds map iteration — so a counter that only watched
 * the nodes would report the quadratic version as perfectly linear. (It did,
 * which is why this counter was widened: the first version of this file passed
 * against a deliberately quadratic implementation.)
 *
 * Map iteration is counted by wrapping `Map.prototype[Symbol.iterator]` for the
 * duration of the synchronous call and restoring it in `finally`. The call is
 * synchronous and single-threaded, so nothing else can observe the patch.
 */
function opsFor(count: number, zoom: number): number {
  const { nodes, reads } = instrumented(count);
  let iterated = 0;
  const realIterator = Map.prototype[Symbol.iterator];

  Map.prototype[Symbol.iterator] = function countingIterator(this: Map<unknown, unknown>) {
    const inner = realIterator.call(this) as Iterator<[unknown, unknown]>;
    const wrapper: Iterator<[unknown, unknown]> = {
      next() {
        const step = inner.next();
        if (!step.done) iterated += 1;
        return step;
      },
      [Symbol.iterator]() {
        return wrapper;
      },
    };
    return wrapper;
  };

  try {
    clusterNodes(nodes, zoom);
  } finally {
    Map.prototype[Symbol.iterator] = realIterator;
  }

  return reads() + iterated;
}

describe('clustering work envelope', () => {
  it('clusters a realistic 5,000-node map into fewer markers', () => {
    // The product requirement behind the old 100ms budget: a big map must
    // actually collapse, not render 5,000 overlapping pins.
    const out = clusterNodes(makeNodes(5000), 1.2);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(5000);
  });

  it('leaves every node addressable at close zoom', () => {
    const nodes = makeNodes(5000);
    const out = clusterNodes(nodes, 6);
    expect(out.length).toBe(5000);
    // Close zoom is a passthrough, and returning the same array is the cheapest
    // correct answer — upstream memoizes on reference identity.
    expect(out).toBe(nodes);
  });

  it('bounds the work spent per node', () => {
    const n = 2000;
    const perNode = opsFor(n, 1.2) / n;
    // Generous on purpose: the point is to catch an order-of-magnitude change,
    // not to freeze the current constant. A nested loop over the node list
    // would put this in the thousands.
    expect(perNode).toBeLessThan(40);
  });

  it('grows linearly, not quadratically, with node count', () => {
    // Warm the JIT so the counters measure the algorithm rather than first-call
    // compilation. This does not affect correctness of the count — the count is
    // identical either way — but it keeps the numbers stable if a future
    // implementation becomes lazily compiled.
    opsFor(250, 1.2);

    const base = opsFor(500, 1.2);
    const twice = opsFor(1000, 1.2);
    const fourTimes = opsFor(2000, 1.2);

    expect(base).toBeGreaterThan(0);

    // Doubling the input roughly doubles the work. The window is wide enough to
    // absorb constant-factor differences (the cluster object is built from a
    // fixed number of reads per member) but far too narrow to admit O(n²),
    // which would land near 4x on the first step.
    const step1 = twice / base;
    expect(step1).toBeGreaterThan(1.5);
    expect(step1).toBeLessThan(2.6);

    const step2 = fourTimes / twice;
    expect(step2).toBeGreaterThan(1.5);
    expect(step2).toBeLessThan(2.6);

    // And the whole 4x growth stays linear overall.
    const overall = fourTimes / base;
    expect(overall).toBeGreaterThan(3.0);
    expect(overall).toBeLessThan(5.5);
  });

  it('spends no work at all when clustering is a passthrough', () => {
    // Close zoom returns before touching any node. If a future change moved the
    // early return below the binning loop, this is where it would show up.
    const { nodes, reads } = instrumented(1000);
    clusterNodes(nodes, 6);
    expect(reads()).toBe(0);
  });

  it('scales to an empty and a single-node map without special-casing', () => {
    expect(clusterNodes([], 1.2)).toEqual([]);
    expect(clusterNodes(makeNodes(1), 1.2)).toHaveLength(1);
  });
});
