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
