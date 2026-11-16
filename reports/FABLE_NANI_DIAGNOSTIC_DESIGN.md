# FABLE — NANI Diagnostic Design

Target design for NANI diagnosis, grounded in the existing Rust engine, after the corrections in the Mathematical Review and Architecture Critique.

## 1. Hypothesis set

12 hypotheses exist in `diagnosis.rs` (`Hypothesis::all()`), covering the failure taxonomy the monitor can actually observe: DNS failure, gateway failure, routing failure, IPv4-only, IPv6-only, TCP timeout, TLS failure, MTU issue, upstream proxy down, remote endpoint down, auth rejected, rate limited, server error, intermittent loss (15 conditions in the simulator, mapping to this taxonomy). **Keep this taxonomy** — it matches the observable layer model (DNS/TCP/TLS/HTTP/auth/app).

## 2. Likelihood model

`engine.likelihood.log_likelihood(test, hypothesis, outcome)` provides P(outcome|H,test) per test. Improvements required:

1. **Confidence weighting → likelihood noise parameter.** Replace `ll * c` with an explicit model: P_obs = (1−ε)·P + ε·P_uninformative, where ε = 1−confidence. This is a proper mixture likelihood; it has the same attenuating effect but derived, and it keeps ratio behavior principled. Implement in `bayesian_update` behind the same `Evidence.confidence` field (no API change).
2. **Correlated evidence.** The dedupe-by-source stays. Add a declared dependency relation between tests (which test's failure implies another's unobservability) — the data for this already exists in the layer graph; use it in `expected_information_gain` to zero-out redundant probes (conditional dependence), instead of the current flat redundancy behavior.

## 3. Probe selection and stopping (the actual redesign)

Current automated loop (`investigation.rs::run_observe_stage`): probe everything, then analyze. Target loop:

```
while !engine.should_stop(min_probes, max_probes, credible_width_budget)
      && probe_budget_remaining:
    test = select_best_probe(engine)      # IG per cost, redundancy-adjusted
    obs  = run test (probe_api layer)
    engine.observe(obs)                   # posterior update
    emit InvestigationEvent(Observed)
```

- `should_stop` semantics: stop when MAP hypothesis credible width < budget (Wilson/Beta width already implemented) or expected best-probe VOI < cost floor.
- Minimum-probe floor prevents adversarial early exit.
- Config: `NANI_ADAPTIVE_STOPPING=1` flag for one release, default off → then flip default after field data.

## 4. Verification and recovery gating

- Recovery steps stay gated by evidence sufficiency (`insufficient-evidence` refusals — already tested in `naniRecoveryControls.test.ts`).
- Verify stage re-probes and only then closes episodes as verified; the learning engine consumes verified aggregates only. Keep.

## 5. Evidence provenance

- `Evidence { source, timestamp, confidence }` exists. Add: **evidence → observation record linkage** (the exact probe record id) so the UI's Evidence Explorer can show the raw measurement behind every likelihood. The investigation already records `InvestigationObservation`; extend the evidence struct with `observation_id`.

## 6. Calibration as a first-class output

- Run `evaluation.rs` (Brier, ECE) on every completed real investigation (not just simulation): compare MAP posterior against the verified verify-stage outcome. Persist per-100-investigations rolling calibration into `persistence.rs`; expose via `nani_math_calibration` command; show on NaniPage.
- Acceptance: ECE < 0.10 over ≥100 real investigations before the UI labels posteriors as "probabilities"; until then label them "scores".

## 7. LLM boundary

Unchanged from current implementation (correct): local LLM prose-only; cloud copilot stateless. No changes needed — only keep the existing tests green.

## 8. What NOT to add

- No hierarchical models beyond current pooling until field data justifies it.
- No new changepoint algorithms (BOCPD + CUSUM + Page-Hinkley already exceed need).
- No neural anything in the diagnosis path.

## 9. Migration plan (ordered)

1. Gate the Node shadow loop off in desktop (A-1) — removes the duplicate diagnosis stream.
2. Land in-flight `validation.rs`/`diagnosis.rs` work (commit it).
3. Implement the adaptive probe loop behind the flag.
4. Add evidence↔observation linkage.
5. Continuous calibration job.
6. Retire TS NANI math to contract types (keep event reducer + DTOs).
