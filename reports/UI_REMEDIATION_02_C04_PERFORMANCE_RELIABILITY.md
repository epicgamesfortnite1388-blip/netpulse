# UI_REMEDIATION_02 — C-04: Performance Test Reliability

**Finding:** the wall-clock performance test fails intermittently on correct code.
**Verdict:** **resolved.** The suite now passes identically idle and under load, and a
genuine performance measurement is still kept.

---

## 1 What the original test actually measured

`apps/web/test/mapClusterPerf.test.ts` asserted three absolute millisecond budgets:

| Test | Assertion | Input |
|---|---|---|
| far zoom | `clusters 5,000 nodes in under 100ms` | 5,000 nodes, zoom 1.2 |
| mid zoom | `clusters 1,000 nodes in under 25ms` | 1,000 nodes, zoom 2.5 |
| close zoom | `close zoom is effectively free even at 5,000 nodes` | 5,000 nodes, zoom 6, `<10ms` |

`performance.now()` around a single call. No warm-up, no repetition, no environment
record, no baseline, no statistical treatment.

## 2 What the code actually costs

Measured with warm-up, 21 samples and batching to beat the timer resolution
(`NP_PERF=1 npx vitest run test/mapClusterPerf.test.ts`):

```
[perf] far-5000   median=  1.138ms  p95=  1.3953ms  min=  0.9467ms
[perf] mid-1000   median=  0.3118ms p95=  0.3828ms  min=  0.2555ms
[perf] close-5000 median=       0ms (passthrough)
```

So the budgets carried **~88× and ~80× headroom** over the observed cost. A test that
passes by two orders of magnitude is not measuring performance; it is measuring whether
the machine is catastrophically broken. Yet it still failed, because the thing it
actually measured was scheduling noise on a shared machine.

## 3 The more serious defect: two of the three tests measured nothing

`clusterCellDeg(zoom)` returns `0.5` for any `zoom >= 2.2`, and `clusterNodes` returns
the input untouched when the cell is `<= 1.2`:

```ts
const cell = clusterCellDeg(zoom);
if (cell <= 1.2) return nodes; // close zoom: no clustering at all
```

Both the "mid zoom" (2.5) and "close zoom" (6) tests therefore exercised an early
return. They were timing a function that did no work. Neither could have caught a
clustering regression at any input size — the property in their names was not the
property they tested. This is the same class of defect as K-01, and it survived because
a green result looked like a passing test.

The rewritten scenarios cluster for real (`zoom 1.8` → cell 2.47°), and the passthrough
case is kept but marked `passthrough: true` so it is not compared against a clustering
baseline.

## 4 Why the test failed on correct code

A wall-clock assertion measures the product of the algorithm and the machine. Under a
concurrent `vite build` and a headless Chromium capture, the scheduler, GC and cache
pressure all move a 1.1ms call. Observed during this mission: a run reported
`532 (1 failed)`, another `531`, another `517`, against a baseline of `534`. The
correctness of the code did not change between those runs; the load did.

An intermittent failure on correct code is worse than no test. It trains everyone to
re-run until green, which destroys the signal of every *other* test in the suite.

## 5 The fix: separate the two questions

The brief's preferred shape was adopted exactly — a deterministic correctness gate, and
a performance measurement that is run deliberately.

### A. Deterministic correctness — `apps/web/test/mapClusterWork.test.ts`

Part of the default suite. Six tests, **15ms**, no wall clock at all.

The property that matters is not "how many milliseconds today" but **how the work grows
with input size**. The map renders every node it is given, so the failure that would
hurt a user is an accidental O(n²) — invisible at 50 nodes, unusable at 5,000.

Work is counted, not timed:

- every node is wrapped in a `Proxy` whose `get` trap increments a counter;
- `Map.prototype[Symbol.iterator]` is wrapped for the duration of the synchronous call
  and counts yielded entries;
- the total is a deterministic function of the code and the input size.

Both halves are required, and this was discovered by getting it wrong. The first version
counted only node property reads and **passed against a deliberately quadratic
implementation**, because that defect adds no node reads — it adds bin-table iteration.
A counter blind to the data structure reports a quadratic algorithm as perfectly linear.
The widened counter is the one in the file, and the comment records why.

