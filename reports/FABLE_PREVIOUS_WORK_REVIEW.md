# FABLE — Previous Work Review

Claims in prior reports were spot-checked against code and live runs this session. Overall verdict: **the prior AI work in this repository is unusually honest** — its self-reported limitations match reality, and its test counts reproduce. The failures are omissions and structural, not fabrication.

## 1. Claims verified TRUE

| Claim (source) | Verification |
|---|---|
| NANI test report (NANI_TEST_REPORT.md): 17 naniEvents tests, 26 API nani tests | Test files exist (`naniEvents.test.ts`, `test/nani*`), included in the 502/1264 green runs |
| NANI_PHASE_7_FINAL_REPORT: 340 network_intelligence tests at the time; robust_stats/wilson additions | Live: 529 Rust tests now (grew after that report, consistent); `robust_stats.rs` and `wilson_interval` present with the named tests |
| Phase 7 honesty: "Not run: the Windows desktop build/launch" | Consistent with the report's scope note; not contradicted by code |
| `b0311fb` "Fix softmax underflow that fails adversarial_softmax_extreme_log_probs" | Adversarial test suite exists in the Rust tests; suite green |
| Engine security claims (pinned digests, host allowlist) | `engineManager.ts` read end-to-end; unit tests in the 1,264 green |
| CONNECTION_BENCHMARKS.md discipline ("NOT MEASURED" markers, artifact paths) | Artifacts exist under `reports/accounting/`; numbers carry caveats from the runs |
| `naniApi.ts` "no mock path" | Verified true |

## 2. Claims that OVERSTATE (reclassify)

| Claim | Reality | Reclassify as |
|---|---|---|
| `naniApi.ts`: "web mode … the same capabilities are served by the API" | TS core is 2,419 LOC vs Rust 19,315; learning/bandit/drift/changepoint/hierarchical absent from TS | PARTIALLY IMPLEMENTED (web NANI is a subset) |
| Phase 7 "Unified information theory and probe selection engine" (information_theory.rs) | Selection/ranking exists and is exposed via `nani_math_select_probe`; the *automated* investigate loop does not use IG ordering or stopping (`should_stop`/VOI dead per compiler) | IMPLEMENTED BUT UNVERIFIED / disconnected |
| AETHER_INTEGRATION_REPORT / adaptive AI reports | Adaptive engine exists (`adaptiveEngine.ts`, bandit, approved-strategy flags in missionControl) but field value unproven; several adaptive modules have no production consumer | PARTIALLY IMPLEMENTED |
| NETPULSE_FINAL_GRADE / acceptance matrix | Grade-era artifacts predate the dual-NANI discovery and the dead Rust math; grades are stale | OBSOLETE (superseded by this review) |

## 3. Test-integrity check

- No tests were found weakened to make builds pass. Evidence: git history shows the opposite pattern — adversarial tests added and code fixed to satisfy them (`b0311fb`), CI gate added for lint/typecheck/test/rust/feed (`0805372`).
- Green-suite caveat honored: 1,766 TS tests + 529 Rust tests passing does NOT prove the *production wiring* of every subsystem — specifically, adaptive stopping (dead code), hierarchical pooling (shelf), and the dual-NANI duplication are all invisible to the suites because the suites test the components, not the assembly. This is the main epistemic gap of the prior phases.

## 4. Where prior work left the project

- Strong: VPN engine security, lifecycle honesty, sidecar supervision, IPC narrowness, NANI math primitives, event contracts, calibration machinery, adversarial numerics tests.
- Weak: engine-to-lifecycle integration (stopping/VOI), single-engine consolidation, dead surface pruning, test-suite speed, sibling-repo hygiene (Bot tests broken).

## 5. Report hygiene

- 23 NANI_* root reports + `reports/` tree (25 subdirs) — mostly accurate, some stale; propose an index file marking each as CURRENT/SUPERSEDED rather than deleting history.
