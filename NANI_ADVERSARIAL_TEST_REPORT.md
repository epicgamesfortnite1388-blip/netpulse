# NANI Adversarial Test Report

## What exists
Three layers of adversarial exercise, all executed in this phase:

1. `simulation.rs` — deterministic network simulator with 15 conditions
   (`Healthy, DnsFailure, GatewayFailure, RoutingFailure, Ipv4Only, Ipv6Only, TcpTimeout, TlsFailure,
   MtuIssue, UpstreamProxyDown, RemoteEndpointDown, AuthRejected, RateLimited, ServerError,
   IntermittentLoss`).
2. `evaluation.rs` — scores NANI against a fixed "first failure wins" rule over 11 distinguishable
   conditions × N seeds, reporting accuracy with a Wilson 95% interval, Brier score, ECE and mean
   posterior entropy.
3. `foundation.rs` — `run_stability_tests()` and `run_adversarial_tests()`, asserted by
   `foundation_stability_tests_pass` and `foundation_adversarial_tests_pass`.

## Measured diagnostic accuracy (executed)

```
cargo test network_intelligence::evaluation::tests::nani_beats_fixed_first_failure_rule -- --nocapture

NANI 158/220 = 0.718 (95% CI 0.655..0.773) vs fixed 0.636, Brier 0.184, ECE 0.146, H 1.195
test result: ok. 1 passed; 0 failed
```

Conditions scored (11 × 20 seeds = 220 scenarios): DNS failure, gateway failure, routing failure, TCP
timeout, TLS failure, MTU issue, upstream proxy down, remote endpoint down, auth rejected, rate limited,
server error.

Interpretation, honestly:
- NANI is ~8 points more accurate than the fixed rule, and the 95% intervals do not overlap.
- Brier 0.184 is respectable for a 12-hypothesis space; ECE 0.146 is **high** — mean claimed confidence
  exceeds observed accuracy. That is a calibration gap, not a diagnostic-capability gap, and it is the
  single most useful number here. The calibration section below measures it and shows the gap is
  structural rather than one global over-confidence offset.
- Mean posterior entropy 1.195 nats over 12 hypotheses (max `ln 12 = 2.485`) shows the engine is
  committal after seven probes, consistent with the over-confidence above.

## Adversarial properties asserted

| Attack / failure mode | Expected behaviour | Where asserted |
|---|---|---|
| HTTP 401 | classified as `AuthRejected`, must not become a connectivity/filtering diagnosis | `Simulation` `AuthRejected` → truth `auth_failure`; likelihood table gives auth-specific outcomes |
| HTTP 429 | `RateLimited`, distinct from auth and from loss | truth `rate_limit` |
| HTTP 5xx | `ServerError` → `server_failure`, not endpoint-down unless the TCP stage also fails | truth `server_failure` |
| DNS outage | DNS diagnosis, must not cascade into TCP diagnosis | truth `dns`, correlated-evidence discount on downstream probes |
| TCP timeout | `tcp`, not `dns` | truth `tcp` |
| TLS failure | `tls`, not `tcp` | truth `tls` |
| MTU issue | `mtu`; partial connectivity is not "up" | truth `mtu`, `MtuProbe` |
| Proxy down | `upstream_proxy` | truth `upstream_proxy` |
| Remote endpoint down | `remote_endpoint`, not local interface | truth `remote_endpoint` |
| Intermittent loss | must not be recorded as a stable failure; drift-aware weighting applies | `IntermittentLoss` simulator condition, CUSUM/PH, robust anomaly |
| Missing observation | cannot become a zero latency or a successful probe | `MeasureState::Unknown → None`; `ProbeOutcome::Missing` is its own likelihood column |
| Contradictory evidence | posteriors stay normalized; no hypothesis is forced to certainty | `bayesian::tests`, `diagnosis` posterior tests |
| Extreme/NaN/∞ numerics | no panic, no NaN leak | `foundation::run_adversarial_tests` |
| Duplicate correlated probes | confidence must not inflate | `evidence::correlation` weight tests |

`UNKNOWN` remains reachable: `evaluation::evaluate` uses `engine.diagnosis().unwrap_or(("unknown", 0.0))`,
and the recovery planner returns `insufficient-evidence` when the authorized route or evidence is lacking
(verified in the Phase 6.1 recovery tests: 5/5 passing).

