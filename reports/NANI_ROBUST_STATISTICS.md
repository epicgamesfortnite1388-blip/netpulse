# NANI Robust Statistics

## Implemented

`robust_stats.rs` provides bounded-memory online statistics:

- Count, mean, variance (Welford-style update).
- Median, MAD, quantiles (P50/P90/P95/P99) over a bounded reservoir/window.
- Anomaly score from median/MAD.
- Per-context, per-metric baselines in `learning.rs`.

`learning.rs` rejects non-finite or invalid measurements instead of coercing them to zero. Latency is preserved in milliseconds (an 850 ms sample stays 850, not 1.0).

## Tested

- Latency magnitude preserved in the profile.
- Missing measurements are rejected and do not change reliability.
- Anomaly/drift requires at least 8 samples and fires on a 5000 ms spike after a 40 ms baseline.
- Persistence and compaction tests are part of the 419-test Rust suite.

## Limits

- The robust reservoir is per context and in memory.
- No confidence intervals are exposed for quantiles in the UI.
- Drift events carry metric name/number/score only; they are not persisted across restart.
- No seasonal decomposition or quantile forecasting was added.

## Deferred

- Persisted per-context distributions with retention policy.
- Quantile confidence intervals and calibration against real captures.
- Robust regression with Huber loss.
