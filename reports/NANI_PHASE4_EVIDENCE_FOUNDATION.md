# NANI Phase 4 — Evidence Foundation (Stage One)

**Date:** 2026-11-14
**Status:** Implemented, unit-tested, integrated into the live API monitor loop.
**Not deployed. Not benchmarked.**

---

## 1. What was wrong before

The scaffolded foundation had two defects that made every downstream model learn from
corrupted values:

1. `Measurement::set_value` called `clamp_probability`, so a measured **850 ms** latency
   was stored as **1.0**.
2. The telemetry `NORMALIZE` stage clamped *every* observed value into `[0, 1]`, again
   destroying milliseconds, bytes, Mbps and counts.

It also had no model for correlated observations, so a DNS timeout, TCP timeout and HTTP
timeout could each multiply the same hypothesis likelihood.

## 2. Changes in this stage

### 2.1 Measurement schema (`evidence/measurements.rs`)
- `set_value` now accepts any finite value and stores it unchanged.
- A non-finite value becomes an explicit `MeasureState::Invalid` with no observed value —
  never zero.
- Unit is now part of normalization; values are no longer assumed to be probabilities.
- Confidence remains clamped to `[0, 1]`.

### 2.2 Telemetry pipeline (`evidence/telemetry_pipeline.rs`)
- `NORMALIZE` is unit-aware:
  - ratio / probability / fraction / % units → clamped to `[0, 1]`;
  - physical units (ms, Mbps, bytes, counts) → magnitude preserved;
  - negative physical values → marked `Invalid`, not silently absolute-valued;
  - non-finite → `Invalid`.
- `VALIDATE` now returns the actual validation error instead of always `MissingId`.

### 2.3 Correlated evidence (`evidence/correlation.rs`, new)
- Explicit `CorrelationGroup`s: `shared-transport` (TCP/TLS/HTTP/MTU),
  `shared-resolver` (DNS/HTTP/application), `provider-side` (auth/rate-limit/app).
- `CorrelationModel::adjusted_weights` keeps every observation but discounts each later
  member of a correlated cluster by `1 / (1 + preceding correlated count)`.
- Observations are never dropped; only their independent evidentiary weight is reduced.
- Unknown tests are treated as independent.

### 2.4 Learning engine (`learning.rs`, new)
- `LearningEngine` composes the telemetry queue/results store, `ProfileStore`,
  `HierarchicalBetaBernoulli`, `RobustStats`, `EpisodeMemory` and `CorrelationModel`.
- Every measurement is pushed through `COLLECT → VALIDATE → NORMALIZE` before use.
- Successful physical measurements update the per-context profile and robust window.
- Availability measurements update the hierarchical Beta model.
- Drift is recorded only after at least 8 samples and an anomaly score ≥ 4.0
  (`|x − median| / (1.4826·MAD + ε)`).
- User reset deletes per-context profiles, episodes and drift history while retaining a
  conservative global prior.
- User corrections attach to an existing episode **without** changing its evidence
  quality.

### 2.5 Real workflow integration
- `MonitorLoop` now records every live API probe outcome (health + latency) into the
  learning engine after the registry records it. Learning failure can never affect the
  probe result or recovery decision.
- `NaniState` owns the engine; Tauri commands expose status, drift history and reset:
  - `nani_learning_status`
  - `nani_learning_drift`
  - `nani_learning_reset`

### 2.6 Related defects found while testing
- `ConfigIntelligenceEngine` generated ids from the current millisecond only; two
  discoveries in the same millisecond overwrote each other. Now uses a monotonic counter,
  and a regression test asserts two same-millisecond discoveries coexist.
- `PersistenceStore::record_observation` rewrote the entire journal on every record
  (O(n²)); a 10k-record retention test took minutes. It now appends one line and compacts
  every 512 records, with a full-rewrite fallback.
- Persistence tests shared one temp directory across parallel tests; one test deleted
  another's store. Tests now use unique directories.
- Concurrent work added `survival.rs` and `changepoint.rs`; both failed to compile or
  failed their own tests. Repaired without changing their intended public behavior:
  survival probabilities use a plain `[0,1]` clamp (the log-probability floor turned
  `S(t)=1` into `1−1e−12`), and the BOCPD now initializes its run-length distribution
  and uses per-run Gaussian sufficient statistics instead of a constant likelihood.
- Shared NANI tests failed after the hypothesis set grew from 14 to 19: the fixed
  “entropy > 90% of maximum” abstention gate became unreachable for one strong DNS
  observation, and `dns-inconsistency` was given a failure likelihood of 0.9 on a plain
  DNS lookup. The redundant entropy gate was removed (confidence already rejects flat
  posteriors), and the inconsistency prior was corrected to 0.2.

## 3. Verification

```bash
cd E:\Code\Project\Vpn_app\src-tauri
cargo test
# test result: ok. 416 passed; 0 failed; 2 ignored

cd ..\packages\shared
npx vitest run test/nani.test.ts test/nani.simulation.test.ts
# 67 passed (2 files)
npx tsc --noEmit
# no errors
```

The full Rust suite completes in ~1.5 s after the persistence fix. Before it, the
10,100-record retention test alone ran for more than three minutes and had to be
stopped; that is the measured basis for the append/compaction change.

Focused coverage added:

- physical values are not clamped; non-finite invalidates;
- normalize preserves ms, clamps ratio units, rejects negative physical values;
- validate reports the real error;
- correlated weights: independent = full, correlated = 1/2 then 1/3, overlapping groups;
- latency profile keeps 850.0;
- missing measurements are rejected and do not change reliability;
- 200 successes raise the hierarchical prediction; a new API stays near the prior;
- drift requires enough samples and fires on a 5,000 ms spike against a 40 ms baseline;
- reset removes personal state and the engine keeps accepting evidence.

## 4. Limitations (unchanged by this stage)

- Learning state is **in-memory**; it does not survive restart. Persistence is the next
  required step.
- The active network context is the global context (`0`); context detection exists but is
  not yet driven by live interface signals.
- Correlated weights are exposed by the engine but not yet applied inside the Rust
  `DiagnosticEngine` posterior update; that integration belongs to the uncertainty stage.
- No RAG, no local LLM, no adapter training.
- No benchmark comparison yet; no performance claim is made.

## 5. Privacy

The engine stores only numeric summaries, short metric names and a local numeric context
id. It does not store SSIDs, BSSIDs, MAC addresses, private IPs, URLs, headers,
credentials, or payloads. Reset deletes personal learning state.