Assertions:

| Test | Property |
|---|---|
| clusters 5,000 nodes into fewer markers | the product requirement — a big map actually collapses |
| leaves every node addressable at close zoom | passthrough returns all 5,000 **and the same array reference** (upstream memoizes on identity) |
| bounds the work spent per node | `< 40` counted operations per node — catches an order-of-magnitude change |
| grows linearly, not quadratically | `ops(2n)/ops(n)` in `1.5…2.6`, twice over, and `ops(4n)/ops(n)` in `3.0…5.5` |
| spends no work when clustering is a passthrough | exactly **0** counted operations at close zoom |
| scales to empty and single-node maps | no special-casing |

### Proof the assertions have teeth

Two defects were injected into `clusterNodes.ts`, the suite run, and the source restored
(verified with `git diff --quiet`, which reported clean).

**Defect 1 — bin lookup replaced by a linear scan** (`for (const [k,v] of bins) if (k===key) …`):

```
× bounds the work spent per node          AssertionError: expected 340.05 to be less than 40
× grows linearly, not quadratically       AssertionError: expected 5.65 to be less than 5.5
```

**Defect 2 — a genuine nested loop over the node list:**

```
× bounds the work spent per node          AssertionError: expected 2013.54 to be less than 40
× grows linearly, not quadratically       AssertionError: expected 3.96 to be less than 2.6
```

Both rejected. The per-node bound is the sharper detector; the growth ratio is the one
that generalises to a defect nobody predicted.

### B. Performance measurement — `apps/web/test/mapClusterPerf.test.ts`

Opt-in, because a measurement and a gate have incompatible requirements: one needs a
quiet machine and statistics, the other must be trustworthy on a busy one.

```
NP_PERF=1 npx vitest run test/mapClusterPerf.test.ts
```

Without the flag the four cases report as **skipped**, not omitted — a default run shows
`4 skipped`, so the measurement is visibly absent rather than silently deleted. This is
the brief's "do not silently skip it", satisfied by making the skip loud.

Methodology:

| Concern | Treatment |
|---|---|
| first-call cost | 8 warm-up passes, discarded |
| timer resolution | batch calibrated so each timed interval exceeds 5ms, then divided by batch size |
| outliers | 21 samples, **median** reported alongside p95 and min |
| machine variance | comparative, not absolute: a recorded baseline and a **3× drift** tolerance |
| environment | node version, platform, core count and load average printed with the numbers |
| sanity | an absolute ceiling far above the observed cost, to catch a structural change |
| workload drift | a run that becomes 3× *faster* prints a warning, because that usually means the workload stopped being the workload |

The baseline is `apps/web/test/perf-baseline.json`:

```json
{
  "far-5000": 1.138,
  "mid-1000": 0.3118
}
```

A baseline of `0` cannot express drift, so a non-positive recorded value is re-recorded
rather than trusted. That case is reachable: before batching was added, the two
sub-millisecond scenarios recorded exactly `0` and would have asserted `0 < 0` on the
next run.

## 6 Verification under load

The decisive check is the one the old test failed. Same command, twice:

| Condition | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Idle | 557 | 553 | **0** | 4 |
| Concurrent `vite build` + headless Chromium capture | 557 | 553 | **0** | 4 |

The concurrent run was real: the build log shows `vite v7.3.7 building client
environment… transforming…` and the capture was mid-run at the same time.

No retries, no threshold inflation, no deletion. The performance test still exists and
still fails when the code is 3× slower than its baseline.

## 7 What is still not covered

- **No CI-side timing gate.** The benchmark is manual. A 3× regression is caught only
  when someone runs it. That is a deliberate trade: a blocking timing gate on shared
  hardware is the defect this mission removed.
- **The baseline is from one machine** (20 cores, win32 10.0.26200, node v22.22.2). On
  materially different hardware the drift tolerance may need re-recording; the printed
  environment line exists so that decision has context.
- **`clusterNodes` is measured, not profiled.** No allocation counts or GC pressure are
  asserted. The brief listed "allocation counts" as one option; operation counts were
  chosen because they are deterministic and allocation measurement in V8 is not.
