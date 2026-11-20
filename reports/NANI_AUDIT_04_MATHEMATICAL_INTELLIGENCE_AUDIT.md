# NANI_AUDIT_04 — Mathematical Intelligence Audit (Mission C)

## 1. Does the mathematics participate in actual diagnostic decisions?

**No — not in the investigation pathway.** The decision points:

| Decision | What actually decides | Mathematical core involved? |
|---|---|---|
| Investigation "hypotheses" | `run_analyze_stage` frequency counter (fail_ratio per layer) | ❌ zero references to the Bayesian engine in investigation.rs |
| Health-check posterior state | `math.observe_probe()` per measured layer (nani.rs:288) | ✅ posteriors move — but this is *state maintenance*, displayed via `nani_math_hypothesis_view`, not a diagnosis |
| Monitor-loop learning | LearningEngine observes monitor outcomes | ✅ reliability/drift — advisory |
| Recovery gating | `RecoveryPlanner` evidence-sufficiency refusals | partial |
| Probe selection display | `nani_math_select_probe` (EIG/cost) | ✅ correct math, display-only (auto loop does not use it — Phase-1 FABLE-RUST-001 stands) |

## 2. Mandatory protections (historical requirements) — verified in the current tree

| Protection | Status | Evidence |
|---|---|---|
| Time-scaled transition kernel | ✅ PRESENT | `diagnosis.rs:492 log_transition`, `:575–601` predict step scales transitions by elapsed time |
| Stable log-space semantics | ✅ | log_sum_exp/softmax with the `b0311fb` underflow fix; adversarial suite green |
| `-inf`/NaN behavior | ✅ | bayesian.rs:200–204 (−inf preserved, NaN→no-evidence) |
| Per-source/per-hypothesis dedupe | ✅ | bayesian.rs:190–198 (documented fix for the historical DNS bug) |
| Verified-only learning | ✅ | learning.rs:405 comment + verified flags (:708); `observe_verified_aggregate` only |
| Six-outcome Rust superset | ✅ | ProbeOutcome enum (Success/Failure/Missing/AuthRejected/RateLimited/ServerError) |
| **TS-only CVaR ported to Rust** | ❌ **NOT DONE** | `latencyCvar` still exists only in `packages/shared/src/nani/decision.ts:252`; no Rust equivalent found (`grep -i cvar src-tauri` empty) — parity-matrix EQ item still open |
| Cross-engine oracle tests | ❌ **DO NOT EXIST** | no fixture comparing Rust and TS outputs on identical inputs was found in either test suite (searched `oracle|parity|golden` in both) |

## 3. Concept separation (probe reliability / measurement quality / evidence strength / hypothesis probability / calibration / final confidence)

- Rust `Evidence.confidence` (measurement reliability) is used to temper likelihoods — conflated with evidence strength by the `ll × c` pseudo-likelihood (FABLE-MATH-001 stands).
- `nani_math_hypothesis_view` posterior and the investigation's frequency-ratio "confidence" are rendered as the same kind of number in adjacent UI surfaces — **the mission's concept separation is currently violated in presentation**.
- Calibration machinery (Brier/ECE, `evaluation.rs`) exists but is not continuously run on real outcomes (FABLE-MATH-002 stands) → posteriors are not calibrated probabilities in the strict sense and must not be presented as such (T-05's score/probability labeling rule remains the fix).

## 4. Small-sample / extreme-value robustness

- Wilson intervals, Beta credible widths, PROB_FLOOR, winsorized stats: present and tested (364+ tests green live this session: investigation 8, full-suite spot runs green).
- Small-sample behavior: minimum-samples guards in learning/recovery gating; explicit `insufficient` states.

## 5. Verdict

Mathematical core: **correct, well-tested, and only partially connected**. The highest-value fix is not more math — it is wiring the existing math into the investigation decision path (N1) and adding the CVaR port + cross-engine oracle fixture before any TS retirement.
