# FINAL_UI_RECOVERY_10_REMAINING_FINDINGS

## Final status of all 36 original findings

| ID | Status | Note |
|---|---|---|
| F-01 | **OPEN** | Authoritative likelihood table changed under freeze; authorization required |
| F-02 | **OPEN** | Self-derived “calibration” label; authorization required |
| F-03 | FIXED | Web health verdict is nullable |
| F-04 | FIXED | Previously verified TS2322 fix; re-verified by final typecheck |
| F-05 | FIXED | Connection console mounted; latent crash guarded |
| F-06 | **OPEN** | NANI-021 proxy contamination / direct-path claim remains |
| F-07 | FIXED | Poll cancellation + replay gap surfaced |
| F-08 | FIXED | Missing verification is “unavailable” |
| F-09 | FIXED | Unhealthy checks no longer mask older failures |
| F-10 | FIXED | 12px floor + type-scale guards |
| F-11 | **OPEN** | Evaluation/calibration changes require authorization |
| F-12 | **OPEN** | Backend DTO compatibility not addressed in this scope |
| F-13 | **OPEN** | Event flood / persistence error handling unchanged |
| F-14 | **OPEN** | K-1 command-surface change still working-tree-only |
| F-15 | FIXED | Rust fixtures/oracles deterministic; 552 pass |
| F-16 | **OPEN** | Theme toggle reactivity / system preference |
| F-17 | **OPEN** | Mobile drawer Escape/focus management |
| F-18 | **OPEN** | Dial centre tone specificity |
| F-19 | **OPEN** | Semantic token duplication |
| F-20 | **OPEN** | Event timestamp / envelope issue carried |
| F-21 | **OPEN** | NANI-011 unbounded DNS / registry lock carried |
| F-22 | **OPEN** | Serde masking / coarse TLS verdict carried |
| F-23 | **OPEN** | Raw vs calibrated confidence reconciliation |
| F-24 | **OPEN** | Calibration render-contract test gap |
| F-25 | CORRECTED | Spinner coverage fixed; claim qualified to NANI AiCore |
| F-26 | **OPEN** | Hard-coded version string |
| F-27 | FIXED | Settings tabs functional and URL-synced |
| F-28 | FIXED | Startup health uses canonical Tauri v2 resolver |
| F-29 | FIXED | WS socket no longer leaks after async ticket acquisition |
| F-30 | FIXED | Stop aborts in-flight explanation |
| F-31 | FIXED | Availability badge honest |
| F-32 | FIXED | Update-history transport failure propagates |
| F-33 | **OPEN** | Destructive adaptive actions without confirmation |
| F-34 | **OPEN** | Settings draft not re-synced after save |
| F-35 | CORRECTED | Four UI_MASTER reports received correction appendices |
| F-36 | FIXED | One Copilot empty-state prompt |

## Counts

| Status | Count |
|---|---:|
| Fixed | 18 |
| Corrected | 2 |
| Open / carried | 16 |
| Total | 36 |

## Blocking remaining work

1. **C3 authorization:** decide whether F-01/F-02/F-11 are accepted as N1.3 math work or separated from the UI change. Do not silently revert Will’s work.
2. **C4 network honesty:** add `.no_proxy()` and route consistency gating, and qualify any proxy-derived result before calling it healthy/direct.
3. **C6 data-backed visual pass:** run the API sidecar and recapture data states for settings, NANI, connection, and history screens.

## Non-blocking improvements

- Large frontend chunks remain (notably `LiveMapPage` at ~1.27 MB).
- Rust compiler emits many pre-existing unused-import/dead-code warnings.
- The default build cleanup remains blocked by the sandbox’s delete guard; use fresh output directories in this environment.

## Gate decision

The UI recovery scope is complete and green. The **full release gate remains NO-GO / BLOCKED** because C3, C4, and part of C6 are outside the authorized recovery and cannot be closed honestly in this pass.
