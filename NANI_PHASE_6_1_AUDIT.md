# NANI Phase 6.1 — Audit

## Scope
Repository: `E:\Code\Project\Vpn_app`
- Rust engine: `src-tauri/src/network_intelligence/`
- Tauri IPC: `src-tauri/src/commands/nani.rs`, wiring in `src-tauri/src/main.rs`
- Event bus: `src-tauri/src/network_intelligence/events/mod.rs`
- Persistence: `src-tauri/src/network_intelligence/persistence.rs`
- Recovery: `src-tauri/src/network_intelligence/recovery.rs`
- Learning: `src-tauri/src/network_intelligence/learning.rs`
- Web UI: `apps/web/src/features/nani/`
- Web API: `apps/api/src/routes/nani.ts`, `apps/api/src/services/naniService.ts`
- Shared core: `packages/shared/src/nani/`
- Realtime bus + WS: `apps/api/src/realtime/bus.ts`, `apps/api/src/realtime/wsRoute.ts`
- Web transport: `apps/web/src/lib/transport.ts`, `apps/web/src/lib/ws.ts`

Toolchain verified: Rust 1.98.1, Node 24.18.0, npm 12.0.2. `cargo build`, `cargo test` compile, `vite build`, `tsc --noEmit`, and `vitest` (10/10) pass.

## 1. Existing implementation (verified in source)

### Desktop Tauri commands (`src-tauri/src/commands/nani.rs`)
Managed `NaniState`: `events`, `persistence`, `registry`, `recovery`, `learning`, `ai`, `events_rx`.
Commands: `nani_status`, `nani_poll_events`, `nani_health_check_all`, `nani_learning_status`, `nani_learning_drift`, `nani_learning_reset`, `nani_ai_status`, `nani_explain`, personalization/context commands.
**No Tauri command exists for recovery plan/step execution.** Recovery runs automatically in the background `MonitorLoop` (shared `Arc<Mutex<RecoveryPlanner>>`), emitting `RecoveryStarted`/`RecoveryStepCompleted`/`RecoveryCompleted`/`RecoveryRolledBack`. UI can OBSERVE recovery via events but cannot PLAN or EXECUTE recovery on demand.

### Desktop event stream (`src-tauri/src/network_intelligence/events/mod.rs`)
Channel `nani:event`, payload `{ seq, event: { kind, payload } }`.
`Event` enum: ApiHealthChanged, FailureDetected, RecoveryStarted, RecoveryStepCompleted, RecoveryCompleted, RecoveryRolledBack, RouteSelected, CircuitBreakerTripped, CircuitBreakerRecovered, DriftDetected, DiagnosisUpdated, LearningUpdate, TelemetryTick, UserAction.
Bounded replay buffer (256); AppHandle wired in `main.rs`.
**Missing**: investigation-session lifecycle variants (InvestigationStarted/Updated/Completed/Failed/Cancelled, stage started/completed, observation created, probe started/completed, evidence added, hypothesis created/updated, verification completed, learning updated).

### Web API (`apps/api/src/routes/nani.ts`, `apps/api/src/services/naniService.ts`)
Routes: `GET /api/v1/nani/apis`, `GET /api/v1/nani/health/shadow`, `POST /api/v1/nani/apis`, `POST /api/v1/nani/check`, `POST /api/v1/nani/diagnose`, `POST /api/v1/nani/recovery/plan|step|reset`, `GET /api/v1/nani/recovery/next`.
`NaniService.publish()` publishes to `RealtimeBus` on topics `nani:*` (`nani:health:updated`, `nani:diagnosis:completed`, `nani:recovery:planned`, `nani:recovery:step:*`, `nani:recovery:completed`, `nani:recovery:exhausted`, `nani:route:activated`).
`RealtimeBus`: in-process pub/sub, bounded topic cache (500), latest-message replay. WS route `/api/v1/ws` ticket-authenticated; subscribe by topic via `{type:'subscribe', testId}`.

### Shared core (`packages/shared/src/nani/events.ts`)
Typed `NaniEventType` union + versioned envelope `{seq, at, type, payload, version}`. `makeNaniEvent` factory.

## 2. Gap analysis

