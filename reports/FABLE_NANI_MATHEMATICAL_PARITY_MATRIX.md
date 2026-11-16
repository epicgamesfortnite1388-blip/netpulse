# FABLE — NANI Mathematical Parity Matrix

Mandatory preservation constraint: **FABLE-MATH-003** — no mathematical capability may disappear silently during consolidation. Inventory basis: all exported symbols in `packages/shared/src/nani/*.ts` (2,419 LOC, 11 files) mapped against `src-tauri/src/network_intelligence/*.rs` (19,315 LOC, 364 tests). Verified by source comparison 2026-11-16 (both trees current).

Disposition codes: **R** = preserve in Rust (authoritative), **TS** = retain in TypeScript with justified application-layer reason, **EQ** = replace with equivalent (parity test required), **DEL** = remove (demonstrably unused or incorrect).

## 1. Bayesian diagnosis

| Capability | Rust implementation | TS implementation | Target owner | Parity test |
|---|---|---|---|---|
| Uniform prior | `Prior::uniform` (bayesian.rs:41) | `uniformPrior()` (diagnosis.ts:48) | R | Equal posteriors from identical evidence streams |
| Prior from probabilities + normalization | `Prior::from_probs` + `normalize_weights` | `normalize()` (diagnosis.ts:56) | R | Extreme-probability inputs (1e-300, 0, 1) both sides |
| Log-space accumulation | `add_evidence` (log domain) | `updatePosterior` (log domain, diagnosis.ts:142) | R | Equivalent inputs → equivalent outputs, rel diff < 1e-9 |
| Dynamic transition kernel | `TransitionModel::log_transition` + time-scaled predict step (diagnosis.rs:492,575-601) | `transition()` mean-reverting ε kernel (diagnosis.ts:78) | R | **Time-scaling test**: identical observation gaps → identical decay; ε=0 static, ε=1 full-forget |
| Evidence freshness weighting | `decay_log_likelihood` exp(−λ·age) | reliability weight `0.5^(age/halfLife)` (header) | R | Both halve influence at their half-life; document λ↔half-life equivalence |
| Evidence reliability weighting | `ll * confidence` (bayesian.rs:205) | tempered toward uniform by weight | R (after T-04 noise model) | Low-confidence moves posterior less; identical test both sides |
| Missing/skipped/unknown evidence excluded | NaN→no-evidence; -inf preserved | `isInformative()` excludes skipped/unknown (diagnosis.ts:41) | R | "not tested" ≠ "tested and failed" in both |
| Conflicting evidence (same probe → different hypotheses) | dedupe by (source,hypothesis) | per-hypothesis likelihood tables | R | Dedup regression test (the historical DNS bug) |
| MAP + entropy + ranked posteriors | `map/entropy/ranked` | `entropyOf`, ranked in `diagnose` | R | Same distribution → same entropy |
| Expected information gain | `expected_information_gain` + cloning oracle (diagnosis.rs:776) | `expectedInformationGain` (diagnosis.ts:217) | R | Cross-oracle: TS result vs Rust result on shared fixture |
| Next-test selection by IG/cost | `rank_tests`/`select_best_diagnostic_probe` | `selectNextTest` (diagnosis.ts:266) | R | Same test set → same choice; cost tie-breaks identical |
| 12-hypothesis taxonomy | `Hypothesis::all()` | `NETWORK_HYPOTHESES` + `DEFAULT_TESTS` (defaultTests.ts:61) | R (code), **TS (data source for web display)** | Taxonomy fixture equality |
| Probe outcome enumeration (6 outcomes incl. AuthRejected/RateLimited/ServerError) | `ProbeOutcome` enum | ProbeOutcome type ('success','failure','timeout','skipped','unknown') | R | **DIVERGENCE**: TS outcome set is 5, Rust 6 — Rust is superset; TS display maps subset. Record in T-06. |

## 2. Probability & numerics

| Capability | Rust | TS | Target | Parity test |
|---|---|---|---|---|
| sigmoid / logit | `sigmoid`, `logit` (math.rs) | `sigmoid` (decision.ts:25) | R | Extreme z (±40) no overflow |
| Log-sum-exp / softmax | `log_sum_exp`, `softmax` | inline in updatePosterior | R | -1e300 inputs; underflow case (the b0311fb fix) |
| JS/KL divergence | `kl_divergence`, `js_divergence` | — | R | Only Rust-side consumers; keep |
| Beta-Bernoulli (update, predictive, credible width) | `probability.rs` | — | R | Wilson 5/10 published value test |
| Beta/Gamma/Normal samplers | `probability.rs` (rand) | `mulberry32`/`randn` (decision.ts:35,47) | R | Moment tests exist; TS rng only feeds simulation — TS retains rng for browser tests only |
| Bayesian logistic route scoring | `route.rs` metrics | `BayesianLogistic` class (decision.ts:76) | **R** (math), TS keeps feature plumbing | Route fixture: same features → same ranking |
| Robust stats (median/percentile) | `robust_stats.rs` | `stats.ts` median/percentile | **both**, different consumers: TS `stats.ts` feeds UI latency display (justify TS); Rust feeds diagnosis | Percentile interpolation fixture |
| Normalizers (latency/loss/score) | `clamp_latency` etc. | `NORMALIZERS` (decision.ts:233) | R | Monotonicity + range tests |
| Latency CVaR (α=0.95) | — | `latencyCvar` (decision.ts:252) | **EQ → port to Rust before any TS deletion** | CVaR fixture; tail-sensitivity test |

