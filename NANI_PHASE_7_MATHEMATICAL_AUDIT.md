# NANI Phase 7 — Mathematical Audit

Date: 2026-11-15
Scope: `src-tauri/src/network_intelligence/**` (Rust, authoritative), plus the TypeScript surface that consumes it.

## 1. Method

Every module below was read directly: public API, internal algorithm, numerical guards, and tests.
Nothing here is inferred from names. Measurements quoted come from commands actually run (see
`NANI_PERFORMANCE_REPORT.md` and `NANI_PHASE_7_FINAL_REPORT.md`).

Baseline test run at the start of Phase 7 work:

```
cargo test network_intelligence::   →  325 passed; 0 failed  (3.51s)
```

Final state after this phase's additions:

```
cargo test network_intelligence::   →  340 passed; 0 failed  (3.53s)
```

## 2. Inventory — what already exists

| Component | Location | Definition | Status |
|---|---|---|---|
| Stable numerics (log-sum-exp, sigmoid, logit, softmax, KL, JS, entropy) | `math.rs` | Log-space throughout; max-subtraction in `log_sum_exp`; NaN handled explicitly | Complete, tested |
| Beta-Bernoulli conjugate model | `probability.rs` | `Beta(α+s, β+f)`; posterior mean/variance/LCB/credible interval | Complete, tested |
| Gamma + normal sampling | `probability.rs` | Marsaglia-Tsang (k≥1), Ahrens-Dieter transform (k<1), Box-Muller for the normal | **Verified this phase** (moments tested) |
| Categorical over log-probabilities | `probability.rs` | softmax normalization, evidence addition in log space | Complete, tested |
| Priors / posteriors / evidence | `bayesian.rs` | `Prior`, `Posterior`, `Evidence{log_likelihood, reliability}`, age decay | Complete, tested |
| Hypothesis space + diagnosis | `diagnosis.rs` | 12 hypotheses × 8 tests × 6 outcomes likelihood table | Complete, tested |
| Expected information gain | `diagnosis.rs::expected_information_gain` | `H(H) − Σ_o P(o|T)·H(H|o,T)` in nats | Complete, tested — but allocates per outcome (see §5) |
| Evidence dependence | `evidence/correlation.rs` | `weight = 1/(1 + 0.5·n_correlated_prior)`; same test repeated keeps full weight | Complete, tested |
| Causal tracking | `causal.rs` | ATE with identifiability gating, `CONTROL_ACTION` | Complete, tested |
| Change-point detection | `changepoint.rs` | BOCPD with run-length posterior, constant-hazard only | Complete, tested |
| Drift | `drift.rs` | CUSUM, Page-Hinkley, `DriftAwareWeighter` | Complete, tested |
| Hierarchical learning | `hierarchical.rs` | Global + context/api partial pooling with `κ` | Complete, tested |
| Online learning / memory | `learning.rs` | `record_api_probe`, `record_user_correction`, drift events, bounded storage | Complete, tested |
| Calibration metrics | `validation.rs` | Brier, log loss, ECE, MCE, `CalibrationReport` | Complete, tested |
| Stopping / VOI | `sequential.rs` | `cost_adjusted_gain`, `should_stop`, `value_of_information` | Complete, tested |
| Unified probe scoring | `information_theory.rs` | Cross-category `ScoredProbe` (diagnostic/API/route/recovery) by IG per unit cost | Added this phase (concurrent work), tested |
| Facade | `foundation.rs` | Single typed entry point + stability/adversarial self-tests | Complete, tested |
| Deterministic simulator | `simulation.rs` | 15 network conditions | Complete, tested |
| Offline evaluation | `evaluation.rs` | NANI vs fixed-rule accuracy, Wilson 95% CI, Brier, ECE, micro-benchmarks | Complete, tested |

## 3. Verification of the Gamma/Box-Muller correction

The earlier fix (normal input to Marsaglia-Tsang instead of a uniform) is **correct**, and is now
covered by moment tests rather than assumption:

