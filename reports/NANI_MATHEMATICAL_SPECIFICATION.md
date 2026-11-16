# NANI Mathematical Specification

## Implemented algorithms
- Stable probability operations: `math.rs` (`clamp_probability`, sigmoid, log-sum-exp, entropy).
- Bayesian diagnosis and sequential updates: `bayesian.rs`, `diagnosis.rs`.
- Information gain / test selection: `diagnosis.rs`.
- Multi-objective route scoring and Pareto/LCB/CVaR: `route.rs`.
- Contextual bandit (Thompson sampling, safe filtering): `bandit.rs`.
- Drift detection (CUSUM, Page-Hinkley, EWMA): `drift.rs`.
- Causal ATE with identifiability gating: `causal.rs`.
- Calibration metrics (Brier, log loss, ECE): `validation.rs` / `evaluation.rs`.

## Numerical stability
- `f64` used for probabilities.
- NaN handled explicitly (NaN → 0.5 for clamp_probability; log-sum-exp stable).
- Out-of-range probabilities floored/ceiled at `PROB_FLOOR` (1e-12).
- Missing data represented as `Option<T>` and `MeasureState::InsufficientEvidence`, never zero.

## Known limitations
- Correlation model is conservative; no full covariance matrix yet.
- Bandit exploration is constrained and deterministic fallback exists.
- No real-world calibration dataset yet.