## 3. Drift / changepoint / learning

| Capability | Rust | TS | Target | Parity test |
|---|---|---|---|---|
| Page-Hinkley | `changepoint.rs` | `PageHinkley` class (drift.ts:42) | R | Same stream → same alarm points |
| CUSUM | `changepoint.rs` | `Cusum` class (drift.ts:96) | R | Same |
| Verified-only learning updates | `learning.rs` (`observe_verified_aggregate`, verified flags) | — | R | Unverified input rejected (existing tests) |
| Calibration: Brier/log-loss/ECE/reliability bins+diagrams | `evaluation.rs` | `metrics.ts` (brierScore, logLoss, ECE, reliabilityDiagram*, by-class/by-network/destination) | **R core**; TS `metrics.ts` may remain for **UI rendering of diagrams** (application-layer: presentation of data Rust produces) — but the *numbers* must come from Rust | Brier fixture equality; diagram bins from Rust data |
| Latency summary (p50/p95/p99) | robust_stats | `summarizeLatency` (metrics.ts:108) | R compute / TS display | Fixture |
| Binary classification metrics | evaluation.rs | `binaryClassification` (metrics.ts:124) | R | Fixture |

## 4. Health / recovery / registry (application logic, not math)

| Capability | Rust | TS | Target | Disposition |
|---|---|---|---|---|
| API failure classification | `failure_classifier.rs` | `classifyApiFailure`/`assessApiHealth` (apiHealth.ts:98,142) | R authoritative; TS maps to display labels | Golden fixture both sides (T-06) |
| Retry policy + delay computation | recovery.rs (Rust-side) | `RetryPolicy`/`retryDelayMs` (apiHealth.ts:193) | **TS retained**: used by the API's own HTTP calls (application layer, not NANI math) | Keep; document boundary |
| Circuit breaker state machine | recovery/circuit logic in naniService | `CircuitBreaker` class (apiHealth.ts:241) | TS retained (it guards the Node sidecar's own upstream calls — application layer) | Keep with tests |
| Recovery planning + controller | `recovery.rs`, `recovery_memory.rs` | `planRecovery`/`RecoveryController` (recovery.ts:48,114) | R authoritative for desktop; TS retained for web-mode NANI only (until parity test exists) | Recovery fixture equality |
| Registry data structures | `api_intelligence/registry.rs` | `registry.ts` (incl. `computeDependencyGraph`, `authorizedRoutes`) | Desktop: R. Web: TS retained. | Dependency-graph fixture |
| Event contracts/types | `events/` (Rust) + `naniEvents.ts` (webview) | `events.ts` (types + version const) | **TS (contract data)** — genuinely application layer | Version const equality with Rust |
| Deterministic simulator (15 conditions) | `simulation.rs` | `packages/shared/test/nani.simulation.test.ts` sim | Both test-only | Keep both gated to tests |
| Route constraints/filter/rank | `route.rs` | `filterCandidates`/`selectRoute`/`rankByCost`/`routeCost` (decision.ts) | R for diagnosis-path; TS retained for API route selection UI (application layer) | Fixture equality on shared features |

## 5. Divergences that REQUIRE explicit disposition before any TS deletion

1. **CVaR (`latencyCvar`) exists only in TS** → port to Rust (`EQ`), parity test, then TS keeps only a display call. Do not delete first.
2. **Probe-outcome superset**: Rust has 6 outcomes incl. AuthRejected/RateLimited/ServerError; TS has 5 → TS cannot represent those outcomes; any consumer that needs them must consume Rust output. Document in T-06.
3. **Reliability diagram by network/destination** (metrics.ts:205) — TS-only grouping for UI; Rust produces the underlying numbers → TS retained as presentation, numbers sourced from Rust after T-05.
4. **Half-life vs λ decay parameterization** differs (0.5^(age/halfLife) vs exp(−λ·age)) — mathematically equivalent families; T-04 must fix ONE canonical parameterization in Rust and document the conversion (λ = ln2/halfLife).

## 6. Mandatory test set before deleting any redundant TS code

1. **Cross-oracle fixture test**: a shared JSON fixture of (prior, evidence sequence with gaps and confidences, transition params) run through BOTH implementations; outputs equal within 1e-9 relative (Rust generates the golden file).
2. **Extreme-probability stability**: priors at {1e-300, 0.5, 1-1e-16}, likelihoods at 0 and ±inf → no NaN/inf leakage in either.
3. **Time-scaled transition**: two observation schedules (short/long gap) → decay ratio matches λ·Δt in Rust and ε-kernel in TS pre-consolidation.
4. **Missing-evidence exclusion**: skipped/unknown observations change NOTHING (bitwise) in the posterior.
5. **Conflicting/duplicate evidence**: same source repeated → counted once per hypothesis.
6. **Insufficient-evidence refusal**: below min-sample thresholds, no posterior claim is emitted.
7. **Correlated observations**: DNS+TCP failing together must not double-boost the DNS hypothesis beyond the single-evidence bound (correlation guard test).
8. **Verified-only learning**: feeding an unverified outcome leaves profiles unchanged.
9. **Regression against existing Rust behavior**: the full existing 364-test Rust suite is the floor; TS deletions may not change any Rust test.

Acceptance rule (T-05/T-06): line count is irrelevant; consolidation is complete when every row above has target owner R (or justified TS) **and** the cross-oracle fixture passes with both implementations on the same inputs.
