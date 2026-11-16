# FABLE — NANI Mathematical Review

Basis: source reading of `math.rs`, `bayesian.rs`, `probability.rs`, `robust_stats.rs`, `diagnosis.rs`, `information_theory.rs`, `sequential.rs`, `causal.rs`, `changepoint.rs`, `hierarchical.rs`, `learning.rs`, `evaluation.rs`; compiler dead-code evidence; 364 test inventory; live `cargo test` run (529 pass).

## M1. Statistical foundations — CORRECT and USED

- `robust_stats.rs`: mean, sample variance (n−1), std, trimmed/winsorized means — definitions verified by tests (`mean_and_sample_variance_match_definitions`); winsorize caps instead of dropping (correct choice for latency spikes: real spikes are retained, not discarded as outliers — matches the mission's requirement).
- Latency percentile/jitter handling lives in Node (`stabilityService.ts` uses rolling median, spike detection vs p50 baseline: `cur > p50*2 && cur − p50 > 30`) — simple, defensible; timeout is **not** counted as loss in node tests (latency measured only on proven traversal, `nodeTestProbes.ts:255`).
- Wilson interval (`probability.rs::wilson_interval`) tested against published 5/10 value — correct choice for bounded proportions.
- Assessment: **correct and useful**. Gaps: no explicit measurement-uncertainty model (probe latency vs timer resolution) — acceptable at ms scale.

## M2. Bayesian inference — CORRECT numerically; ONE heuristic to document

- `bayesian_update`: log-space accumulation, -inf/NaN semantics handled exactly right (-inf preserved = hypothesis ruled out; NaN = no evidence), per-(source, hypothesis) dedupe (fix documented for a real past bug: DNS failures diagnosing as "unknown").
- Prior handling: uniform and `from_probs` with normalization; entropy, MAP, ranked posteriors implemented.
- **Confidence weighting is a pseudo-likelihood** (`ll * confidence`, `bayesian.rs:205`): directionally sane (shrinks likelihood ratios toward 1), but not a derived likelihood model. It is *not* incorrect — but the numerical posteriors should not be marketed as calibrated probabilities until `evaluation.rs` (Brier/ECE — implemented, tested) runs against **real** investigation outcomes continuously, not just simulation.
- Beta-Bernoulli: posterior predictive + credible width; `update_beta_bernoulli` — correct conjugate update; note compiler flag: one `update_beta_bernoulli` occurrence unused in production paths (feeds only tests) → the "verified learning" Beta posteriors for probe reliability are maintained but under-consumed.
- Correlated evidence: the dedupe-by-source prevents the same probe double-counting, but **cross-probe correlation** (DNS and TCP probes share an outage) is handled qualitatively by the causal layer graph, not quantitatively. No formal treatment (e.g., likelihood correlation matrix) — acceptable; flag in docs.
- Hierarchical pooling (`hierarchical.rs`): partial pooling across contexts — implemented with tests; compiler shows limited production consumption. Verdict: correct but currently a **shelf** module.

## M3. Information theory — correct; selection path partially disconnected

- Entropy, KL, JS divergence implemented with correct log-space guards (`math.rs`).
- `expected_information_gain` (`diagnosis.rs:776`): enumerates predictive outcome distribution `P(o) = Σ_h P(o|h)P(h)`, computes post-observation entropy per outcome via log-vector math (no engine clones — a documented optimization) and averages. This is the textbook expected posterior entropy reduction, done right. There is a **cloning reference implementation as a test oracle** (`expected_information_gain_by_cloning`) — good practice.
- **Disconnect**: this drives `nani_math_select_probe` (a display/command path) but NOT the observe loop of `investigation.rs` (see C-01). So "IG selects the next probe" is true in the UI's recommended-probe view, false in the automated loop.
- `sequential.rs` VOI/`should_stop`/`cost_adjusted_gain`: tested, dead in production. Same verdict.

## M4. Causal reasoning — correct in design; narrow in application

- `causal.rs` ATE from controlled interventions only (`controlled` = exactly one variable changed + verified after stability window); non-identifiable case reported honestly instead of a fake causal claim. This is the right way to separate correlation from causation.
- The DNS→TCP→TLS→HTTP dependency graph is handled by per-layer classification (`monitor.rs` classifies each layer independently) so downstream failures are **not** counted as independent evidence of upstream faults — the failure classifier attributes by layer. Verified in `failure_classifier.rs` structure.
- Gap: the ATE machinery is wired to recovery memory (`recovery_memory.rs`, 1 external ref) but consumer breadth is small; verify in field usage.

## M5. Learning — linked to verified outcomes; sample-sufficiency guarded

- `learning.rs`: `observe_verified_aggregate(api_id, success)` — only verified aggregates feed personalization; comment at :405 explicitly refuses to convert unverified outcomes into verified ones; episode `verified` flag set at :708 through the verify stage.
- Drift (`drift.rs`, `changepoint.rs`: BOCPD/CUSUM/Page-Hinkley) — implemented and tested; `nani_learning_drift` command exposes events. Rollback/reset exists (`nani_learning_reset`).
- Overfitting guard: minimum-sample requirements and reliability-width machinery exist (`beta_credible_width`); profiles degrade explicitly. Data leakage risk is low because features are per-context aggregates.
- Verdict: **genuinely verified learning**, currently under-exercised in the field (needs production usage data, not more code).

## M6. Numerical stability — correct

- Log-space softmax with underflow fix (recent commit `b0311fb` "Fix softmax underflow that fails adversarial_softmax_extreme_log_probs" — the adversarial test suite exists and passes). `PROB_FLOOR`, `clamp_probability`, `finite_or_default` used consistently.

## M7. The LLM boundary — exemplary

- `ai/mod.rs`: local llama.cpp only, opt-in, receives a structured summary, may rewrite prose, **cannot** add measurements, change diagnosis, select recovery, or execute. Deterministic engine returns unchanged text on any failure. Cloud AI is a separate UI copilot path with no state authority. This satisfies the mission's LLM boundary requirements as written.

## M8. Verdict table

| Subsystem | Verdict |
|---|---|
| robust_stats, probability (Beta/Gamma/Normal, Wilson), math primitives | Correct, used |
| Bayesian update + evidence lifecycle | Correct; confidence-weighting is a documented heuristic; calibration measurement exists but not continuous |
| Expected-IG probe selection | Correct math; **disconnected from the automated observe loop** |
| Sequential VOI / early stopping | Correct math; **dead in production** (delete or wire) |
| Causal ATE | Correct, conservative; narrow consumption |
| Changepoint/drift (BOCPD/CUSUM/PH) | Correct; consumed by commands + tests; needs field data |
| Hierarchical pooling | Correct; shelf module (use or delete) |
| Learning (verified-only) | Correct design; needs production runs to prove value |
| Evaluation (Brier/ECE) | Implemented; not continuously run against real outcomes |
| Simulator | Correct, test-only — keep gated |

## M9. Top mathematical actions

1. Wire adaptive stopping + IG-driven probe ordering into `investigation.rs` (or delete the layer) — the single biggest math-to-production gap.
2. Run ECE/Brier continuously on real investigations; expose in `nani_math_*` commands; only then quote posterior numbers as probabilities.
3. Document the confidence-weighting heuristic in `bayesian.rs` doc header with its limitation.
4. Field-validate learning/drift on real usage before adding any new math.
