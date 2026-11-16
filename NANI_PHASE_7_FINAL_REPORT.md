# NANI Phase 7 — Final Report
### Advanced Mathematical Intelligence, Adaptive Reasoning & Verified Self-Learning

Date: 2026-11-15
Scope: `src-tauri/src/network_intelligence/**`, Tauri commands under `src-tauri/src/commands/nani.rs`,
`apps/web/src/features/nani/**`.

---

## 1. Headline

The audit found that most of Phase 7's mathematical surface **already existed** with tests: stable numerics,
Beta-Bernoulli, priors/posteriors, a 12-hypothesis diagnostic engine, dependency-aware evidence weighting,
causal gating, BOCPD/CUSUM/Page-Hinkley, hierarchical pooling, calibration metrics, and a deterministic
15-condition simulator. The phase therefore focused on:

1. **Verifying** what was claimed (samplers, numerical guards) instead of assuming.
2. **Filling real gaps**: descriptive statistics (mean/variance/trimmed/winsorized) and a public Wilson
   interval for bounded proportions.
3. **Measuring** accuracy, calibration and cost with real runs.
4. **Reporting the defects honestly** rather than papering over them.

Nothing was replaced for the sake of sophistication.

---

## 2. What changed in this phase

| Change | File | Tests |
|---|---|---|
| `mean`, `variance` (n−1), `std_dev` | `robust_stats.rs` | `mean_and_sample_variance_match_definitions`, `variance_requires_two_observations` |
| `trimmed_mean(fraction)` | `robust_stats.rs` | `trimmed_mean_discards_both_tails`, `trimmed_mean_with_too_small_a_window_keeps_everything`, `trimmed_and_winsorized_reject_invalid_fractions` |
| `winsorized_mean(fraction)` | `robust_stats.rs` | `winsorized_mean_caps_extremes_instead_of_dropping_them` |
| `wilson_interval(s, n, z)` + `WilsonInterval` | `probability.rs` | 4 tests incl. published 5/10 value and edge cases |
| Statistical regression tests for Gamma/Normal/Beta samplers | `probability.rs` | 5 moment/reproducibility tests |
| Unused `PI` import removed (code used the fully-qualified path) | `probability.rs` | compiles clean |

Event/investigation work from Phase 6.1 (event ordering, dedupe, session ownership) remains green.

---

## 3. Verification — what was actually run

```
cargo test network_intelligence::            →  340 passed; 0 failed   (3.56 s)
cargo test network_intelligence::evaluation  →   5 passed; 0 failed
npx tsc --noEmit (apps/web)                  →  exit 0
npm run build -w @netpulse/web               →  exit 0 (built in 12.36 s)
```

Not run: the Windows desktop build/launch. None of this phase's changes surface in the UI yet, so a
launch would not verify them; and a second process was editing the crate during the phase.

Diagnostic quality (real output):

```
NANI 158/220 = 0.718 (95% CI 0.655..0.773) vs fixed 0.636, Brier 0.184, ECE 0.146, H 1.195
```

Cost (debug build, best of 3 × 200 iterations):

```
bench(best of 3): update 161.1us, rank 5007.6us, route 0.1us
```

Start of phase: 325 passing. End: 340 passing. All 15 new tests pass.

---

## 4. Status matrix

| Capability | Implemented | Tested | Benchmarked | Integrated | Verified | Blocked |
|---|---|---|---|---|---|---|
| Stable numerics (log-space, softmax, KL/JS) | yes | yes | indirectly | yes | yes | — |
| Descriptive statistics (mean/var/std/median/MAD/IQR/quantiles) | yes (mean/var/std added this phase) | yes | — | library | unit | — |
| Trimmed / winsorized means | **added** | yes | — | library | unit | — |
| Wilson interval for loss / success rate | **added** | yes | — | library | unit | — |
| Beta-Bernoulli reliability model | pre-existing | yes | yes (`update`) | yes | unit | — |
| Bayesian diagnosis over 12 hypotheses | pre-existing | yes | yes | yes | accuracy measured | calibration weak (ECE 0.146) |
| Evidence dependence / correlation discount | pre-existing | yes | — | yes | unit | — |
| Expected information gain | pre-existing | yes | yes (`rank`) | yes | unit | slow in debug (48 clones/ranking) |
| Cost-aware selection + stopping + VOI | pre-existing | yes | — | yes | unit | — |
| Unified cross-category probe scoring | added (concurrent) | yes | — | yes | unit | — |
| Causal ATE with gating | pre-existing | yes | — | yes | unit | — |
| CUSUM / Page-Hinkley / BOCPD | pre-existing | yes | — | yes | unit | PH fixed 0.5 reference |
| EWMA / trend | pre-existing | yes | — | yes | unit | — |
| Hierarchical partial pooling | pre-existing | yes | — | yes | unit | — |
| Verified learning pipeline | pre-existing | yes | — | yes (`record_api_probe`) | unit + prior desktop run | no historical rollback |
| Calibration metrics (Brier/ECE/MCE) | pre-existing | yes | — | evaluation | yes | — |
| Numerical stability / adversarial numerics | pre-existing | yes | — | — | yes | — |
| Adversarial diagnostic scenarios | pre-existing | yes (aggregate) | 220 scenarios / 0.27 s | — | measured | per-condition assertions missing |
| **Frontend display of posteriors / IG / correlation** | backend commands exist | — | — | **no** | **no** | **yes** |
| LLM-as-explainer only | pre-existing | yes | — | yes | prior phase | — |

---

## 5. Defects and limitations found (not hidden)

1. **Page-Hinkley uses a hard-coded 0.5 reference** and computes an unused running mean. Valid for
   success-rate series only; latency drift is handled by the robust median/MAD path instead. Not changed
   silently because the fix is a semantic choice (one/two-sided, fixed vs running reference).
2. **`expected_information_gain` clones the entire engine per outcome** — 48 clones per `rank_tests`,
   ~5 ms in debug. Optimization identified but not applied: it is not on the IPC path, and a fast path that
   diverges from `observe()` would corrupt probe selection.
3. **`expected_information_gain_route` is a heuristic** (KL between a reliability-sharpened distribution and
   the prior) and does not depend on the candidate index. Described as a divergence score, not a Bayesian
   expected IG.
4. **Calibration is the weakest measured property**: ECE 0.146 against Brier 0.184 means posteriors are
   over-confident. The fix is post-hoc calibration (temperature/Platt on the MAP), not more probes.
5. **Credible intervals are a normal approximation** with a three-point z table.
6. **Wilson formula is duplicated** in `evaluation.rs` (private) and `probability.rs` (public); values agree.

## 6. Concurrency note

Another process was editing this same crate while this work ran (new `information_theory.rs`,
foundation wiring, new `nani_math_*` commands, and a transient compile break mid-phase that was fixed at
source). All results above come from runs taken **after** the crate compiled cleanly again. A transient
`foundation_adversarial_tests_pass` failure seen early in the phase was fixed by that concurrent work
(`math.rs::softmax` flooring) and now passes.

## 7. Next highest-value work

1. Wire posteriors, priors, evidence contributions and selected-probe rationale into the existing
   Hypothesis/Evidence tabs (the `nani_math_*` commands already return this data).
2. Post-hoc calibration of the MAP posterior to cut ECE.
3. Remove the per-outcome engine clone in IG, validated by an equivalence test.
4. Per-condition assertions in the evaluation suite.
