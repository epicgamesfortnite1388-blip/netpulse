# ULTIMATE NANI AUDIT

**Audit date:** 2026-11-16 · Read-only source audit. **[V]** verified from code · **[A]** analysis · **[?]** assumption.

---

## 1. Verdict

The mathematical libraries are unusually careful and well-tested in isolation, but the **product wiring bypasses much of them**. The advertised 10-stage pipeline is not the implemented lifecycle, the investigation "verification" is unsound, confidence is uncalibrated in production, and two concrete code defects undermined stated behaviour (both fixed this audit). The LLM cannot mutate diagnostic truth (structurally enforced), and NANI works with external AI disabled.

## 2. Pipeline reality vs. claim **[V]**

`run_lifecycle` is `OBSERVE → ANALYZE → VERIFY → COMPLETE` only (`investigation.rs:374-524`). There are no distinct CLASSIFY / HYPOTHESIZE / SELECT PROBES / COLLECT EVIDENCE / UPDATE BELIEFS / EXPLAIN / LEARN stages in that flow. The Bayesian engine is updated **only** by the manual health-check command (`commands/nani.rs:290-304`); the background monitor feeds only `LearningEngine` (`monitor_loop.rs:148-156`).

| Claim | Status | Evidence |
|---|---|---|
| Observations are real, real timestamps | ✅ VERIFIED | `monitor.rs:22-27,43-95,123`; `naniDiagnosticAdapter.ts:187-224` |
| Simulated data never feeds product output | ✅ VERIFIED | simulator callers only tests/eval; `foundation.rs:985-991` no prod caller |
| Failed probe ≠ confirmed failure | ✅ VERIFIED | `diagnosis.rs:107-118`; `measurements.rs:12-29` |
| HTTP auth/rate-limit separated | ✅ VERIFIED | `monitor.rs:248-256`; `api_model.rs:55-63` |
| Correlated probes deduplicated | ✅ VERIFIED | `correlation.rs:114-145` used at `diagnosis.rs:636,666-677` |
| Correlation window resets on long gap | ❌ **was BROKEN → FIXED** | see §5 C2 |
| Confidence calibrated at runtime | ❌ NO | calibrators test-only (`evaluation.rs:246-281`); `commands/nani.rs:408` hardcodes `confidence: None` |
| Information gain drives selection | ✅ desktop/TS core | `diagnosis.rs:770-853`; `packages/shared/src/nani/diagnosis.ts:217-282` |
| Cost-aware selection real | ⚠️ PARTIAL | ranking real; hardcoded IG/cost for API/recovery, no prod caller (`information_theory.rs:256-278`) |
| Causal dependencies represented | ⚠️ PARTIAL | hardcoded groups (`correlation.rs:68-87`); ATE tracker `causal.rs` no prod caller |
| UNKNOWN preserved | ✅ VERIFIED | `diagnosis.rs:38`; `diagnosis.ts:193-205` |
| Learning requires verified outcomes | ❌ NO | `learning.rs:370,320-335` updates from `Provenance::Direct`; only aggregate path requires `IndependentlyVerified`; user correction cannot promote verification (`:403-407`) |
| LLM cannot invent/mutate truth | ✅ (structure) | LLM only rewrites text (`ai/explanation.rs:104-132`); disabled by default |
| NANI works with external AI disabled | ✅ VERIFIED | all math local; deterministic fallback tested (`ai/explanation.rs:157-165`) |

## 3. Critical defects found

**N1 — InterfaceCheck signature was a catch-all binding [V] [FIXED].** `diagnosis.rs:307` matched `LocalInterface => 0.97` where `LocalInterface` is no longer a `Hypothesis` variant; Rust parsed it as an irrefutable binding, so every hypothesis got `P(fail)=0.97` and the `Gateway`/`_` arms were unreachable. The probe was uninformative and the evaluation baseline emitted a label (`local_interface`) absent from the hypothesis space (`evaluation.rs:64`). Fixed; regression test added.

**N2 — Correlation window never cleared [V] [FIXED].** `previous_timestamp` was overwritten before the gap check, so the gap was always 0 and `observation_history` never reset — probes from hours earlier kept discounting new ones. Fixed; regression test added.

**N3 — Verify stage logically inverted / mis-targeted [V] [UNFIXED].** `investigation.rs:726-741` always re-probes `api_ids[0]` (not the implicated API) and sets `verified = health == Healthy`; the completion text then calls the failure hypothesis "confirmed" precisely when the API is healthy (`:512-516`). Tests cover lifecycle/cancel/history, not diagnostic correctness. **Needs a design decision** on which API/hypothesis to verify.

