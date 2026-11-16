# ULTIMATE MATHEMATICAL AUDIT

**Audit date:** 2026-11-16. Independent review of the mathematical code in `src-tauri/src/network_intelligence/**` and `packages/shared/src/nani/**`. **[V]** verified · **[A]** analysis · **[?]** assumption.

For each component: what problem it solves, why the method, assumptions, limitations, how tested, whether it beats a simpler baseline, whether the product uses it.

---

## 1. Numerical primitives (`math.rs`)

- **Problem:** stable log-space arithmetic for Bayesian updates.
- **Method:** sign-split sigmoid, max-shifted `log_sum_exp`, softmax that returns `None` when no finite normalizer exists, KL divergence with continuity correction.
- **Assumptions:** inputs are log-probabilities; `-inf` = impossible.
- **Limitations:** `+inf` input produces `NaN` via `+inf − +inf` (`math.rs:95-105`) → `softmax` returns `None` → callers that `unwrap_or_default()` get all-zero probabilities. **[V]**
- **Testing:** strong — closed-form checks, underflow case (the HEAD commit fixed a softmax-underflow adversarial case). **[V]**
- **Verdict:** correct for finite and `-inf` inputs; **`+inf` is a latent hazard** (NANI N4). Beats baseline (naive exp/sum overflows). Used by all inference.

## 2. Probability & statistics (`probability.rs`, `robust_stats.rs`)

- **Problem:** conjugate Beta updates, credible intervals, robust location/scale, quantiles, sampling.
- **Method:** Beta conjugate; Wilson interval; MAD/IQR; Marsaglia–Tsang normal, Box–Muller; seeded RNG for reproducibility.
- **Limitations:** `credible_interval` documents a quantile search but always uses the normal approximation (`probability.rs:163-183`) — so it is a *normal-approx* interval, not the exact Beta quantile it implies. For small α/β this is inaccurate and the doc overstates it. **[V]**
- **Testing:** sampler moments tested with 40k draws; Wilson matches a published value. **[V]**
- **Verdict:** sound, one documentation/implementation mismatch. Beats baseline. Used by hierarchical/learning.

## 3. Bayesian inference (`bayesian.rs`, `diagnosis.rs`)

- **Problem:** posterior over 19 network-failure hypotheses from probe evidence.
- **Method:** log-space multiplicative likelihood update with source dedup; transition/predict step for time decay; hardcoded domain likelihood table.
- **Assumptions:** conditional independence of probes *after* correlation discounting; likelihoods are expert priors, not measured.
- **Limitations:**
  - Likelihood/prior tables are **structural judgments** ("not measured frequencies", `diagnosis.rs:263-272`). Calibration exists only in tests (`:1255`), so production confidence is uncalibrated. **[V]**
  - Evidence is weighted twice: `ll·w` with `confidence=w` multiplied again in `bayesian.rs:204-207` → effective `ll·w²`. Non-standard tempering; whether intentional is unproven. **[V]/[A]**
  - `+inf` handling as in §1. **[V]**
- **Testing:** normalization, dedup, entropy, KL, calibration math; simulator shows it beats the fixed-first-failure rule over 20 seeds × 11 conditions. **[V]**
- **Verdict:** mathematically coherent; **empirical calibration absent in production**. Used by hypothesis view.

## 4. Information theory (`information_theory.rs`, `sequential.rs`)

- **Problem:** choose the next probe by expected information gain per unit cost.
- **Method:** entropy, mutual information, KL; greedy IG/cost selection; SPRT-style stopping.
- **Limitations:**
  - `expected_information_gain_route` is a **KL proxy**, not the expectation over outcome distribution (`:62-101`). For probe selection the true EIG is `Σ_o P(o)·KL(P(H|o)‖P(H))`; the proxy can misrank. **[A]**
  - Mixes cost units (milliseconds vs abstract cost) in the same ratio. **[V]**
  - `sequential.rs` duplicates several functions; `select_best_probe_unified` has no production caller. **[V]**
