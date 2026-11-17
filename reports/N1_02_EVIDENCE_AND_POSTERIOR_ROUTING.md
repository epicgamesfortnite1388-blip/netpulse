# N1_02 — Evidence and Posterior Routing

**Phase:** N1.1 · **Commit:** `200de54`

## What changed in `run_analyze_stage` (investigation.rs)

**Before (NANI-003, audited defect):** counted per-layer ok/fail ratios across
observations, presented each failed layer's ratio as "confidence", ranked by
the ratio (ties broken by HashMap iteration order — nondeterministic), and
reported hypotheses named after LAYERS, not diagnostic causes. Several
hypotheses could each report confidence 1.0 — an impossible distribution.

**After:** the analysis IS the authoritative engine's posterior:

1. `has_failure_evidence = observations.any(|o| !o.ok)` — no failure, no claim.
2. `!has_failure_evidence → (None, 0.0, false)` — the established all-healthy
   shape is preserved verbatim (no hypothesis events, refusal result text).
3. Otherwise: `top = engine.diagnosis()` (MAP label + posterior probability),
   ranking = `engine.ranked()`.
4. Top-5 ranked posteriors published: `HypothesisCreated` for the leader,
   `HypothesisUpdated` for runners-up (bounded, so 19 hypotheses cannot flood
   the feed). All confidences come from ONE distribution and can never sum
   past 1 — asserted by the oracle test.
5. `AnalysisCompleted` carries the real MAP + posterior probability.

## Provenance guarantees (mission §3-C)

- Every engine input is a real `probe_api` measurement, converted by the
  production bridge; nothing is invented to fill gaps.
- A never-exercised layer (`LayerResult::Unknown`) becomes **Missing** — never
  a success, never a failure (NANI-019's DNS fix means dns is measured for real).
- A failed probe is negative evidence, never positive health evidence.
- Dedup: engine-internal, per its own contract (per-call (source, hypothesis)
  dedup + correlation discount for repeats). Duplicate observations cannot
  amplify evidence — engine tests pin this; the lifecycle adds no re-counting.
- Evidence ids/links: existing `EvidenceAdded` events unchanged
  (`{id}-{api}-{layer}`, source `probe:{api}`); the new `result`/`detail`
  fields on `InvestigationObservation` record the measurement kind and the
  sanitized detail (HTTP status) so Missing ≠ Failure is traceable everywhere.

## Honest refusal (mission §3-E)

- No observations → lifecycle fails early ("no observations collected") — unchanged.
- No failure evidence → no hypothesis claim + "Insufficient evidence to reach
  a conclusion." — unchanged (preserved text).
- Failure evidence but posterior leader < 0.25 → refusal at the final verdict
  (established floor, now applied to a real posterior).
- Verification can REFUTE a leader: a failed verification re-enters the
  engine; if the updated posterior falls below the floor, the final result is
  the refusal — relative ranking is never confused with certainty.
- A prior is never presented as evidence: priors are exposed only via the
  engine's `priors()` (unused in events for now; `initial_prior` semantics
  untouched).

## What is deliberately NOT changed

- The `LearningEngine` feed (`record_api_probe`, advisory) — untouched.
- No confidence multipliers, no preferred-hypothesis hardcoding, no new thresholds.
- No `events/mod.rs` changes (concurrent user work in that file; not needed).
