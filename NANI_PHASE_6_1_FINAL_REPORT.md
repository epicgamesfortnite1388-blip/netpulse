# NANI Phase 6.1 — Final Report

## Implemented (verified in code)
- **Live event layer**: `useNaniEvents` subscribes to Tauri `nani:event` + 5 s replay poll; `naniEvents.ts` normalizes both sources, dedupes by `eventId`, detects sequence gaps, keeps bounded buffers, maps real events to activity states.
- **Typed API**: `naniApi.ts` prefers Tauri commands (`nani_status`, `nani_health_check_all`, `nani_explain`, `nani_learning_status`, `nani_learning_drift`, `nani_poll_events`) and falls back to `/nani/*` HTTP.
- **Truthful activity**: Overview AI core and Live pipeline derive from real events. Synthetic timer removed.
- **Persistence**: `naniStore.ts` (localStorage, bounded) stores conversations and investigations across restarts; delete + clear with confirmation.
- **Chat**: Workspace uses real `nani_explain` (desktop) / `/nani/diagnose` (web); shows `source` and `warning`; errors surface.
- **Learning**: Learning tab reads real `nani_learning_status` / `nani_learning_drift` (desktop).
- **Hypotheses/Evidence**: Derived from real diagnosis/failure/health events only; honest empty states otherwise.
- **Health check**: Real desktop/API call wired to a button.

## Tested (executed)
- `npx vitest run src/features/nani` → 17/17 passed.
- `cd apps/api && npx vitest run test/nani` → 26/26 passed (5 new recovery tests).
- `npx tsc --noEmit` → exit 0.
- `npx vite build` → exit 0.

## Implemented: interactive recovery controls
- New **Recovery** tab (`RecoveryControls.tsx`) wired to real endpoints: register API, plan recovery, next step, record step outcome, reset runtime.
- Explicit confirmation required before any state-changing step; unauthorized routes are refused by the engine.
- Fixed `NaniService.registerApi` (registered providers were invisible to `listApis`).
- Verified in the desktop app: plan `ready` with probe/activate/verify steps, confirmation gate shown, cancelled without mutating state.

## Partially implemented
- (none for recovery)
- Web-mode live events (unavailable by transport; reported honestly).
- Investigation lifecycle events (backend lacks explicit session variants; no fabrication).

## Verified manually (desktop)
- Built `netpulse-desktop.exe` (`tauri build --debug --no-bundle`, exit 0).
- Launched the app and inspected all nine NANI sections over the WebView2 DevTools protocol.
- Live Investigation displayed real Rust events with sequence numbers.
- Chat returned a real deterministic explanation; the conversation survived a full reload.
- Learning showed real `nani_learning_status` data (100 accepted, 4 drift events).
- Narrow (900px) layout collapses the sidebar and stacks cards.
- Screenshots: `reports/nani-screens/`.

## Rust crate tests (executed)
- `cargo test network_intelligence::events` → 10/10 passed (ordering, reconnect dedupe, session ownership, system events, eviction gap + scoped eviction).
- `cargo test network_intelligence::investigation` → 7/7 passed (cross-session cancellation isolation, event ownership).
- Full `cargo test network_intelligence::` → 342 passed; 0 failed (the earlier softmax adversarial failure was fixed at source during Phase 7).
- Added `Event::investigation_id()`, `EventBus::replay_since()`, `EventBus::replay_session()`; replay stores `(seq, Event)`.

## Blocked / not attempted
- Backend E2E, full component render tests.
- Performance profiling numbers.

## Release blockers
1. Release-profile build (`tauri build`) and NSIS install should be produced/verified (debug build verified only).
2. Recovery controls should be added with explicit confirmation.
3. Backend/integration test matrix remains incomplete.

## Files changed
- `apps/web/src/features/nani/naniEvents.ts` (new)
- `apps/web/src/features/nani/naniApi.ts` (new)
- `apps/web/src/features/nani/naniStore.ts` (new)
- `apps/web/src/features/nani/useNaniEvents.ts` (new)
- `apps/web/src/features/nani/naniEvents.test.ts` (new)
- `apps/web/src/features/nani/NaniPage.tsx` (rewritten to real data/events)
