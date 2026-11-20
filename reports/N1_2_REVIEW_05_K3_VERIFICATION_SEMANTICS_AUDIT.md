# N1_2_REVIEW_05 — K-3 Verification Semantics and Product Honesty

**Reviewer:** Kim · **Mode:** read-only + fresh test reproduction

## A. Execution trace (probe result → displayed text)

`run_verify_stage` (investigation.rs) runs `verify_test_for` on the
implicated layer's test via `observe_diagnostic_probes_matching` (only the
implicated API) → re-feeds the engine → returns `(verified, 
failure_reproduced)`. `run_lifecycle` re-diagnoses the engine and calls the
pure `verify_result_text(top, confidence, verified, failure_reproduced)`
(investigation.rs:1049) → the string lands in the terminal
`InvestigationCompleted` record (`result` field) → `naniEvents` →
`NaniPage.tsx:649` renders `Result: ${active.result}` **verbatim** — no
frontend reinterpretation, no hardcoded verification strings remain
(searched `apps/web/src/features/nani/`: the only "verdict/result" strings
are the backend-authored ones and UI chrome).

## B. Outcome categories (independently enumerated)

The three-way verdict plus the refusal floor yields exactly these
user-visible states, each pinned by an executed test (`k3_*`, 5/5 fresh):

1. Reproduced failure → "reproduced on re-measurement … supports this
   hypothesis, though it does not by itself prove the complete root cause."
   ✓ measured, honest scope. (`k3_case_a_reproduced_failure_says_supports_not_proof`)
2. Contradicted (successful remeasure) → "challenges this hypothesis; the
   posterior was updated" ✓. (`k3_case_b_not_reproduced_says_challenges`)
3. Unavailable → "absence of verification is not success" ✓.
   (`k3_case_c_unavailable_says_absence_is_not_success`)
4. Implicated layer unmeasured → same category as 3 (no measurement
   occurred) — correct conflation, wording holds.
5. Inconclusive → shares 2's wording, documented rationale (a remeasure that
   neither reproduces nor cleanly refutes behaves like a challenge); the
   `verified` boolean still carries the measured truth.
6. No observations / all-healthy → no claim at all (refusal, verbatim);
   unchanged from N1.1 (asserted by retained test
   `n1_insufficient_evidence_refusal_preserved`).
7. Posterior < 0.25 → "insufficient confidence" overrides all wording
   (`k3_floor_overrides_verification_wording`).
8. Exactly 0.25 → conclusion (boundary test pins `>=`).
9. Verification changes / doesn't change the leader: covered by the mapping
   taking `top` as re-diagnosed AFTER the verify feed — the final verdict
   uses the updated posterior (run_lifecycle order verified).

Can the representation distinguish all states without ambiguity? Yes for
user-facing truth; the `verified` boolean plus text covers cases 1-5; the
event schema is unchanged (K-3 deliberately did not redesign events).

## C. Mathematical/semantic correctness

- Reproduced ≠ root-cause proof: explicit in wording ✓.
- Remasure success challenges: posterior update actually happens (the
  engine is re-fed before re-diagnosis — verified in the call order).
- Unavailable ≠ success; missing ≠ healthy ✓ (wording + no-claim path).
- Final verdict uses the updated posterior ✓ (re-diagnosis after feed).

## D. Frontend audit

- Backend text rendered verbatim ✓; no old strings reachable ✓.
- Stale snapshot: `AnalysisCompleted` carries the pre-verify posterior
  (finding K-4, previously registered) — the terminal status card shows the
  final record's `result`; mid-flight events are transient UI states. Not
  re-fixed in N1.2 (correctly out of scope); remains tracked.
- Confidence label: raw posterior shown as "Confidence" (K-5, tracked,
  unchanged — honestly not claimed fixed anywhere).
- Unavailable-verification-as-success: impossible in current wording ✓.

## Verdict: K-3 semantic correctness — **PASS**

(With the standing K-4/K-5 tracking caveats, unchanged from the N1 review and not regressed.)
