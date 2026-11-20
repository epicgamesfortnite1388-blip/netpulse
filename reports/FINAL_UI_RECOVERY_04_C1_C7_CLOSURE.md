# FINAL_UI_RECOVERY_04_C1_C7_CLOSURE

## Closure table

| Condition | Requirement | Status | Evidence |
|---|---|---|---|
| **C1** | F-03 web health verdict nullable; no “healthy” from attempt counts | **CLOSED** | `NaniPage.tsx` returns `healthy: null` for the web path; the 14-test recovery suite now includes two behavioral F-03 tests proving attempt counts never become a verdict |
| **C2** | F-05 connection console mounted; F-27 settings tabs functional; F-28 Tauri v2 invoke fixed | **CLOSED** | Dashboard mounts `ConnectionHero`; tabs wired through `onValueChange`; `useStartupHealth` uses `tauriInvoke()` |
| **C3** | F-01/F-02/F-11 authorize, separate, review, or revert | **NOT CLOSED** | Explicitly out of authorized scope; engine math and calibration semantics untouched in this recovery pass |
| **C4** | F-06/NANI-021 proxy contamination made honest | **NOT CLOSED** | No `.no_proxy()` added; no TCP/HTTP route consistency gate; limitation remains documented as HIGH/OPEN |
| **C5** | F-07, F-08, F-09, F-29, F-30, F-31, F-32 event/Copilot honesty | **CLOSED** | Source fixes plus regression coverage in `recoveryRegressions.test.ts`; full web suite green |
| **C6** | F-35 corrections; deterministic N1.1 oracle; data-backed visual pass with API sidecar | **PARTIAL** | F-35 correction appendices written; Rust oracle/fixtures deterministic and green; **data-backed visual pass blocked — no API sidecar was run** |
| **C7** | Regression tests including F-27/F-28/F-30/F-32 | **CLOSED** | 14 new recovery regressions; 523/523 web tests; 47/47 UI contract; 552/552 non-ignored Rust tests |

## Why C3 and C4 remain open

C3 and C4 are not defects that can be responsibly closed by a UI recovery pass:

- C3 changes authoritative Bayesian likelihoods, calibration semantics, and evaluation bars. The original review explicitly forbade silent math changes. No authorization was granted in this mission.
- C4 requires probe-transport changes (`no_proxy`, route consistency, event qualifiers). The environment still has HTTP(S)_PROXY set to `127.0.0.1:62416`; without a transport change, a proxy-derived result cannot honestly be called a direct measurement.

## Why C6 is only partial

The screenshots in `reports/FINAL_UI_visual_recovery/v2-*.png` prove layout, theme, reachability, no horizontal overflow, and the Copilot/Dashboard fixes. They do **not** prove data-backed states because no API sidecar was started. Settings honestly remains in `Loading settings...` in those captures.

## Resulting gate decision

- **UI recovery scope:** PASS.
- **Full release gate:** **NO-GO / BLOCKED** until C3, C4, and the data-backed portion of C6 are resolved.