**N4 — `+inf` evidence poisons normalization [V]/[A] [UNFIXED].** `bayesian.rs:198-201` preserves `+inf`; `math.rs:95-105` computes `+inf − +inf = NaN`, `softmax` returns `None`, all probabilities become `0.0`. No test covers `+inf`. Reachable only if a caller supplies a certain-outcome likelihood.

**N5 — LLM narrative returned as "grounded" unvalidated [V] [UNFIXED].** `ai/explanation.rs:116-123` sets `grounded: true` unconditionally; the frontend concatenates it unchecked (`naniApi.ts:151`). Prompt forbids invention but output is not verified.

**N6 — Double weighting of evidence [V] [INTENTIONAL?].** `diagnosis.rs:647-653` scales log-likelihood by `w` and passes `confidence = w`, multiplied again in `bayesian.rs:204-207` → effective `ll·w²`. Mirrored in IG (`:682-707`) but non-standard tempering; validity unproven.

## 4. Component audit

**Numerical core (`math.rs`, `probability.rs`, `robust_stats.rs`).** Solves stability: sign-split sigmoid, max-shifted log-sum-exp, explicit `-inf`/empty handling, KL with continuity and `+inf` for unsupported mass, Wilson interval, conjugate Beta, Marsaglia–Tsang/Box–Muller samplers, MAD/IQR/quantiles. Assumptions: `PROB_FLOOR=1e-12` on inputs only; zero kept for ruled-out outcomes. Limitations: `credible_interval` claims quantile search but always uses normal approximation (`probability.rs:163-183`); Page-Hinkley triggers on `sum_ph > lambda` not `max−PH` (`drift.rs:126-138`). Testing strong (closed-form values, published Wilson value, 40k-draw sampler moment tests). **[V]**

**Bayesian (`bayesian.rs`, `diagnosis.rs`).** Log-space multiplicative update with source dedup, transition-predict, domain likelihood table. Priors/likelihoods are hardcoded structural judgments explicitly "not measured frequencies" (`diagnosis.rs:263-272`); the Dirichlet calibrator exists only in tests (`:1255`). Normalization correct for finite inputs; `-inf` preserved. Limitations: no posterior predictive check in production; 19-hypothesis uniform prior. Beats the fixed-rule baseline only in the simulator (`evaluation.rs:370-399`, 20 seeds × 11 conditions). **[V]**

**Information theory / sequential.** Correct entropies/MI/stopping formulas, but `expected_information_gain_route` is a KL proxy not an expectation over outcomes (`information_theory.rs:62-101`), and mixes cost units (ms vs abstract). `sequential.rs` duplicates the same functions; `select_best_probe_unified` has no production caller. **[A]/[V]**

**Temporal (`changepoint.rs`, `drift.rs`).** BOCPD run-length update structurally correct but uses fixed variance despite claiming NIG; tests only check monotonic increase. CUSUM correct; PH simplified. Detection confidence is `statistic/threshold` clamped (`foundation.rs:461-486`) — not calibrated. **[V]**

**Hierarchy / learning.** Correct partial pooling, no parent double-counting; ingest validates and rejects invalid, records drift only after 8 samples. Limitations: `CORRELATION_DISCOUNT=0.5` called "calibrated" with no fitting code (`correlation.rs:18-22`); learning from unverified `Direct` probes; `record_api_probe` hardcodes provenance and boolean state. **[V]**

**Evidence.** Good schema; fabricated provenance rejected (`validation.rs:61-64`). Freshness accepts future timestamps (`:71`); `validate` rejects several legitimate `MeasureState`s (`:41-55`). **[V]/[A]**

**Evaluation/calibration.** Cross-fitted isotonic/temperature on held-out seeds, Wilson CI, Brier — but all data simulated, calibration never applied to product confidence, and one test asserts a recorded threshold (`0.146`) — a regression guard, not real-world proof. **[V]**

**Investigation.** Analyze stage is a raw failure-count ratio (`fail/total`), **not** Bayesian despite its docstring (`:636-667`). **[V]**

**API/web/TS.** The TS core is the cleanest Bayesian implementation (`packages/shared/src/nani/diagnosis.ts:48-282`); the adapter uses real TCP/TLS probes with cert verification and IG-based next test. Web-mode hypothesis view returns `null` by design. `/nani/diagnose` accepts caller-supplied observations but the UI sends none, so it reports insufficient evidence. TS tests are substantive (1931 lines) incl. numerical edge cases and stale/zero-reliability evidence. **[V]**

## 5. Bottom line
The math is good; the product wiring is the weak point. Priorities: (1) fix N3 verify-stage semantics; (2) make confidence honest (label uncalibrated or apply the existing calibrator); (3) require verified outcomes for learning; (4) fix N4 `+inf`; (5) validate LLM grounding; (6) resolve the double-weighting question with a test that proves the intended behaviour.
