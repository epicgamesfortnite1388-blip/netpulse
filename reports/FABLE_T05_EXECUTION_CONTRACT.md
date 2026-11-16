# FABLE — T-05 Execution Contract: Continuous Calibration (verified-only, Rust-sourced)

## 1. Current behavior

- Rust `evaluation.rs` implements Brier/log-loss/ECE/reliability bins — exercised in tests and (per Phase-1 evidence) in simulation/bench runs only.
- No production path computes or persists calibration from **real** investigations; `nani_math_*` commands expose drift/changepoint/entropy but no rolling calibration command.
- TS `metrics.ts` has the same math for web mode.

## 2. Problem & root cause

FABLE-MATH-002: posterior numbers reach the UI without continuous, real-run calibration evidence. Root cause: Phase-7 built the machinery, never wired a production ingest.

## 3. Target behavior

Every completed desktop investigation with a verified verify-stage outcome appends one calibration sample; a rolling aggregator (window ≈200) persists via `persistence.rs`; a new Tauri command `nani_math_calibration` returns `{brier, ece, n, window, updated_at}`; NaniPage displays "calibration" and labels posteriors as **scores** until `n ≥ 100 && ece < 0.10`.

## 4. Exact source files & symbols

| File | Symbols |
|---|---|
| `src-tauri/src/network_intelligence/evaluation.rs` | existing Brier/ECE fns → add `CalibrationWindow { push(correct: bool, confidence: f64), summarize() }` (pure, unit-testable) |
| `src-tauri/src/network_intelligence/investigation.rs` | at COMPLETE/FAIL (verify stage result known): emit sample; skip + count `skipped_no_verified_outcome` |
| `src-tauri/src/network_intelligence/persistence.rs` | new record type + load/save (JSON file alongside existing store; version field for future migrations) |
| `src-tauri/src/commands/nani.rs` | `#[tauri::command] pub fn nani_math_calibration(state) -> CalibrationDto` |
| `apps/web/src/features/nani/naniApi.ts` | DTO + fetch in desktop mode |
| `apps/web/src/features/nani/NaniPage.tsx` | calibration line + score/probability label rule |
| `packages/shared` | DTO type only (single-writer rule: coordinate with T-06, run T-05 first) |

## 5. Call paths

`investigation run_lifecycle → verify stage → close episode → NEW: calibration.push(map_confidence, outcome_correct) → persistence.save` and `NaniPage → nani_math_calibration → CalibrationWindow.summarize()`.

## 6. API/event changes

- New Tauri command (additive — Rule O-5 allows additions).
- Optional: one event field `calibration_updated` on the learning event — **omit in v1** (events stay stable; UI polls with status).

## 7. Persistence changes

New rolling record file (e.g. `nani-calibration.json`, versioned). **No** existing record format changes. Corruption handling: malformed file → start empty + log warn (never crash; consistent with the store's existing defensive style — verify actual behavior at Gate A).

## 8. Migration strategy

None needed (new record). If a future schema change happens, the `version` field gates a forward-only migration.

## 9. Mathematical parity requirements

Rust is the sole compute owner (parity matrix §3). TS displays numbers only. The T-04 noise model (mixture likelihood) must land BEFORE meaningful calibration is quoted, or calibration will measure the heuristic — sequence: T-04 → T-05.

## 10–12. Tests

- **Unit** (Rust): `CalibrationWindow` math vs the existing Brier/ECE functions on a fixture (self-consistency); window rollover; confidence bounds.
- **Integration** (Rust): investigation lifecycle test — COMPLETE with verified outcome appends exactly one sample; CANCELLED appends zero; missing verify outcome counts as skipped.
- **Integration** (web): `nani_math_calibration` returns persisted values; NaniPage renders label rule for n<100.
- **Regression**: full Rust suite; web nani feature tests.

## 13. Performance expectations

O(1) push, O(window) summarize on command; no measurable UI impact. No new timers.

## 14. Rollback

Revert removes the command + record writes; leftover JSON record is inert. No user-visible contract loss (feature was absent before).

## 15. Objective acceptance criteria

1. After ≥1 real investigation with verified outcome, `nani_math_calibration` returns n≥1 with sane Brier/ECE.
2. Cancelled/unverified investigations never add samples (test-proven).
3. UI shows "score" wording until thresholds; switches at threshold (unit-tested rule).
4. All suites green; Gate F evidence attached.

## Gate notes

- **Gate A**: confirm `investigation.rs` verify-stage outcome plumbing (episode `verified` flag at :708 region) — read the CURRENT working-tree file (in-flight churn).
- **Gate B approval**: the `n ≥ 100 && ece < 0.10` threshold rule and window=200 need Fable sign-off (it changes what the UI claims).
- **Gate D (Gemini)**: verify no TS math computes displayed numbers (O-2); verify sample semantics ("MAP posterior vs verified outcome" definition matches the contract, not the implementation's convenience).