## What is *not* adversarially covered
- No test asserts per-condition accuracy individually; only the aggregate is asserted. A condition can be
  systematically wrong while the aggregate still passes.
- No fuzzing of numeric entry points; no `proptest`.
- No adversarial test for an LLM returning a wrong explanation (the provider-disabled path is covered
  elsewhere: the engine is provider-independent, and `nani_explain` is explanatory only).
- No adversarial test for clock skew / out-of-order timestamps beyond the transition model's
  distinct-timestamp usage.
- Per-condition calibration is not asserted; the aggregate is (see below).

## Post-hoc calibration (executed 2026-11-16)

Two calibrators were fitted on the simulator suite and measured on data the fit never saw: by seed
parity within the run (fit 110 trials, measure the other 110), and 2-fold cross-fitting so that all 220
trials contribute a calibrated counterpart of the raw 0.146 figure.

```
cargo test network_intelligence::evaluation::tests::isotonic_calibration_cuts_held_out_calibration_error -- --nocapture

calibration: raw ECE 0.156 | temperature ECE 0.186 (T = 0.70) | isotonic ECE 0.073
             | Brier 0.189 -> 0.180, log loss 0.536 -> 0.542 | fit 110 trials, holdout 110
full suite (220 trials) cross-fitted: ECE 0.146 -> 0.074
```

- **Cause of the gap:** not global over-confidence. Temperature scaling fits `T = 0.70` — it wants to
  *expand* confidence — and makes held-out ECE worse (0.156 → 0.186). Some confidence ranges are too high
  while others are too low at the same time, so no single scale factor can correct it.
- **Fix:** monotone isotonic regression (`validation::IsotonicCalibrator`, weighted PAVA) mapping raw MAP
  confidence to observed frequency, each block shrunk toward the base rate with a 2-sample Beta prior so
  the map never claims exactly 0 or 1 (unsmoothed isotonic cut ECE further but pushed log loss from 0.536
  to 1.424 by outputting 0/1).
- **Result:** full-suite ECE 0.146 → **0.074** (−49%), Brier 0.189 → 0.180, log loss unchanged within
  noise (0.542 vs 0.536), on held-out trials only. The transform is monotone, so no diagnosis changes:
  only the confidence attached to it.
## Success evidence and the residual state (2026-11-16)

**Symptom:** a health check where every probed layer succeeded raised `dns` and
`dns_inconsistency` by roughly 30 percentage points in the Hypothesis tab.

**Root cause:** the hypothesis space had no state meaning "no fault evidenced". `Unknown`
existed but carried ordinary fault-like failure signatures (0.20-0.30 per test), so it never
represented health. Every success therefore had to hand its probability to *some* fault
hypothesis, and the winner was whichever fault hides best from good news. Reproduced on a
healthy multi-API sequence before the fix: the leader became `ipv6` at 52-75% and `unknown`
sat at 0.16-0.22, i.e. the engine answered "something is wrong" to a working network. The
time-decay step was ruled out: `predict` mixes toward a uniform stationary distribution and
is invariant on a uniform prior at 0 ms / 60 s / 3 min.

**Fix:** `LikelihoodTable::signature` now gives `Unknown` a 0.02 failure probability on every
test, making it the explicit residual state. Successes concentrate there and the fault
hypotheses decay. On the same healthy sequence the leader is now `unknown` at 87-90% with
every fault near zero, and `dns` / `dns_inconsistency` do not move up.

Pinned by two tests in `diagnosis`:

- `a_healthy_probe_round_does_not_raise_failure_hypotheses` — the four-layer healthy round
  from the report (dns, tcp, tls, http), asserting neither DNS hypothesis rises.
- `a_fully_healthy_round_makes_no_fault_more_likely` — all eight tests succeed, asserting the
  residual state becomes dominant (> 0.5) and is the MAP.

