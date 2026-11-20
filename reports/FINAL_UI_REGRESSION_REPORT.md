# FINAL_UI_REGRESSION_REPORT — protection status per defect

**Reviewer:** Kim · **Question answered:** for each finding, does a test actually detect the original defect?

## 1. Existing regression tests verified this mission

| Test / guard | Protects against | Evidence it genuinely detects the defect |
|---|---|---|
| `apps/web/test/typeScale.test.ts` (2 assertions) | Sub-12px text and arbitrary bracket font sizes (F-10) | **Proven**: failed at baseline with 4 named offenders; passed after Will removed them; file itself unmodified since 2026-10-02. This is the strongest regression evidence in the mission. |
| `src/features/nani/hypothesisView.test.ts` (9 tests) | Posterior → row mapping, prior/posterior distinction, calibration label selection | Passes (506/506). Coverage is of the pure helper only; does not assert the render label switch (F-24). |
| `src/features/nani/naniEvents.test.ts` | Event envelope parsing, dedupe, health-check event mapping | Passes; covers only `health: 'Healthy'` for `HealthCheckCompleted` (F-09), and does not cover missing `verified` (F-08). |
| `network_intelligence::investigation::tests::n1_bayesian_engine_drives_the_real_analysis` | Old ratio analysis returning instead of engine posterior (NANI-003) | **Failing in this workspace** (two failure modes). The tripwire `n1_rejects_the_old_ratio_analysis` still passes. Gate is not reliably green (F-15). |
| `k2_hundred_simultaneous_starts_never_exceed_the_cap` (prior) | Concurrent admission cap 4 | Passes in full suite; prior 2 fresh stress runs documented in `N1_2_REVIEW_FINAL`. |
| `a_healthy_probe_round_does_not_raise_failure_hypotheses` (new, working tree) | F-01's intended behavior (healthy evidence promotes no fault) | Passes in the current tree — but it *encodes* the unreviewed new likelihood table; it does not protect the previously validated table. |

## 2. New tests required but not yet written (owner: Will / authorized engineer)

| Defect | Missing regression test | Passing criterion |
|---|---|---|
| F-04 TS2322 | Typecheck itself is the gate; add a unit test for both disconnect carriers | `tsc --noEmit` exit 0; both branches invalidate `['tunnel']` and `['vpn']` |
| F-03 web false-healthy | Web NANI health path where all `/nani/check` calls reject | No `healthy` count and no verdict word "healthy" rendered |
| F-05 dead connection console | Route render test on `/` | Dial `role="img"` present and "traffic unverified" shown for `verification:'not_verified'` |
| F-07 poll leak | Unmount during in-flight `pollEvents` | Zero intervals registered after cleanup; no state update |
| F-08 verification default | `VerificationCompleted` without `verified` | Event text is "unavailable", never "passed" |
| F-09 unhealthy resume | Completed check with `health:'Unhealthy'` | Failure reason retained |
| F-16/F-17 a11y | Keyboard-only shell test | Escape closes drawer; theme label follows OS flip |
| F-18 dial tone | Computed-style test | `.np-dial-center` fill equals the state tone |
| F-23/F-24 calibration | Render test with ≥30 samples | Header note contains the raw MAP posterior and sample count; 0-sample case makes no calibration claim |
| F-01 (if authorized) | Pin HEAD signature snapshot + N1.1 posterior fixture | Previously validated posterior values unchanged unless explicitly re-baselined |
| F-06 (if authorized) | Proxy-200/target-refused probe | `health != 'Healthy'`, `route != 'Direct'` |

## 3. Tests that must NOT be changed

- `apps/web/test/typeScale.test.ts` — verified unmodified; keep as the 12px floor guard.
- `test/vpnDecisionCards.test.tsx`, `test/nodeHealthDisplay.test.tsx`, `test/headingLevel.test.ts`, `test/errorStateRetry.test.tsx`, `test/cardStagger.test.ts` — DOM-shape coupled to shared primitives (`UI_REVIEW_07` §2); all passed after Will's primitive changes, which is evidence the changes preserved their contracts.
- `n1_rejects_the_old_ratio_analysis` — must keep disagreeing with the real engine.
- `k1/k2/k3` regression tests from N1.2 — no weakening observed; no assertion removed in any observed diff.

## 4. Verification of "no weakened tests"

`git diff` was reviewed for every changed test file (`hypothesisView.test.ts`, `naniEvents.test.ts`). Both diffs are **additive** (new cases added), with no deleted `expect`, no `.skip`, no broadened tolerance. The type-scale guard was not touched at all. No test result was manufactured.

## 5. Verdict

**PARTIAL.** One guard (type scale) demonstrably caught and now prevents its defect. Critical defects F-03/F-04/F-05/F-06/F-07/F-08/F-09 have **no** protecting test. The authoritative engine gate is flaky. Regression protection is therefore insufficient for acceptance.
