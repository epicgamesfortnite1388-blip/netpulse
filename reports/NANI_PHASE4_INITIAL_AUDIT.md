# NANI Phase 4 — Initial Audit (Stage Zero)

**Target:** `E:\Code\Project\Vpn_app`
**Audit date:** 2026-11-14
**Scope:** Actual V3/Phase-3 code and existing Phase-4 scaffolding, not prior report claims.

---

## 1. Method

Inspected and compiled the real tree, then ran the test suite:

```bash
cd E:\Code\Project\Vpn_app\src-tauri
cargo test
cd ..\packages\shared
npx vitest run test/nani.test.ts test/nani.simulation.test.ts
```

Claims below are limited to what the code and tests demonstrate. No benchmark numbers
are asserted here unless a reproducible command produced them.

## 2. What actually exists

### 2.1 TypeScript NANI core (`packages/shared/src/nani/`)
Pure, deterministic, I/O-free: hypothesis posterior updates, information-gain test
selection, API failure classification, route scoring, recovery planning, drift
primitives, calibration metrics. It is consumed by `apps/api/src/services/naniService.ts`
and exposed through the live `/api/v1/nani/*` routes.

### 2.2 Rust control plane (`src-tauri/src/network_intelligence/`)
The V3 engine (diagnosis, bayesian, probability, drift, recovery, causal, simulation,
evaluation, bandit, route, API registry/monitor) is real and covered by unit tests.

Phase-4 scaffolding also exists:

| Module | State before this audit |
|---|---|
| `evidence/measurements.rs` | Typed schema, states, provenance. **Bug:** `set_value` clamped every value to `[0,1]`. |
| `evidence/validation.rs` | Basic validation; unreachable/expired states rejected. |
| `evidence/telemetry_pipeline.rs` | Bounded queue + stages; **bug:** NORMALIZE clamped all values to `[0,1]`. |
| `evidence/correlation.rs` | **Missing.** |
| `context/context_identity.rs`, `network_profiles.rs`, `transitions.rs`, `privacy.rs` | Real implementations with tests. Not wired to any runtime. |
| `hierarchical.rs` | Hierarchical Beta-Bernoulli with partial pooling and tests. Not wired. |
| `robust_stats.rs` | Median/MAD/IQR/quantiles/anomaly score, bounded window. Not wired. |
| `episodes.rs` | Episode schema, quality gates, bounded memory, deletion. Not wired. |
| `causal.rs` | Controlled intervention records + ATE gating. Not wired. |
| `learning.rs` | **Missing.** |
| Local RAG / LLM runtime / LoRA training / adapter registry | **Not implemented.** |
| Persistence for Phase-4 state | `PersistenceStore` exists but is assigned and never read/written by any workflow. |

## 3. Gap table

| Subsystem | Existing implementation | Evidence | Missing capabilities | Required work |
|---|---|---|---|---|
| Measurements | Typed Rust schema + states | `cargo test` unit tests | Unit-aware normalization; no runtime feed | Fixed in this stage; monitor now feeds it |
| Evidence provenance | `Provenance` enum + validation gate | Unit tests | Correlation-aware aggregation | Added `evidence/correlation.rs` |
| Network profiles | `ProfileStore` partial pooling | Unit tests | Persistence, active-context detection in runtime | Persist later; context API exists |
| Bayesian diagnosis | TS + Rust diagnosis engines | NANI test suite | Conformal sets, abstention policy | Deferred to Stage 5 |
| Dynamic state model | TS DBN, Rust transitions | Unit tests | HMM regime labeling | Deferred |
| Drift detection | CUSUM/Page-Hinkley, robust stats | Unit tests | BOCPD, rolling distribution comparison | Partial |
| Causal evaluation | `CausalTracker` ATE gating | Unit tests | Intervention lifecycle integration | Deferred |
| Configuration prediction | Gatherer + scoring (Abystral) | Not in this repo’s tests | Survival analysis, calibrated reliability | Deferred |
| Adaptive scheduling | Info-gain selection (TS) | `nani.test.ts` | EVSI with cost/risk in runtime | Deferred |
| Local memory | `EpisodeMemory` | Unit tests | Persistence, retrieval ranking, export | Deferred |
| RAG | None | — | Entire pipeline | Deferred |
| Local inference | None | — | Runtime, model management | Deferred |
| LoRA training | None | — | Dataset curation, training, evaluation gate | Deferred |
| Model evaluation | Offline metrics modules | Unit tests | Adapter evaluation harness | Deferred |

## 4. Defects found and fixed

1. **Value corruption (critical):** every observed value was clamped to `[0,1]` in
   `Measurement::set_value` and again in the NORMALIZE stage. A measured 850 ms latency
   was stored as 1.0 and would train every downstream model on corrupted data.
   Fixed with finite-value handling and unit-aware normalization (only ratio/probability
   units are clamped). Regression tests added.
2. **Misleading validation error:** the VALIDATE stage returned `MissingId` for every
   failure. It now returns the actual `ValidationError` message.
3. **Orphaned Phase-4 modules:** profiles, hierarchical reliability, episodes, robust
   stats and drift had no production caller. Added `learning.rs` and wired it into
   `MonitorLoop`, so every live API probe now feeds the local models.
4. **Broken test compilation in `graph.rs` and `config_intelligence.rs`** (pre-existing
   user changes) prevented the suite from compiling. Fixed without changing behavior.

## 5. Status after this stage

- Implemented: measurement fix, correlation model, learning engine, live monitor wiring,
  Tauri status/drift/reset commands.
- Tested: Rust unit tests for every changed module (see `NANI_PHASE4_EVIDENCE_FOUNDATION.md`).
- Verified: `cargo test` (see final verification), TypeScript typecheck unchanged.
- Benchmarked: no Phase-4 benchmark yet; no comparative claim is made.
- Deployed: not deployed.
- Deferred: persistence, RAG, LLM runtime, LoRA training, federated research, UI.
- Blocked: none.

## 6. Honest conclusion

The V3 mathematics are real and tested. The Phase-4 scaffolding was largely disconnected
from the running product. This stage repairs the corrupted-value foundation, adds the
missing correlated-evidence model, and makes local learning an actual consumer of live
probe outcomes. Later stages must add persistence, uncertainty/abstention, causal
integration, predictive configuration models, memory/RAG, and optional LLM adaptation.
