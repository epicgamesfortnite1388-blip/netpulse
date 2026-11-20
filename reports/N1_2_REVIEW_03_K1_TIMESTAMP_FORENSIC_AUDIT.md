# N1_2_REVIEW_03 — K-1 Timestamp Forensic Audit

**Reviewer:** Kim · **Mode:** read-only; no engine source modified

## A. Units chain (reconstructed independently)

Probe emission: `unix_now_ms()` (wall-clock ms) → `ProbeOutcomeRecord.timestamp_ms`
→ `diagnostic_probes` copies it verbatim → **boundary** `observe_diagnostic_probes*`
(`/= 1000`, exactly once) → engine deltas in seconds → `predict`: `mix = exp(-0.001·Δ)`.
Relative-vs-absolute: absolute unix seconds are stored (`previous_timestamp`);
deltas are derived inside `observe` (diagnosis.rs:636-637). Zero delta valid
(identity predict). Non-advancing clocks skip predict. Duplicate observations
dedupe upstream (probe level), not in the engine.

## B. Independent reproduction of the 1000× defect — **executed**

Reconstructed from the test source and re-run (`k1_ms_like_timestamps_break_evidence_accumulation`
— 5/5 pass in fresh `cargo test k1_` runs). I additionally verified the math by
hand, not by trusting the report: with Δ_ms fed raw, a 5 s gap becomes Δ=5000 ⇒
`mix = exp(-0.001·5000) = e^-5 ≈ 0.0067` ⇒ the prior is essentially reset to the
stationary distribution before each new check ⇒ confirming evidence cannot
accumulate ACROSS checks (within one check all probes share one ms stamp ⇒ Δ=0
⇒ identity predict ⇒ within-check accumulation is accidentally intact). Over
ten confirming probes: converted path Δ=0..? (same second, identity) with
likelihood updates accumulating ⇒ ~0.42 reported; broken path resets each
call ⇒ hovers near the stationary value ⇒ ~0.24. Both numbers reproduced by
the executed test (`< converted * 0.80` comparative assertion), and the
mechanism is analytically the one above. **The difference is real and caused
solely by the unit of the delta.**

Second-feeder-specific impact at HEAD: each NEW manual health check erases the
previous checks' accumulated belief (full stationary reset), so `nani_math`
diagnosis can never accumulate across manual checks — exactly the K-1 impact,
now confirmed LIVE IN THE COMMITTED BINARY (384f7f9 origin).

## C. The five regression tests — adversarially challenged

| Test | Catches | Would fail pre-fix? | Pass-for-wrong-reason? | Production path? | Deterministic? | Boundaries |
|---|---|---|---|---|---|---|
| `k1_helper_converts_ms_to_seconds` | unit conversion | YES | no (asserts exact seconds) | helper = production boundary | yes | n/a |
| `k1_five_second_delta_preserves_posterior` | 1000× reset across checks | YES | no | yes | yes | 5 s exact |
| `k1_ms_like_timestamps_break_evidence_accumulation` | comparative tripwire | YES | no (comparative, amplification documented) | yes | yes (no network) | 10 probes |
| `k1_filtered_helper_uses_the_same_conversion` | filtered variant parity | YES | no | verify path | yes | n/a |
| `k1_zero_delta_is_identity_predict` | engine contract at Δ=0 | yes (would catch accidental division/algebra) | no | engine | yes | Δ=0 |

Gaps (smallest additions required, not blocking): (1) a negative/retreating
timestamp observation test (behavior is known — predict skipped — but
unpinned); (2) a large-gap test across the correlation window in the seconds
path; (3) a caller-specific test asserting the manual-check path uses the
boundary — currently impossible at HEAD because the committed path doesn't;
this is the central gap and it is **committed-tree**, not test-design.

## D. Manual health-check WIP

- Working tree: conversion present at `nani.rs:326`, applied around the
  author's unchanged lines; loop is `for mut probe in probes` ✓; unstaged ✓.
- Safe to commit with the author's changes? The author's hunks and Will's
  hunk are in the same file; committing the file commits both. That is
  acceptable ONLY with the author's go-ahead (their calibration feature rides
  along) — or alternatively a surgical patch on HEAD's version (convert
  before `observe_probe`, ~3 lines, independent of the WIP). Documented in
  the final decision; neither executed by this review.

## Verdicts

- K-1 investigation lifecycle: **PASS** (boundary owns conversion; tests green; committed).
- K-1 manual health-check working tree: **PASS** (correct, unstaged, preserved).
- K-1 committed HEAD: **FAIL** — the committed binary feeds raw ms into `state.math` (384f7f9); the N1.2 report's contrary claim is false.
- K-1 mathematical contract: **PASS** (mechanism independently derived and reproduced; engine untouched).