- **Testing:** formula-level unit tests; the fast-path IG matches the cloning reference in `diagnosis.rs` to 1e-9 (good). **[V]**
- **Verdict:** entropy/MI correct; EIG-for-routing is approximate. Used (diagnosis IG is real); the duplicated/uncalled parts are dead.

## 5. Temporal (`changepoint.rs`, `drift.rs`)

- **Problem:** detect regime change and slow drift.
- **Method:** BOCPD (run-length posterior), CUSUM, Page-Hinkley.
- **Limitations:**
  - BOCPD claims normal-inverse-gamma but uses **fixed variance** (`changepoint.rs:115-117,219`) — the model is simpler than documented. **[V]**
  - Page-Hinkley triggers on `sum_ph > lambda` rather than the textbook `max(cumsum) − cumsum > lambda` (`drift.rs:126-138`). **[V]**
  - Detection "confidence" is `statistic/threshold` clamped (`foundation.rs:461-486`) — a heuristic, not a calibrated probability. **[V]**
- **Testing:** BOCPD test only checks monotonic increase; CUSUM correct. **[V]**
- **Verdict:** usable detectors; documentation overstates the models. Used by learning.

## 6. Hierarchy & learning (`hierarchical.rs`, `learning.rs`)

- **Problem:** partial pooling of per-network profiles; online learning of probe reliability.
- **Method:** hierarchical Beta with shrinkage; ingest validation; drift-gated updates.
- **Limitations:**
  - `CORRELATION_DISCOUNT = 0.5` is called "calibrated" with **no fitting code** (`correlation.rs:18-22`). **[V]**
  - Learning updates from `Provenance::Direct` (unverified); only the aggregate path requires `IndependentlyVerified`. **[V]**
  - `record_api_probe` hardcodes provenance and a boolean state. **[V]**
- **Testing:** shrinkage, persistence, rejection covered. **[V]**
- **Verdict:** pooling math correct; **learning trust model is weaker than claimed**. Used by personalization.

## 7. Evaluation & calibration (`evaluation.rs`, `validation.rs`)

- **Problem:** measure diagnostic accuracy and calibrate confidence.
- **Method:** cross-fitted isotonic/temperature scaling on held-out seeds; Wilson CI; Brier score.
- **Limitations:** all evaluation data are **simulated**; the calibrator is never applied to production confidence; one test asserts a recorded threshold `0.146` — a regression guard, not proof. **[V]**
- **Verdict:** evaluation harness is real but does not validate the shipped product; calibration is not wired in.

## 8. Simulation (`simulation.rs`)

- **Problem:** synthetic network conditions for tests/evaluation.
- **Limitations:** compiled into the production binary; `simulate_probe` has no production caller. **[V]**
- **Verdict:** legitimate test infrastructure; should be `#[cfg(test)]`-gated to prevent future misuse as "measurement".

## 9. Cross-cutting findings

1. **Calibration gap** is the single biggest mathematical honesty issue: sophisticated calibrators exist but are not applied; confidence is presented as a percentage. **[V]**
2. **Documentation/implementation drift** in `credible_interval`, BOCPD, and Page-Hinkley — each claims more than it does. **[V]**
3. **Dead sophistication:** `causal.rs`, `information_theory` cost functions, `sequential.rs`, `simulation.rs` are well-built but unwired. Value is zero until used or removed. **[V]**
4. **Double weighting** of evidence needs an explicit decision + test. **[A]**

## 10. Recommendations (no code changed in this audit for math)
1. Wire the existing calibrator into production confidence, or label confidence "uncalibrated heuristic".
2. Fix or re-document `credible_interval`, BOCPD variance, and Page-Hinkley.
3. Replace the EIG KL-proxy with the true expectation for probe ranking, or document it as a heuristic.
4. Decide and test the evidence-weighting exponent.
5. Gate `simulation.rs` behind `#[cfg(test)]`; delete or wire `sequential.rs`/`causal.rs` per the legacy plan.
