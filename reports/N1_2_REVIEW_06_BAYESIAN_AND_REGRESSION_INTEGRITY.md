# N1_2_REVIEW_06 — Bayesian and Regression Integrity

**Reviewer:** Kim · **Mode:** read-only + fresh test reproduction

## A. Engine integrity — verified by diff, not assumption

`git diff 0a3cce5..2a9f825` over `diagnosis.rs`, `bayesian.rs`, `math.rs`,
`probability.rs` → **empty**. Likelihoods, transition kernel, prior init,
dedupe, verified-only learning, log-space arithmetic, hypothesis order
(19), refusal floor 0.25: all unchanged at the source level. BUT: the
caller's timestamp contract can change behavior — that is exactly the
K-1 finding, and it bites at **HEAD** through the committed manual-check
feeder (REVIEW_01 §3), not through the investigation path.

## B. N1.1 oracle — re-inspected and re-executed

`n1_bayesian_engine_drives_the_real_analysis` reconstructs the expected
posterior independently from the RECORDED verify observation (its own
likelihood math, not shared with production) and asserts 1e-9 agreement
through the real `diagnostic_probes` bridge. Critical question: could it
pass despite a timestamp-unit error? **No** — the oracle's expected value
is computed with seconds-calibrated mixing; if the bridge fed ms, the
actual posterior would diverge far beyond 1e-9. It exercises the production
bridge ✓. Executed fresh: PASS. Caveat K-6 stands (the oracle shares the
bridge *function* with production — mitigated by the k1 boundary tests,
which pin the bridge's conversion directly).

## C. Old-ratio tripwire — re-executed

`n1_rejects_the_old_ratio_analysis` PASS fresh; it fails if the lifecycle
restores the old ratio analysis by construction (it asserts the Bayesian
signature — posterior trajectory shape — not merely an output value).

## D. N0 guarantees — rechecked

Shared registry identity (Arc), bus wiring, AppHandle delivery, replay,
`wire_application_dependencies`, honest refusal: covered by the retained
N0 gate test + guard test, both green in the fresh 552/0 runs. No N1.2
commit touched wiring (diff scope verified in REVIEW_01).

## E. Findings reassessment

- **NANI-020 (all-healthy artifact): OPEN.** Deferral remains justified:
  NANI-021 first — a proxy-intermediary "OK" must not become "all healthy"
  wording. No N1.2 change weakened the no-claim rule (retained refusal test
  green). The committed-tree ms-feeder does NOT create a false all-healthy
  (it resets evidence toward stationary, i.e. toward *less* confidence —
  conservative direction).
- **NANI-021 (system-proxy contamination): OPEN, untouched by N1.2** —
  `git diff 0a3cce5..2a9f825 monitor.rs` contains no proxy-related change;
  no N1.2 change makes proxied observations appear trustworthy. Still
  N1.3's first task.
- **NANI-022 (unit harmonization): PARTIALLY RESOLVED, accurately
  described.** The registry entry now says exactly what is and isn't fixed
  (call sites converted; engine-internal ms constants remain). The
  committed-tree feeder gap is NOT claimed resolved there — but the N1_2_01
  report's "no ms-feeder at HEAD" claim contradicts the registry's accuracy;
  the registry is right, the report is wrong (REVIEW_01 §3).

## Verdicts

- N0 regression integrity: **PASS** · N1.1 Bayesian integrity (engine +
  oracle + tripwire): **PASS** — with the K-1-at-HEAD caveat carried as the
  material open defect, not a Bayesian-model defect.
