# N1_2_04 — Healthy-Network Bias Assessment (NANI-020)

**Phase:** N1.2 · **Decision: TRACK — do not implement the shortcut now.**

## Assessment of the proposed all-healthy detector

The idea (Kim's review + mission §6): when every measured layer reports
healthy, bypass the posterior and report "no failure measured" instead of
"insufficient evidence," without adding a twentieth hypothesis.

**Why it is tempting:** the current refusal text ("Insufficient evidence to
reach a conclusion.") is technically honest but does not tell the user the
useful fact — *all measured layers were healthy; there is nothing to
diagnose*.

**Why N1.2 does NOT implement it:**

1. **NANI-021 interaction.** On proxied/intercepted networks the HTTP layer's
   "Ok" may be the proxy's answer, not the target's (N1_REVIEW_01 §7). An
   all-healthy shortcut published *before* the proxy-path fix could convert a
   proxy-corrupted measurement into a confident "all healthy" statement —
   exactly the "conceal a real failure" failure mode the mission forbids.
   Ordering matters: NANI-021's `.no_proxy()` + consistency gate must land
   (N1.3, first task) before any "all healthy" phrasing is user-facing.
2. **The safety property is already in place.** The no-claim rule
   (`!has_failure_evidence → (None, 0.0, refusal)`) — verified by Kim —
   prevents any misleading leading hypothesis on healthy networks. The
   residual gap is wording quality only, not correctness.
3. **Test-churn vs value.** Changing the preserved refusal text would ripple
   through N0/N1 assertions for a cosmetic gain — poor trade this phase.

## Registered recommendation (for N1.3+, after NANI-021)

When the direct-path guarantee exists: if every measured layer is `Ok` and at
least the transport layers were genuinely exercised, report
"No failure detected: every measured layer reported healthy." — while
"Insufficient evidence" remains the verdict for mixed healthy/missing sets.
Isolation: the rule keys on the *measurement kinds* (all `Ok`), not on the
posterior, and cannot suppress a real failure because a real failure makes
some layer non-`Ok` by definition. Documented here; **NANI-020 remains OPEN**
with this as the concrete N5-or-N1.3 follow-up.