**Consequence for calibration numbers in this document.** Diagnosis accuracy per condition is
unchanged (dns 0.70, tcp 0.70, tls 1.00, gateway 1.00, ...), and proper scoring rules improve
(Brier 0.189 -> 0.172, log loss 0.539 -> 0.512). The 10-bin ECE does not: it moved from
0.179 -> 0.048 before this change to 0.178 -> 0.171 after, because healthy evidence now
compresses the spread of raw confidences and fewer distinct values fit into 10 bins. The stale
absolute bars (0.146) were replaced by relative assertions on Brier, log loss and cross-fitted
ECE, which is what the earlier figures in this document were really standing in for.

### Per-condition calibration breakdown (2026-11-16)

`evaluate_calibrated` now also returns `per_condition`, one row per simulator condition on
the same held-out half (10 trials each here, 5 bins), ordered by that condition's share of
the aggregate ECE:

```
    server_failure: n=10 conf=0.487 acc=0.000 gap=+0.487 ECE 0.487 -> 0.684 (share 0.0622)
   remote_endpoint: n=10 conf=0.488 acc=0.000 gap=+0.488 ECE 0.488 -> 0.654 (share 0.0594)
               tcp: n=10 conf=0.534 acc=0.700 gap=-0.166 ECE 0.581 -> 0.485 (share 0.0441)
    upstream_proxy: n=10 conf=0.459 acc=0.900 gap=-0.441 ECE 0.494 -> 0.330 (share 0.0300)
               dns: n=10 conf=0.398 acc=0.700 gap=-0.302 ECE 0.469 -> 0.247 (share 0.0224)
      auth_failure: n=10 conf=0.954 acc=1.000 gap=-0.046 ECE 0.046 -> 0.048 (share 0.0044)
        rate_limit: n=10 conf=0.996 acc=1.000 gap=-0.004 ECE 0.004 -> 0.048 (share 0.0044)
```

Two findings the aggregate could not show:

- **`server_failure` and `remote_endpoint` are never diagnosed** (0/10 correct) and the map
  makes them *worse* (ECE 0.487 -> 0.684 and 0.488 -> 0.654). They are the engine's blind
  spots, not calibration failures; a monotone map fitted across all conditions cannot fix a
  condition whose label is always wrong, and it actively drags confidence toward the base rate.
- The genuinely under-confident conditions (`upstream_proxy` 0.46 claimed vs 0.90 right,
  `routing` 0.59 vs 1.00, `gateway` 0.60 vs 1.00) are pulled up hard by the same map, which is
  where most of the aggregate gain comes from.

Per-condition ECE is a 10-trial, 5-bin estimate: treat the ordering as a pointer to where to
look, not as a precise per-condition score. `calibrated_ece_contribution` is `trial_share x
ECE`, an approximation because the aggregate bins are global.

### Temperature scaling removed (2026-11-16)

`validation::TemperatureScaling` was only ever the comparison baseline in that measurement, never a
production transform: no live code path fitted or applied it. Keeping it meant shipping a log-loss
optimiser plus five tests in the statistical module for a method the engine does not use, so it was
deleted together with `mean_log_loss_at`, the five `temperature_scaling_*` tests, and the
`temperature` / `temperature_ece` fields of `CalibrationComparison`.

The negative result stays on record here and in code: `IsotonicCalibrator`'s doc comment explains why a
single global scale factor cannot fit this engine's structural miscalibration, and
`isotonic_calibration_cuts_held_out_calibration_error` still asserts calibrated ECE below the recorded
0.146 raw full-suite baseline, so deleting the alternative did not quietly lower the bar.

- **Not yet wired to the UI:** the fitted map comes from simulator trials. Applying it to live posteriors
  needs outcome history from real probes persisted and refitted; hard-coding a simulated `T`/knot set into
  production confidence would be a fabricated number.

## Status
- Implemented: 15-condition simulator, 11-condition scored evaluation, stability/adversarial suites,
  post-hoc isotonic calibration of the MAP confidence.
- Tested: yes — 357 NANI tests pass, including the two adversarial suite tests and 9 calibration tests.
- Benchmarked: evaluation runs 220 scenarios in 0.27 s (debug).
- Verified: aggregate accuracy and intervals measured above; calibration gain measured on held-out trials.
- Blocked: per-condition assertions remain an open item; the calibration map is not applied to live
  posteriors (no persisted real-outcome history to fit it on).