- `gamma_sampler_shape_above_one_matches_theory` — 40 000 draws, k = 2: mean ≈ 2 (tol 0.05), variance ≈ 2 (tol 0.12).
- `gamma_sampler_shape_below_one_matches_theory` — k = 0.5 (the Jeffreys-prior branch): mean ≈ 0.5, variance ≈ 0.5.
- `normal_sampler_has_zero_mean_and_unit_variance` — mean ≈ 0, variance ≈ 1, ~50% mass below zero.
- `beta_sample_matches_posterior_mean` — Beta(71,31) draws match analytic mean and variance.
- `samplers_are_reproducible_for_a_fixed_seed` — bitwise-identical sequences for the same seed.

`normal_sample` is `sqrt(|2·ln U1|)·cos(2πU2)`. Since `ln U1 < 0`, `|2·ln U1| = −2·ln U1`, so this is
the standard Box-Muller `sqrt(−2·ln U1)·cos(2πU2)`. Correct, though the `abs()` obscures the sign
argument; left as-is because changing a verified correct sampler buys nothing.

The `k < 1` branch uses `U^(1/k)·G` with `G ~ Gamma(k+1)`, which is the exact Ahrens-Dieter identity
because `U^(1/k) ~ Beta(k,1)`. Correct.

## 4. Gaps found (and what this phase did)

| Gap | Severity | Action |
|---|---|---|
| No mean / variance / std-dev over the sliding window | Medium — §2 requires descriptive statistics | **Added** to `robust_stats.rs` (Bessel-corrected, `None` below n=2) |
| No trimmed mean | Medium — §2 | **Added** `trimmed_mean(fraction)`, symmetric, `floor(n·f)` per tail |
| No winsorized mean | Medium — §2 | **Added** `winsorized_mean(fraction)` |
| Wilson interval existed only as a private copy in `evaluation.rs` | High for §2 packet-loss CI | **Added** public `wilson_interval(s, n, z)` + `WilsonInterval` |
| No statistical regression tests for the samplers | High for §9 | **Added** 5 moment/reproducibility tests |
| `rank_tests` costs ~5 ms in a debug build | Low today (not on the IPC path) | Documented, not optimized — see performance report |
| Frontend does not display posteriors, priors, IG or correlation | High for §12 | **Not done here** — see final report, `Blocked` |

## 5. Numerical assumptions and limitations that remain

1. `BetaBernoulli::credible_interval` uses a **normal approximation** with a three-point z table
   (0.90/0.95/0.99, defaulting to 1.96). It is not the exact Beta quantile. Documented in-code; adequate
   for ranking and LCB, not for regulatory reporting.
2. `math::clamp_probability(NaN) = 0.5` ("maximum ignorance"). This is a deliberate total-function
   choice, not evidence fabrication, but callers that need "no data" must use `Option` — the codebase
   does.
3. `HazardFunction` supports only a constant hazard (`1/λ`), so BOCPD run-length hazard does not depend
   on `run_length`. Fine for a geometric prior; hierarchical or hazard-from-history models are not implemented.
4. `expected_information_gain` clones the whole engine once per outcome (6 per test, 48 per ranking).
   Correct but allocation-heavy.
5. `CorrelationModel` discount is a fixed constant (0.5 per correlated prior observation), not a
   learned covariance. Conservative by construction; it cannot overstate confidence, but it also cannot
   distinguish strong from weak dependence.
6. `evaluation::wilson` duplicates the formula now public in `probability::wilson_interval`. Both agree
   (verified by value on 5/10); the duplication is harmless but is a refactor candidate.

## 6. Practical diagnostic application

Each component maps to a real workflow already present in the app: auth/rate-limit/5xx outcomes are
distinct `ProbeOutcome`s (so a 401 cannot be scored as connectivity loss), `Ipv6Only`/`MtuIssue`/`IntermittentLoss`
are distinct simulator conditions, and the causal tracker refuses an ATE without a control comparison.

## 7. Verdict

The mathematics were in better shape than a from-scratch Phase 7 would assume: 18 of the 20 requested
capabilities already existed with tests. The real work was verification (samplers, tests), the missing
descriptive statistics and bounded-proportion interval, and honesty about what is not wired to the UI.
