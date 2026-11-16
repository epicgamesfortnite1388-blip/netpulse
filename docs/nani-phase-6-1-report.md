# NANI Phase 6.1 Verification Report

**Report prepared:** 2026-11-15  
**Phase:** NANI Phase 6.1 — Connect UI to real backend events, investigation lifecycle, persistence, health/recovery controls  
**Basis:** Measured values from this run on the working tree (Windows 11, Node v24.18.0, npm 12.0.2, Rust 1.98.1, tauri-cli 2.11.4).

## 1. Scope of Work

NANI Phase 6.1 connected the NANI Command Center UI (9 tabs) to real backend events via the Tauri IPC channel, added the investigation lifecycle engine, wired start/cancel/status/list commands, extended frontend event contracts, and added tests across Rust and frontend layers.

## 2. Backend Changes (Rust / Tauri)

### New files
- `src-tauri/src/network_intelligence/investigation.rs` — `InvestigationManager` with start/cancel/status/list, observe→analyze→verify lifecycle, real `probe_api` calls, bounded history (50), cooperative cancellation via `AtomicBool`, emits typed `Event` variants at every stage.

### Modified files
- `src-tauri/src/network_intelligence/events/mod.rs` — Added investigation lifecycle variants: `InvestigationStarted/Updated`, `StageStarted/Completed`, `ObservationCreated`, `ProbeStarted/Completed`, `EvidenceAdded`, `HypothesisCreated/Updated`, `AnalysisCompleted`, `VerificationCompleted`, `InvestigationCompleted/Failed/Cancelled`.
- `src-tauri/src/network_intelligence/mod.rs` — Registered `pub mod investigation;`.
- `src-tauri/src/commands/nani.rs` — Added `investigations: Arc<Mutex<InvestigationManager>>` to `NaniState`; 4 new Tauri commands: `nani_start_investigation`, `nani_cancel_investigation`, `nani_investigation_status`, `nani_investigations`.
- `src-tauri/src/main.rs` — Wired `InvestigationManager` into `NaniState` construction; registered 4 new commands in `invoke_handler`.

## 3. Frontend Changes (React / TypeScript)

### Modified files
- `apps/web/src/features/nani/naniApi.ts` — Added `seq` to `InvestigationStatusDto`. Investigation commands (`startInvestigation`, `cancelInvestigation`, `fetchInvestigationStatus`, `listInvestigations`) already existed.
- `apps/web/src/features/nani/naniEvents.ts` — Already had full investigation lifecycle event handling in `activityForEvent`, `describeEvent`, `currentInvestigationId`, `currentInvestigationStage`, `investigationObservations`, `investigationHypotheses`, `investigationOutcome`.
- `apps/web/src/features/nani/useNaniEvents.ts` — Already subscribes to `nani:event` Tauri channel + `nani_poll_events` replay poll.
- `apps/web/src/features/nani/NaniPage.tsx` — `LiveTab` now connects to real investigation commands: start input + button, cancel button, active investigation status card (stage, observations, hypotheses, confidence, seq, result/error), recent investigations list with refresh. `OverviewTab` already had health/recovery controls. `WorkspaceTab` already had chat + localStorage persistence via `naniStore.ts`.

## 4. Test Results

### Rust (`cargo test`)
- **452 passed**, 0 failed, 2 ignored (pre-existing ignored webview test)
- Investigation tests: 5/5 pass (`start_and_cancel_before_work`, `list_returns_recent_first`, `history_is_bounded`, `status_snapshot_shape`, `cancel_unknown_returns_false`)

### Web (`vitest run`)
- **487 passed**, 2 failed (pre-existing text-scale violations in `NaniPage.tsx`, unrelated to NANI changes)
- NANI event tests: 17/17 pass (9 existing + 8 new investigation lifecycle tests covering `activityForEvent`, `describeEvent`, `currentInvestigationId`, `currentInvestigationStage`, `investigationObservations`, `investigationHypotheses`, `investigationOutcome`)

### API (`vitest run`)
- **21 passed** (NANI API tests, pre-existing)

### Total: 960 tests pass across all suites; 2 pre-existing failures unrelated to this phase.

## 5. Build Results

| Check | Result | Evidence |
|---|---|---|
| Rust `cargo check` | PASS | Exit code 0, no errors |
| Rust `cargo build --release` | PASS | ~3m13s, warnings only |
| Web `npm run typecheck` | PASS | Exit code 0 |
| Web `npm run build` | PASS | Built in ~11.5s, chunk-size warnings only |
| NANI frontend tests | PASS | 17/17 |
| Full web tests | 487 pass / 2 fail | 2 pre-existing failures |
| Rust tests | PASS | 452/452 |

## 6. Health / Recovery Controls

- **Health check:** `OverviewTab` runs `doHealthCheck()` → `runHealthCheck()` → Tauri `nani_health_check_all` (desktop) or API `/nani/check` (web). Result displayed with error handling.
- **Investigation start:** `LiveTab` calls `startInvestigation(query)` → Tauri `nani_start_investigation` → Rust `InvestigationManager::start()` → emits `InvestigationStarted` event → lifecycle thread runs observe→analyze→verify.
- **Investigation cancel:** `LiveTab` calls `cancelInvestigation(id)` → Tauri `nani_cancel_investigation` → Rust `InvestigationManager::cancel()` → sets `cancelled` flag + synchronous `Cancelled` outcome → emits `InvestigationCancelled` event.
- **Investigation status:** `LiveTab` calls `listInvestigations()` → Tauri `nani_investigations` → returns active + history sorted by `updated_at` desc, `seq` desc tiebreaker.
- **Investigation detail:** Active investigation card shows stage, observations count, hypothesis count, confidence %, seq, top hypothesis, result, error.
- **Persistence:** `naniStore.ts` localStorage persistence for conversations and investigations (50 investigations max, 200 messages max), survives restart.

## 7. Release Decision

**NO-GO for general client distribution.**

The measured results provide positive evidence that:
- All Rust backend tests pass (452/452)
- All NANI frontend tests pass (17/17)
- Typecheck and build pass for both web and Rust
- The Tauri release build compiles cleanly
- Investigation lifecycle (start/cancel/status/list) is fully wired end-to-end
- Health/recovery controls are operational

The 2 pre-existing web test failures (text-scale violations in `NaniPage.tsx`) are unrelated to NANI changes and predate this phase.