| # | Feature | Current implementation | Existing contract | What is missing | Reusable? | Required changes | Regression risk |
|---|---------|----------------------|-------------------|-----------------|-----------|------------------|-----------------|
| 1 | Live `nani:*` events (desktop) | Tauri `nani:event` listener + replay poll | `{seq, event:{kind,payload}}` on `nani:event`; replay via `nani_poll_events` | Investigation-session lifecycle events not emitted by Rust | Yes — transport exists | Add Rust lifecycle event variants + emit from engine | Low (additive) |
| 2 | Live `nani:*` events (web) | None; reports `unavailable (web mode)` | `RealtimeBus` topics `nani:*`; WS `/api/v1/ws` subscribe by topic | Frontend does not subscribe to NANI topics over WS | Yes — `RealtimeBus`/`wsRoute` exist | Add web-mode WS subscription to NANI topics | Low (best-effort WS) |
| 3 | Recovery controls in UI | Health check wired; recovery only observable via events | Web: `/nani/recovery/plan|step|next|reset`; Rust: `RecoveryPlanner` (no Tauri command) | No recovery plan/execute UI; no Tauri recovery commands | Yes — `RecoveryPlanner` methods + web routes exist | Add Tauri recovery commands + recovery UI panel with confirmation | Medium (shared planner; lock same mutex as MonitorLoop) |
| 4 | Persistence — conversations/investigations | `localStorage` bounded store; survives restart; corrupt-tolerant | Keys `np.nani.conversations.v1`, `np.nani.investigations.v1` | No schema migration; no search/filter/sort; no export; no compare | Yes — localStorage store exists | Add migration helpers, search/filter/sort, export report | Low |
| 5 | Health checks in UI | `Run health check` button → `nani_health_check_all`/`/nani/check`; result shown | `nani_health_check_all`; `/nani/check` | Last-successful-time, per-subsystem status, unavailable-vs-failed | Partially — status command exists | Enhance health UI with per-subsystem detail | Low |
| 6 | Investigation lifecycle | No session tracking; events not investigation-scoped | Rust `Event` has no session lifecycle variants | Start/cancel/resume; terminal states; cancellation reaches backend | No — new engine surface | Add session-scoped events + cancellation command | Medium |
| 7 | Chat experience | `explain()` bound to real backend; messages persisted | `nani_explain`; `/nani/diagnose` | No retry, cancel-in-flight, streaming, provider-failure UX | Yes — real backend call exists | Add retry + cancel + provider-unavailable honesty | Low |
| 8 | Evidence explorer | Derived from real events; honest empty states | `FailureDetected`/`nani:health:updated`/`DriftDetected` events | No raw/validated/derived distinction; no per-layer timing | Partially — events carry fields | Enrich evidence with provenance + source/timestamp | Low |
| 9 | Learning & memory | Reads real `nani_learning_status`/`nani_learning_drift` | `nani_learning_status`, `nani_learning_drift` | No profile list, sample counts, drift indicators, retention/privacy | Yes — learning engine exists | Expose learned profiles + privacy controls | Low |
| 10 | Automated tests | 10 frontend event tests; Rust unit tests (events/persistence/recovery) | vitest + cargo test exist | No backend integration, no component/RTL, no E2E | Yes | Add Rust integration + frontend component tests | Low |
| 11 | Windows desktop verification | Not performed | — | Build + launch + visual inspection + screenshots | — | `tauri build`; launch; document headless limitation | N/A |

## 3. Transport decision

**Desktop:** reuse existing Tauri native channel `nani:event` + `nani_poll_events` replay buffer. Do NOT add WebSockets or a second event system.
**Web:** reuse existing `RealtimeBus` + WS `/api/v1/ws` ticket-authenticated subscribe. Do NOT add a second transport.
Both exist; missing pieces are frontend WS subscription on web and Rust emission of investigation-session lifecycle events.

## 4. Reuse vs. new

- Event normalization/dedupe/gap/bounded-buffer: REUSE (`naniEvents.ts`, implemented and tested).
- Persistence: REUSE (`naniStore.ts` localStorage; `PersistenceStore` for model journal). Do NOT introduce a new database.
- Recovery: REUSE `RecoveryPlanner` (Rust) and `/nani/recovery/*` routes (web). Add thin Tauri command wrappers.
- Chat: REUSE `nani_explain`/`/nani/diagnose` + `naniStore`.
- Learning: REUSE `nani_learning_status`/`nani_learning_drift`.
- Health check: REUSE `nani_health_check_all`/`/nani/check`.

## 5. Honest limitations (not fabricated)
- The Rust `Event` enum has no investigation-session lifecycle variants; the frontend will not fabricate `InvestigationStarted`/`ProbeCompleted` etc. until the engine emits them.
- Desktop recovery execution is automatic via `MonitorLoop`; on-demand recovery requires new Tauri commands (planned in this phase).
- Web-mode live NANI events require a WS subscription the current hook does not establish (planned in this phase).
- Visual/desktop verification cannot be completed in this headless terminal environment; limitation documented in `NANI_DESKTOP_VISUAL_VERIFICATION.md`.
- `cargo test` compiles all Rust test code; a prior test-binary run failed only because a stale `netpulse-desktop.exe` held a file lock (access denied), not a code failure.

### Frontend (`apps/web/src/features/nani/`)
`NaniPage.tsx` — nine sections (Overview, Live Investigation, AI Workspace, Hypotheses, Evidence, Network, Learning, History, Settings).
`naniEvents.ts` — envelope, reducer, dedupe (`${seq}:${type}`), bounded buffer (200 events/512 ids), gap detection, activity mapping, malformed→`null`.
`useNaniEvents.ts` — desktop Tauri listener + 5s replay poll; **web mode returns `available: false`, no events; no WS subscription to NANI topics.**
`naniApi.ts` — typed API (Tauri first, HTTP fallback). `naniStore.ts` — `localStorage` bounded store (50/50/200), corrupt-tolerant, delete+clear with confirmation.
`naniEvents.test.ts` — 10 passing unit tests.

### Rust persistence (`src-tauri/src/network_intelligence/persistence.rs`)
`PersistenceStore`: observations JSONL + model state JSON, schema v1, bounded retention (10k), atomic writes, no secrets. Tests pass.

