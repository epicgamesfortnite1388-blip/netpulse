# NANI Drift Detection Report

## Implementation
`drift.rs` (CUSUM, Page-Hinkley, drift-aware weighting), `changepoint.rs` (BOCPD),
`timeseries.rs` (EWMA, double EWMA, rolling trend), `robust_stats.rs` (median/MAD anomaly baseline),
`learning.rs` (drift events from real measurements).

## Methods

### CUSUM
`S_t = max(0, S_{t-1} + e_t - nu)`, alert when `S_t > h`.
- `CusumDetector::new(nu, h)` rejects non-positive or non-finite parameters.
- `for_success_rate()` uses `nu = 0.15`, `h = 5.0` (detects a ~0.15 drop in success rate).
- `e_t` is a residual oriented in the direction being detected (`expected - observed`).
- Assumptions: approximately stationary noise and a single shift magnitude `nu`. With these settings an
  alert needs roughly `h/nu ≈ 33` observations' worth of accumulated evidence, which is the practical
  guard against false positives.
- Cost: `O(1)` time, `O(1)` memory.

### Page-Hinkley
`m_t = max(0, m_{t-1} + (x_t - ref))`, alert at `m_t > lambda`, then reset; `for_success_rate()` uses
`lambda = 10`.
- **Known limitation (real):** `ref` is hard-coded to `0.5` and the running mean computed inside `update()`
  is unused. The detector is therefore valid for success-rate-like series only. Latency drift is routed
  through the robust median/MAD anomaly path in `learning.rs` instead of this detector.
  Correcting it requires choosing one-sided vs two-sided and fixed-reference vs running-mean semantics;
  that is a behaviour change, so it was deliberately **not** made silently. Refactor candidate.
- Cost: `O(1)` time, `O(1)` memory.

### BOCPD
`BayesianOnlineCPD::observe(x)` maintains a posterior over run length with a constant hazard `1/lambda`
(`HazardFunction::Constant`). Exposes `changepoint_probability`,
`instantaneous_changepoint_probability`, `most_likely_run_length`, `expected_run_length`, `n`.
- Assumptions: known observation model, geometric hazard, independent segments.
- Cost: `O(max_run_length)` per observation — the most expensive detector here.
- False-positive control: the hazard sets the prior changepoint rate; the reported number is a posterior
  probability, not a threshold crossing.

### EWMA / trend
`ExponentialSmoothing::observe(x) = alpha*x + (1-alpha)*s` with `alpha` validated to `(0,1]`;
`DoubleExponentialSmoothing` tracks level and trend and supports `forecast_h`; `RollingTrend::slope`
fits a trend over a bounded window. A single outlier moves the level by `alpha*(x - s)` rather than
replacing the baseline.

### Robust anomaly (latency)
`RobustStats::anomaly_score(x) = |x - median| / (1.4826*MAD + eps)`. `learning.rs` records a `DriftEvent`
only when the score crosses `DRIFT_ANOMALY_THRESHOLD` after the window has warmed up. The observation is
still added to the window, but the median/MAD baseline moves by at most one order statistic — so a spike
cannot rewrite the baseline.

## Hysteresis and minimum evidence
- CUSUM's `h` is an implicit minimum-evidence requirement.
- The robust anomaly path requires a warmed window before emitting anything.
- `DriftAwareWeighter::decay_weight` increases evidence decay only while a detector reports `Drifted`
  and relaxes afterwards, so a transient spike does not permanently shorten the half-life of evidence.

## Tests
- `drift.rs`: parameter validation, CUSUM statistic growth/reset on a shift, Page-Hinkley detection on a
  shifted success series, drift-aware decay ordering.
- `changepoint.rs`: hazard/survival complementarity, run-length behaviour on stationary data and after a
  mean shift, bounded run-length memory.
- `timeseries.rs`: EWMA converges on a constant series, double smoothing tracks a ramp, trend direction.
- `robust_stats.rs`: MAD = 0 on constants, anomaly score separates an outlier from a normal value.
- `learning.rs`: drift events emitted for anomalous latency, bounded drift history.

All green: `cargo test network_intelligence::` → 340 passed; 0 failed.

## Status
- Implemented: CUSUM, Page-Hinkley, BOCPD, EWMA/double EWMA/trend, robust anomaly, drift-aware decay.
- Tested: yes.
- Benchmarked: not separately; all detectors are `O(1)` except BOCPD (`O(L)`).
- Integrated: `learning.rs` emits `DriftEvent`s from real measurements; exposed via
  `nani_math_drift_analysis`.
- Verified: unit level.
- Blocked / known defect: Page-Hinkley fixed 0.5 reference (above); no drift timeline in the UI.
