# NANI Verified Learning Report

## Pipeline
`learning.rs` + `evidence/{provenance,measurements,validation,telemetry_pipeline}.rs` + `hierarchical.rs` +
`recovery_memory.rs`.

```
OBSERVATION -> VALIDATION -> INVESTIGATION -> VERIFICATION -> LEARNING ELIGIBILITY -> PROFILE UPDATE
```

### 1. Observation / validation
`TelemetryQueue` -> normalized measurement. Malformed input is rejected with a reason and counted in
`measurements_rejected`; `IngestOutcome { accepted, state, drift_detected, reason }` makes the decision
explicit instead of dropping data silently.

### 2. Provenance and verification quality
Every measurement carries `Provenance` (e.g. `IndependentlyVerified`) and a `MeasureState`
(`Successful`, `Failed`, `TimedOut`, `Unknown`). Only genuinely observed outcomes map to a Bernoulli
value:

```rust
Successful          -> Some(true)
Failed | TimedOut   -> Some(false)
anything else       -> None   // missing stays missing, never 0
```

### 3. Learning eligibility
- Unverified evidence may update the local child profile through `observe_outcome`.
- `IndependentlyVerified` aggregate evidence updates only the device-level parent
  (`observe_verified_aggregate`) and is **not** also recorded in the active child — otherwise the same
  observation would be counted twice and confidence would inflate.
- `record_user_correction` marks an episode verified and sets `EvidenceQuality::Verified`; it never
  silently promotes an unverified outcome.
- Rejections are counted and the most recent reason is exposed in `LearningStatus.last_rejection`, so a
  learner cannot "learn" from garbage while looking healthy.

### 4. Hierarchical profiles
`HierarchicalBetaBernoulli` (global `(a0, b0)` + per-context/per-API locals, pooling strength `kappa`):
`predict(context, api)` blends a local Beta posterior with the global prior, so an API seen twice is
pulled toward the broader baseline instead of being confidently wrong. `snapshot()` / `from_snapshot()`
provide durable, bounded state.

### 5. Online updating
Beta-Bernoulli conjugate updates are exact, `O(1)` and require no stored history per API. Profiles and
learning state are persisted after each accepted measurement; drift history is bounded by
`record_drift`, so storage cannot grow without limit.

### 6. Duplicate / correlated protection
- The evidence layer applies the correlation discount before an observation counts as independent
  evidence (`evidence/correlation.rs`).
- Verified aggregates are routed to exactly one node (parent), preventing double counting.
- `recovery_memory.rs` tracks `RecoveryOutcome`s so an action is not "learned" twice from the same episode.

### 7. Provenance audit
`evidence/provenance.rs` records where an observation came from, so a profile update can be traced back
to the measurement that caused it.

## Anti-patterns explicitly prevented
| Anti-pattern | Mechanism |
|---|---|
| Learning from malformed data | validation + `IngestOutcome::rejected` with reason |
| Learning from timeouts as measured latency | `MeasureState` distinguishes `TimedOut` from `Failed`; latency is only observed when a value exists |
| Double counting the same observation | verified aggregates update the parent only |
| Correlated evidence inflation | correlation discount before update |
| LLM writing priors | no such path exists; learning is driven by `LearningEngine` methods only |
| Unbounded memory | bounded queues, bounded drift history, conjugate counts instead of raw samples |

## Tests
`learning.rs`: accept/reject paths, missing-value handling (`None` never becomes `false`), drift event
recording, bounded history, persistence round-trip, user-correction verification path.
`hierarchical.rs`: partial pooling (small local sample pulled to global), local convergence with many
samples, snapshot round-trip, invalid parameters rejected.
`recovery_memory.rs`: outcome memory, no duplicate learning for the same episode.

All green: 340 passed; 0 failed.

## Known limitations
- No automatic rollback of an already-applied profile update when a later correction invalidates it;
  corrections mark the episode verified and adjust counts, but a full versioned undo of historical
  updates is not implemented.
- `kappa` pooling strength is fixed per engine instance, not learned.
- No UI breakdown of "which update came from which evidence" beyond `last_rejection` and counts.

## Status
- Implemented: validation, provenance, eligibility gating, hierarchical profiles, online updates,
  correlation discount, bounded storage.
- Tested: yes.
- Benchmarked: not separately; updates are `O(1)` conjugate increments.
- Integrated: `LearningEngine::record_api_probe` is the production path called by the monitor loop;
  `nani_learning_status` / `nani_learning_drift` / `nani_learning_reset` Tauri commands exist.
- Verified: unit + existing desktop flow (Learning tab rendered from these commands in Phase 6).
- Blocked: rollback of historical updates; per-update evidence provenance in the UI.
